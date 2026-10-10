import type { RecordKind, RecordMap } from './domain/schemas.js'

export interface RecordFilter {
  projectId?: string
  runId?: string
  attemptId?: string
  limit?: number
  /** Insertion order. Defaults to asc. */
  order?: 'asc' | 'desc'
}

/**
 * Durable, versioned record storage. Every record is a self-contained JSON document,
 * so the same records can later be synchronised to a remote store unchanged.
 */
export interface RecordStore {
  put<K extends RecordKind>(kind: K, record: RecordMap[K]): void
  get<K extends RecordKind>(kind: K, id: string): RecordMap[K] | undefined
  list<K extends RecordKind>(kind: K, filter?: RecordFilter): RecordMap[K][]
  /** Resolve a full id or unique prefix. Throws on ambiguity. */
  resolveId(kind: RecordKind, idOrPrefix: string): string | undefined
}

export interface MemoryEntry {
  id: string
  schemaVersion: number
  scope: 'global' | 'project'
  projectId?: string
  text: string
  tags: string[]
  source: 'human' | 'suggestion'
  createdAt: string
}

export interface MemoryHit {
  entry: MemoryEntry
  /** Lower is better (FTS5 bm25). Undefined for non-search listings. */
  rank?: number
}

export interface MemoryStore {
  add(entry: MemoryEntry): void
  get(id: string): MemoryEntry | undefined
  list(filter: { projectId?: string; scope?: 'global' | 'project' }): MemoryEntry[]
  search(query: string, filter: { projectId?: string; limit?: number }): MemoryHit[]
  remove(id: string): boolean
  resolveId(idOrPrefix: string): string | undefined
}

export interface Storage {
  records: RecordStore
  memory: MemoryStore
  close(): void
}
