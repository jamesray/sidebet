import { readFile } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import { fileURLToPath } from 'node:url'
import { resolveProject, SCHEMA_VERSION } from '@sidebet/core'
import { openStorage } from '@sidebet/storage-local'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { makeRepo } from '../../../tests/helpers.js'
import { createUiServer } from '../src/commands/ui.js'

const page = fileURLToPath(new URL('../web/index.html', import.meta.url))
let base = ''
let server: ReturnType<typeof createUiServer>

beforeAll(async () => {
  const { repo, home } = await makeRepo()
  const project = await resolveProject(repo, { SIDEBET_HOME: home })
  const storage = openStorage({ path: ':memory:' })
  const now = new Date().toISOString()
  storage.records.put('run', {
    id: 'run_11111111',
    schemaVersion: SCHEMA_VERSION,
    projectId: project.projectId,
    kind: 'compare',
    task: 'Demo task',
    category: 'other',
    status: 'completed',
    readonly: false,
    contextSnapshotId: 'ctx_x',
    policyVersion: 'pol_x',
    configVersion: 'c',
    contextMode: 'fresh',
    createdAt: now,
    completedAt: now,
  })
  storage.records.put('attempt', {
    id: 'att_1',
    schemaVersion: SCHEMA_VERSION,
    runId: 'run_11111111',
    label: 'A',
    runtime: 'fake',
    provider: 'p',
    model: 'm',
    status: 'completed',
    changedFiles: ['a.txt'],
  })
  storage.records.put('artifact', {
    id: 'art_1',
    schemaVersion: SCHEMA_VERSION,
    runId: 'run_11111111',
    attemptId: 'att_1',
    kind: 'diff',
    name: 'changes.patch',
    mediaType: 'text/x-diff',
    sha256: 'x',
    sizeBytes: 3,
    content: 'diff --git a/a.txt b/a.txt\n+hi\n',
  })
  storage.memory.add({
    id: 'mem_1',
    schemaVersion: SCHEMA_VERSION,
    scope: 'project',
    projectId: project.projectId,
    text: 'Remember this',
    tags: [],
    source: 'human',
    createdAt: now,
  })
  server = createUiServer({ project, storage }, await readFile(page, 'utf8'))
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterAll(() => server.close())

describe('sidebet ui', () => {
  it('serves the page and a read-only JSON API', async () => {
    const html = await (await fetch(`${base}/`)).text()
    expect(html).toContain('<title>Sidebet</title>')
    const runs = (await (await fetch(`${base}/api/runs`)).json()) as Array<{
      run: { id: string }
      attempts: Array<{ diff?: { content?: string } }>
    }>
    expect(runs[0]?.run.id).toBe('run_11111111')
    expect(runs[0]?.attempts[0]?.diff?.content).toBeUndefined() // list omits diff bodies
    const detail = (await (await fetch(`${base}/api/runs/run_1111`)).json()) as {
      attempts: Array<{ diff?: { content?: string } }>
    }
    expect(detail.attempts[0]?.diff?.content).toContain('+hi')
    expect((await (await fetch(`${base}/api/memory`)).json()) as unknown[]).toHaveLength(1)
    expect(
      ((await (await fetch(`${base}/api/odds`)).json()) as { models: unknown[] }).models,
    ).toHaveLength(1)
    expect((await fetch(`${base}/api/runs/run_nope`)).status).toBe(404)
    expect((await fetch(`${base}/api/runs`, { method: 'POST' })).status).toBe(405)
  })
})
