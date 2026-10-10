import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  type MemoryEntry,
  type MemoryHit,
  type MemoryStore,
  type RecordFilter,
  type RecordKind,
  type RecordMap,
  type RecordStore,
  recordSchemas,
  SCHEMA_VERSION,
  type Storage,
} from '@sidebet/core'

/** Bump when the SQLite layout changes. Records carry their own schemaVersion separately. */
export const DB_LAYOUT_VERSION = 1

const MIGRATIONS: string[] = [
  `CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS records (
     seq INTEGER PRIMARY KEY AUTOINCREMENT,
     kind TEXT NOT NULL,
     id TEXT NOT NULL,
     project_id TEXT,
     run_id TEXT,
     attempt_id TEXT,
     json TEXT NOT NULL,
     UNIQUE (kind, id)
   );
   CREATE INDEX IF NOT EXISTS records_run ON records (kind, run_id);
   CREATE INDEX IF NOT EXISTS records_attempt ON records (kind, attempt_id);
   CREATE INDEX IF NOT EXISTS records_project ON records (kind, project_id);
   CREATE TABLE IF NOT EXISTS memory (
     seq INTEGER PRIMARY KEY AUTOINCREMENT,
     id TEXT NOT NULL UNIQUE,
     scope TEXT NOT NULL,
     project_id TEXT,
     text TEXT NOT NULL,
     tags TEXT NOT NULL,
     source TEXT NOT NULL,
     schema_version INTEGER NOT NULL,
     created_at TEXT NOT NULL
   );
   CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
     text, tags, content='memory', content_rowid='seq', tokenize='porter unicode61'
   );
   CREATE TRIGGER IF NOT EXISTS memory_ai AFTER INSERT ON memory BEGIN
     INSERT INTO memory_fts(rowid, text, tags) VALUES (new.seq, new.text, new.tags);
   END;
   CREATE TRIGGER IF NOT EXISTS memory_ad AFTER DELETE ON memory BEGIN
     INSERT INTO memory_fts(memory_fts, rowid, text, tags) VALUES ('delete', old.seq, old.text, old.tags);
   END;`,
]

type Row = Record<string, unknown>

