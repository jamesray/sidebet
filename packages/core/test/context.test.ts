import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { makeRepo, write } from '../../../tests/helpers.js'
import {
  assembleContext,
  renderForReplay,
  resolveProject,
  SCHEMA_VERSION,
  summarizeContext,
} from '../src/index.js'
import { createMemoryStorage } from '../src/testing/index.js'

let repo: string
let home: string
const runtime = { skillDirs: [] as string[], globalContextFiles: [] as string[] }

beforeEach(async () => {
  ;({ repo, home } = await makeRepo())
})

const project = (): ReturnType<typeof resolveProject> =>
  resolveProject(repo, { SIDEBET_HOME: home })

describe('context assembly', () => {
  it('lists AGENTS.md as native (not repeated) and injects Sidebet rules', async () => {
    await mkdir(join(repo, '.sidebet/rules'), { recursive: true })
    await write(repo, '.sidebet/rules/api.md', 'Always return camelCase keys.')
    const snap = await assembleContext({
      project: await project(),
      task: 'add endpoint',
      memory: createMemoryStorage().memory,
      runtime,
      env: { SIDEBET_HOME: home },
    })
    const agents = snap.items.find((i) => i.kind === 'agents')
    expect(agents?.delivery).toBe('native')
    expect(snap.rendered).not.toContain('Keep functions small')
    expect(snap.rendered).toContain('Always return camelCase keys.')
    expect(summarizeContext(snap).rules).toContain('.sidebet/rules/api.md')
  })

  it('orders by precedence deterministically: project rules before global rules before docs', async () => {
    await mkdir(join(home, 'rules'), { recursive: true })
    await write(repo, 'CONTRIBUTING.md', 'doc text')
    await mkdir(join(repo, '.sidebet/rules'), { recursive: true })
    await write(repo, '.sidebet/rules/p.md', 'PROJECT RULE')
    await writeFile(join(home, 'rules/g.md'), 'GLOBAL RULE')
    const args = {
      project: await project(),
      task: 't',
      memory: createMemoryStorage().memory,
      runtime,
      env: { SIDEBET_HOME: home },
    }
    const a = await assembleContext(args)
    const b = await assembleContext(args)
    expect(a.rendered.indexOf('PROJECT RULE')).toBeLessThan(a.rendered.indexOf('GLOBAL RULE'))
    expect(a.rendered.indexOf('GLOBAL RULE')).toBeLessThan(a.rendered.indexOf('doc text'))
    expect(a.rendered).toBe(b.rendered)
    expect(a.hash).toBe(b.hash)
  })

  it('puts memory last, marked advisory, and picks relevant entries when the set is large', async () => {
    const storage = createMemoryStorage()
    const p = await project()
    const mk = (text: string): void =>
      storage.memory.add({
        id: `mem_${text.length}${text[0]}`,
        schemaVersion: SCHEMA_VERSION,
        scope: 'project',
        projectId: p.projectId,
        text,
        tags: [],
        source: 'human',
        createdAt: new Date().toISOString(),
      })
    for (const t of [
      'Public API responses use camelCase',
      'Staging mirrors production endpoints',
      'Migrations need review',
      'Slow test: billing',
      'Service foo is deprecated',
      'Unrelated gardening note',
    ])
      mk(t)
    const snap = await assembleContext({
      project: p,
      task: 'update the camelCase api responses',
      memory: storage.memory,
      runtime,
      env: { SIDEBET_HOME: home },
    })
    expect(snap.rendered).toContain('advisory')
    expect(snap.rendered).toContain('camelCase')
    expect(snap.rendered).not.toContain('gardening')
    const omitted = snap.items.filter((i) => i.kind === 'memory' && i.delivery === 'omitted')
    expect(omitted.length).toBeGreaterThan(0)
    expect(omitted[0]?.reason).toContain('not relevant')
  })

  it('includes every memory when the set is small', async () => {
    const storage = createMemoryStorage()
    const p = await project()
    storage.memory.add({
      id: 'mem_1',
      schemaVersion: SCHEMA_VERSION,
      scope: 'project',
      projectId: p.projectId,
      text: 'Keep it boring',
      tags: [],
      source: 'human',
      createdAt: new Date().toISOString(),
    })
    const snap = await assembleContext({
      project: p,
      task: 'unrelated words only',
      memory: storage.memory,
      runtime,
      env: { SIDEBET_HOME: home },
    })
    expect(snap.rendered).toContain('Keep it boring')
  })

  it('redacts secrets and takes over native delivery when AGENTS.md contains one', async () => {
    await write(repo, 'AGENTS.md', 'Use this key: sk-ant-abcdefghijklmnopqrstuvwxyz0123')
    const snap = await assembleContext({
      project: await project(),
      task: 't',
      memory: createMemoryStorage().memory,
      runtime,
      env: { SIDEBET_HOME: home },
    })
    expect(snap.nativeContextFiles).toBe(false)
    expect(snap.rendered).toContain('[REDACTED]')
    expect(snap.rendered).not.toContain('sk-ant-abcdef')
    expect(JSON.stringify(snap)).not.toContain('sk-ant-abcdef')
    expect(snap.items.find((i) => i.kind === 'agents')?.redactions).toBeGreaterThan(0)
  })

  it('never includes protected files, and says why', async () => {
    await write(repo, '.env', 'SECRET=1')
    await mkdir(join(repo, '.sidebet'), { recursive: true })
    await write(repo, '.sidebet/config.json', JSON.stringify({ context: { docs: ['.env'] } }))
    const snap = await assembleContext({
      project: await project(),
      task: 't',
      memory: createMemoryStorage().memory,
      runtime,
      env: { SIDEBET_HOME: home },
    })
    expect(snap.rendered).not.toContain('SECRET=1')
    expect(snap.items.find((i) => i.source === '.env')?.reason).toContain('protected')
  })

  it('drops lowest-priority items first when over budget and explains it', async () => {
    await write(repo, 'CONTRIBUTING.md', 'x'.repeat(4000))
    await mkdir(join(repo, '.sidebet/rules'), { recursive: true })
    await write(repo, '.sidebet/rules/a.md', 'rule '.repeat(100))
    await write(
      repo,
      '.sidebet/config.json',
      JSON.stringify({ context: { budgetTokens: 600, perItemTokens: 2000 } }),
    )
    const snap = await assembleContext({
      project: await project(),
      task: 't',
      memory: createMemoryStorage().memory,
      runtime,
      env: { SIDEBET_HOME: home },
    })
    expect(snap.injectedTokens).toBeLessThanOrEqual(600)
    expect(snap.items.find((i) => i.source === 'CONTRIBUTING.md')?.delivery).toBe('omitted')
    expect(snap.items.find((i) => i.source === 'CONTRIBUTING.md')?.reason).toContain('over budget')
    expect(snap.items.find((i) => i.source.endsWith('a.md'))?.delivery).toBe('injected')
  })

  it('replays native AGENTS.md from the snapshot, not from disk', async () => {
    const snap = await assembleContext({
      project: await project(),
      task: 't',
      memory: createMemoryStorage().memory,
      runtime,
      env: { SIDEBET_HOME: home },
    })
    await write(repo, 'AGENTS.md', 'CHANGED AFTERWARDS')
    const replay = renderForReplay(snap)
    expect(replay).toContain('Keep functions small')
    expect(replay).not.toContain('CHANGED AFTERWARDS')
  })
})
