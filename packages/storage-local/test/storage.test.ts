import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SCHEMA_VERSION, type SidebetRun } from '@sidebet/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { inspectStorage, openStorage, toFtsQuery } from '../src/index.js'

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'sidebet-db-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const run = (id: string, over: Partial<SidebetRun> = {}): SidebetRun => ({
  id,
  schemaVersion: SCHEMA_VERSION,
  projectId: 'prj_a',
  kind: 'run',
  task: 't',
  category: 'other',
  status: 'completed',
  readonly: false,
  contextSnapshotId: 'ctx_1',
  policyVersion: 'pol_1',
  configVersion: 'c1',
  contextMode: 'fresh',
  createdAt: new Date().toISOString(),
  ...over,
})

describe('local storage', () => {
  it('persists records across reopen and upserts by id', () => {
    const path = join(dir, 'a.db')
    const s = openStorage({ path })
    s.records.put('run', run('run_aaaa1111', { status: 'running' }))
    s.records.put('run', run('run_aaaa1111', { status: 'completed' }))
    s.close()
    const again = openStorage({ path })
    expect(again.records.list('run')).toHaveLength(1)
    expect(again.records.get('run', 'run_aaaa1111')?.status).toBe('completed')
    again.close()
  })

  it('filters by project and orders newest first on request', () => {
    const s = openStorage({ path: ':memory:' })
    s.records.put('run', run('run_1', { projectId: 'prj_a' }))
    s.records.put('run', run('run_2', { projectId: 'prj_b' }))
    s.records.put('run', run('run_3', { projectId: 'prj_a' }))
    expect(s.records.list('run', { projectId: 'prj_a', order: 'desc' }).map((r) => r.id)).toEqual([
      'run_3',
      'run_1',
    ])
  })

  it('resolves id prefixes and rejects ambiguous ones', () => {
    const s = openStorage({ path: ':memory:' })
    s.records.put('run', run('run_abc12345'))
    s.records.put('run', run('run_abd12345'))
    expect(s.records.resolveId('run', 'run_abc')).toBe('run_abc12345')
    expect(() => s.records.resolveId('run', 'run_ab')).toThrow(/Ambiguous/)
    expect(s.records.resolveId('run', 'nope')).toBeUndefined()
  })

  it('rejects records that violate the schema', () => {
    const s = openStorage({ path: ':memory:' })
    expect(() => s.records.put('run', { ...run('run_x'), status: 'bogus' as never })).toThrow()
  })

  it('searches memory with FTS5 (stemming, scopes, ranking)', () => {
    const s = openStorage({ path: ':memory:' })
    const add = (id: string, text: string, scope: 'global' | 'project', projectId?: string): void =>
      s.memory.add({
        id,
        schemaVersion: SCHEMA_VERSION,
        scope,
        projectId,
        text,
        tags: [],
        source: 'human',
        createdAt: new Date().toISOString(),
      })
    add('mem_1', 'Public API responses use camelCase', 'project', 'prj_a')
    add('mem_2', 'Migrations require explicit review', 'project', 'prj_a')
    add('mem_3', 'Other project secret sauce about responses', 'project', 'prj_b')
    add('mem_4', 'Always write tests first', 'global')
    expect(s.memory.search('response', { projectId: 'prj_a' }).map((h) => h.entry.id)).toEqual([
      'mem_1',
    ])
    expect(
      s.memory
        .search('tests migration', { projectId: 'prj_a' })
        .map((h) => h.entry.id)
        .sort(),
    ).toEqual(['mem_2', 'mem_4'])
    expect(s.memory.list({ projectId: 'prj_a' }).map((m) => m.id)).toEqual([
      'mem_1',
      'mem_2',
      'mem_4',
    ])
    expect(s.memory.remove('mem_1')).toBe(true)
    expect(s.memory.search('camelCase', { projectId: 'prj_a' })).toEqual([])
  })

  it('survives hostile search input', () => {
    const s = openStorage({ path: ':memory:' })
    expect(s.memory.search('"; DROP TABLE memory; --', { projectId: 'p' })).toEqual([])
    expect(toFtsQuery('***')).toBeUndefined()
  })

  it('reports health including FTS5 support', () => {
    const path = join(dir, 'h.db')
    openStorage({ path }).close()
    expect(inspectStorage(path)).toMatchObject({ fts5: true, layoutVersion: 1, runs: 0 })
  })
})