const migrate = (db: DatabaseSync): void => {
  db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
  const row = db.prepare("SELECT value FROM meta WHERE key = 'layout_version'").get() as
    | Row
    | undefined
  const current = row ? Number(row.value) : 0
  if (current > DB_LAYOUT_VERSION) {
    throw new Error(
      `Sidebet database layout v${current} is newer than this build supports (v${DB_LAYOUT_VERSION}). Upgrade Sidebet.`,
    )
  }
  for (let v = current; v < MIGRATIONS.length; v++) db.exec(MIGRATIONS[v] as string)
  db.prepare(
    "INSERT INTO meta (key, value) VALUES ('layout_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(String(DB_LAYOUT_VERSION))
}

const likePrefix = (s: string): string => `${s.replace(/[\\%_]/g, '\\$&')}%`

/** Turn free text into a safe FTS5 OR-query of prefix terms. */
export const toFtsQuery = (text: string): string | undefined => {
  const terms = [...new Set(text.toLowerCase().match(/[a-z0-9_]+/g) ?? [])]
  return terms.length === 0 ? undefined : terms.map((t) => `"${t}"*`).join(' OR ')
}

const createRecordStore = (db: DatabaseSync): RecordStore => {
  const upsert = db.prepare(
    `INSERT INTO records (kind, id, project_id, run_id, attempt_id, json) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(kind, id) DO UPDATE SET json = excluded.json,
       project_id = excluded.project_id, run_id = excluded.run_id, attempt_id = excluded.attempt_id`,
  )
  const getStmt = db.prepare('SELECT json FROM records WHERE kind = ? AND id = ?')
  return {
    put(kind, record) {
      const parsed = recordSchemas[kind].parse(record) as RecordMap[typeof kind] & {
        id: string
        projectId?: string
        runId?: string
        attemptId?: string
      }
      upsert.run(
        kind,
        parsed.id,
        parsed.projectId ?? null,
        parsed.runId ?? (kind === 'run' ? parsed.id : null),
        parsed.attemptId ?? (kind === 'attempt' ? parsed.id : null),
        JSON.stringify(parsed),
      )
    },
    get(kind, id) {
      const row = getStmt.get(kind, id) as Row | undefined
      return row
        ? (recordSchemas[kind].parse(JSON.parse(String(row.json))) as RecordMap[typeof kind])
        : undefined
    },
    list(kind, filter: RecordFilter = {}) {
      const where = ['kind = ?']
      const params: Array<string | number> = [kind]
      if (filter.projectId !== undefined) {
        where.push('project_id = ?')
        params.push(filter.projectId)
      }
      if (filter.runId !== undefined) {
        where.push('run_id = ?')
        params.push(filter.runId)
      }
      if (filter.attemptId !== undefined) {
        where.push('attempt_id = ?')
        params.push(filter.attemptId)
      }
      let sql = `SELECT json FROM records WHERE ${where.join(' AND ')} ORDER BY seq ${filter.order === 'desc' ? 'DESC' : 'ASC'}`
      if (filter.limit !== undefined) {
        sql += ' LIMIT ?'
        params.push(filter.limit)
      }
      return (db.prepare(sql).all(...params) as Row[]).map(
        (r) => recordSchemas[kind].parse(JSON.parse(String(r.json))) as RecordMap[typeof kind],
      )
    },
    resolveId(kind: RecordKind, idOrPrefix) {
      const exact = getStmt.get(kind, idOrPrefix) as Row | undefined
      if (exact) return idOrPrefix
      const rows = db
        .prepare("SELECT id FROM records WHERE kind = ? AND id LIKE ? ESCAPE '\\' LIMIT 3")
        .all(kind, likePrefix(idOrPrefix)) as Row[]
      if (rows.length > 1)
        throw new Error(
          `Ambiguous id prefix "${idOrPrefix}": ${rows.map((r) => String(r.id)).join(', ')}`,
        )
      return rows[0] ? String(rows[0].id) : undefined
    },
  }
}

const rowToEntry = (r: Row): MemoryEntry => ({
  id: String(r.id),
  schemaVersion: Number(r.schema_version ?? SCHEMA_VERSION),
  scope: r.scope as MemoryEntry['scope'],
  projectId: r.project_id ? String(r.project_id) : undefined,
  text: String(r.text),
  tags: JSON.parse(String(r.tags)) as string[],
  source: r.source as MemoryEntry['source'],
  createdAt: String(r.created_at),
})

const createMemoryStore = (db: DatabaseSync): MemoryStore => ({
  add(entry) {
    db.prepare(
      'INSERT INTO memory (id, scope, project_id, text, tags, source, schema_version, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(
      entry.id,
      entry.scope,
      entry.projectId ?? null,
      entry.text,
      JSON.stringify(entry.tags),
      entry.source,
      entry.schemaVersion,
      entry.createdAt,
    )
  },
  get(id) {
    const r = db.prepare('SELECT * FROM memory WHERE id = ?').get(id) as Row | undefined
    return r ? rowToEntry(r) : undefined
  },
  list({ projectId, scope }) {
    const where: string[] = []
    const params: string[] = []
    if (scope === 'global') where.push("scope = 'global'")
    else if (scope === 'project') {
      where.push("scope = 'project' AND project_id = ?")
      params.push(projectId ?? '')
    } else {
      where.push("(scope = 'global' OR project_id = ?)")
      params.push(projectId ?? '')
    }
    return (
      db
        .prepare(`SELECT * FROM memory WHERE ${where.join(' AND ')} ORDER BY seq`)
        .all(...params) as Row[]
    ).map(rowToEntry)
  },
  search(query, { projectId, limit }) {
    const fts = toFtsQuery(query)
    if (!fts) return []
    const rows = db
      .prepare(
        `SELECT memory.*, bm25(memory_fts) AS rank FROM memory_fts
         JOIN memory ON memory.seq = memory_fts.rowid
         WHERE memory_fts MATCH ? AND (memory.scope = 'global' OR memory.project_id = ?)
         ORDER BY rank LIMIT ?`,
      )
      .all(fts, projectId ?? '', limit ?? 20) as Row[]
    return rows.map((r): MemoryHit => ({ entry: rowToEntry(r), rank: Number(r.rank) }))
  },
  remove(id) {
    return Number(db.prepare('DELETE FROM memory WHERE id = ?').run(id).changes) > 0
  },
  resolveId(prefix) {
    const exact = db.prepare('SELECT id FROM memory WHERE id = ?').get(prefix) as Row | undefined
    if (exact) return prefix
    const rows = db
      .prepare("SELECT id FROM memory WHERE id LIKE ? ESCAPE '\\' LIMIT 3")
      .all(likePrefix(prefix)) as Row[]
    if (rows.length > 1) throw new Error(`Ambiguous memory id prefix "${prefix}"`)
    return rows[0] ? String(rows[0].id) : undefined
  },
})

export interface OpenOptions {
  /** Use ':memory:' for tests. */
  path: string
}

export const openStorage = ({ path }: OpenOptions): Storage => {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
  const db = new DatabaseSync(path)
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA synchronous = NORMAL;')
  migrate(db)
  return { records: createRecordStore(db), memory: createMemoryStore(db), close: () => db.close() }
}

export interface StorageHealth {
  path: string
  layoutVersion: number
  fts5: boolean
  runs: number
  memories: number
}

export const inspectStorage = (path: string): StorageHealth => {
  const db = new DatabaseSync(path)
  try {
    const v = db.prepare("SELECT value FROM meta WHERE key = 'layout_version'").get() as
      | Row
      | undefined
    let fts5 = true
    try {
      db.exec('CREATE VIRTUAL TABLE IF NOT EXISTS temp.fts_probe USING fts5(x)')
      db.exec('DROP TABLE temp.fts_probe')
    } catch {
      fts5 = false
    }
    const count = (sql: string): number =>
      Number((db.prepare(sql).get() as Row | undefined)?.n ?? 0)
    return {
      path,
      layoutVersion: v ? Number(v.value) : 0,
      fts5,
      runs: count("SELECT COUNT(*) AS n FROM records WHERE kind = 'run'"),
      memories: count('SELECT COUNT(*) AS n FROM memory'),
    }
  } finally {
    db.close()
  }
}
