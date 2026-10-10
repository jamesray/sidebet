import type { RecordKind, RecordMap } from '../domain/schemas.js'
import type {
  MemoryEntry,
  MemoryHit,
  MemoryStore,
  RecordFilter,
  RecordStore,
  Storage,
} from '../storage.js'

type Row = { id: string; runId?: string; attemptId?: string; projectId?: string; record: unknown }

/** In-memory Storage for unit tests. Behaviour mirrors the SQLite implementation. */
export const createMemoryStorage = (): Storage => {
  const tables = new Map<RecordKind, Row[]>()
  const rows = (kind: RecordKind): Row[] => {
    let t = tables.get(kind)
    if (!t) {
      t = []
      tables.set(kind, t)
    }
    return t
  }
  const records: RecordStore = {
    put(kind, record) {
      const r = record as RecordMap[typeof kind] & {
        id: string
        runId?: string
        attemptId?: string
        projectId?: string
      }
      const t = rows(kind)
      const row: Row = {
        id: r.id,
        runId: r.runId,
        attemptId: r.attemptId,
        projectId: r.projectId,
        record: structuredClone(record),
      }
      const i = t.findIndex((x) => x.id === r.id)
      if (i >= 0) t[i] = row
      else t.push(row)
    },
    get(kind, id) {
      return rows(kind).find((r) => r.id === id)?.record as RecordMap[typeof kind] | undefined
    },
    list(kind, filter: RecordFilter = {}) {
      let out = rows(kind).filter(
        (r) =>
          (filter.projectId === undefined || r.projectId === filter.projectId) &&
          (filter.runId === undefined || r.runId === filter.runId) &&
          (filter.attemptId === undefined || r.attemptId === filter.attemptId),
      )
      if (filter.order === 'desc') out = [...out].reverse()
      if (filter.limit !== undefined) out = out.slice(0, filter.limit)
      return out.map((r) => structuredClone(r.record)) as RecordMap[typeof kind][]
    },
    resolveId(kind, prefix) {
      const hits = rows(kind).filter((r) => r.id === prefix || r.id.startsWith(prefix))
      const exact = hits.find((h) => h.id === prefix)
      if (exact) return exact.id
      if (hits.length > 1) throw new Error(`Ambiguous id prefix "${prefix}"`)
      return hits[0]?.id
    },
  }
  const entries: MemoryEntry[] = []
  const tokenize = (s: string): string[] => s.toLowerCase().match(/[a-z0-9]+/g) ?? []
  const memory: MemoryStore = {
    add: (e) => {
      entries.push(structuredClone(e))
    },
    get: (id) => entries.find((e) => e.id === id),
    list: ({ projectId, scope }) =>
      entries.filter(
        (e) =>
          (scope === undefined || e.scope === scope) &&
          (e.scope === 'global' || projectId === undefined || e.projectId === projectId),
      ),
    search(query, { projectId, limit }) {
      const q = tokenize(query)
      const hits: MemoryHit[] = []
      for (const entry of entries) {
        if (entry.scope === 'project' && entry.projectId !== projectId) continue
        const words = new Set(tokenize(`${entry.text} ${entry.tags.join(' ')}`))
        const score = q.filter((w) => words.has(w)).length
        if (score > 0) hits.push({ entry, rank: -score })
      }
      hits.sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0))
      return limit ? hits.slice(0, limit) : hits
    },
    remove(id) {
      const i = entries.findIndex((e) => e.id === id)
      if (i < 0) return false
      entries.splice(i, 1)
      return true
    },
    resolveId(prefix) {
      const hits = entries.filter((e) => e.id.startsWith(prefix))
      const exact = hits.find((h) => h.id === prefix)
      if (exact) return exact.id
      if (hits.length > 1) throw new Error(`Ambiguous id prefix "${prefix}"`)
      return hits[0]?.id
    },
  }
  return { records, memory, close: () => {} }
}
