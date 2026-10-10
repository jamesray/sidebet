import { existsSync, readFileSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  applyAttempt,
  computeOdds,
  type ExecutionPlan,
  executePlan,
  loadRunDetail,
  newId,
  nowIso,
  planExecution,
  planRerun,
  previewApply,
  type Reporter,
  type RunDetail,
  recordReview,
  resolveProject,
  SCHEMA_VERSION,
  silentReporter,
  suggestMemories,
} from '@sidebet/core'
import { FakeRuntime, type FakeRuntimeOptions } from '@sidebet/core/testing'
import { openStorage } from '@sidebet/storage-local'
import { beforeEach, describe, expect, it } from 'vitest'
import { makeRepo, sh, write } from './helpers.js'

let repo: string
let home: string
const env = (): NodeJS.ProcessEnv => ({ ...process.env, SIDEBET_HOME: home })

const FIXED =
  'export const search = (items, query) => items.filter((i) => i.name.toLowerCase().includes(query.toLowerCase()))\n'
const broken = 'export const search = () => { throw new Error("boom") }\n'

beforeEach(async () => {
  ;({ repo, home } = await makeRepo())
})

interface Harness {
  storage: ReturnType<typeof openStorage>
  runtime: FakeRuntime
}

const setup = async (options: FakeRuntimeOptions = {}, config: object = {}) => {
  const { mkdir } = await import('node:fs/promises')
  await mkdir(join(repo, '.sidebet'), { recursive: true })
  await writeFile(
    join(repo, '.sidebet/config.json'),
    JSON.stringify({ version: 1, tests: { command: 'npm test' }, ...config }),
  )
  sh(repo, 'git', ['add', '-A'])
  sh(repo, 'git', ['commit', '-qm', 'config', '--allow-empty'])
  const storage = openStorage({ path: join(home, 'db.sqlite') })
  const runtime = new FakeRuntime({
    models: [
      { provider: 'fakeai', id: 'alpha' },
      { provider: 'other', id: 'beta' },
    ],
    ...options,
  })
  const project = await resolveProject(repo, env())
  const info = await runtime.detect()
  return { storage, runtime, project, info } satisfies Harness & Record<string, unknown>
}

const execute = async (
  h: Awaited<ReturnType<typeof setup>>,
  kind: 'run' | 'compare',
  task: string,
  extra: Partial<Parameters<typeof planExecution>[0]> = {},
  signal: AbortSignal = new AbortController().signal,
  reporter: Reporter = silentReporter,
): Promise<{ detail: RunDetail; plan: ExecutionPlan }> => {
  const plan = await planExecution({
    project: h.project,
    runtimeInfo: h.info,
    storage: h.storage,
    kind,
    task,
    env: env(),
    ...extra,
  })
  const detail = await executePlan(
    {
      storage: h.storage,
      runtime: h.runtime,
      runtimeInfo: h.info,
      project: h.project,
      reporter,
      signal,
    },
    plan,
  )
  return { detail, plan }
}

const wtList = (): string => sh(repo, 'git', ['worktree', 'list'])

describe('single run', () => {
  it('records the run, tool events, usage, and the exact change set', async () => {
    const h = await setup({
      scripts: {
        'fakeai/alpha': {
          files: { 'src/search.js': FIXED },
          usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.5 },
        },
      },
    })
    const { detail } = await execute(h, 'run', 'Fix search')
    expect(detail.run.status).toBe('completed')
    const a = detail.attempts[0]
    expect(a?.attempt.changedFiles).toEqual(['src/search.js'])
    expect(a?.diff?.content).toContain('toLowerCase')
    expect(a?.usage).toMatchObject({ totalTokens: 15, costUsd: 0.5 })
    expect(a?.toolEvents[0]).toMatchObject({ tool: 'write', status: 'ok' })
    expect(await readFile(join(repo, 'src/search.js'), 'utf8')).toBe(FIXED)
    expect(detail.run.baseCommit).toBeDefined()
  })

  it('diffs only what the agent changed even when the tree was already dirty', async () => {
    const h = await setup({ scripts: { 'fakeai/alpha': { files: { 'src/new.js': 'x\n' } } } })
    await write(repo, 'README.md', 'my own edit\n')
    const { detail } = await execute(h, 'run', 'Add file')
    expect(detail.attempts[0]?.attempt.changedFiles).toEqual(['src/new.js'])
  })

  it('read-only mode records denied writes and verifies the tree is unchanged', async () => {
    const h = await setup({ scripts: { 'fakeai/alpha': { files: { 'src/x.js': 'nope' } } } })
    const { detail, plan } = await execute(h, 'run', 'Explain', { readonly: true })
    expect(plan.tools).toEqual(['read', 'grep', 'find', 'ls'])
    expect(existsSync(join(repo, 'src/x.js'))).toBe(false)
    expect(detail.attempts[0]?.toolEvents[0]).toMatchObject({
      decision: 'denied',
      status: 'denied',
    })
    expect(
      detail.attempts[0]?.evaluations.find((e) => e.evaluator === 'readonly-check')?.outcome,
    ).toBe('pass')
  })

  it('--dry-run planning has no side effects', async () => {
    const h = await setup()
    await planExecution({
      project: h.project,
      runtimeInfo: h.info,
      storage: h.storage,
      kind: 'compare',
      task: 't',
      env: env(),
    })
    expect(h.storage.records.list('run')).toHaveLength(0)
    expect(h.runtime.requests).toHaveLength(0)
    expect(wtList().trim().split('\n')).toHaveLength(1)
  })

  it('marks failed runs and keeps the error', async () => {
    const h = await setup({ scripts: { 'fakeai/alpha': { fail: 'provider exploded' } } })
    const { detail } = await execute(h, 'run', 't')
    expect(detail.run.status).toBe('failed')
    expect(detail.attempts[0]?.attempt.error).toBe('provider exploded')
  })
})

describe('compare', () => {
  it('runs two models in isolated worktrees without touching the working tree', async () => {
    const h = await setup({
      scripts: {
        'fakeai/alpha': { files: { 'src/search.js': FIXED }, delayMs: 50 },
        'other/beta': {
          files: { 'src/search.js': 'export const search = () => []\n', 'src/extra.js': 'e\n' },
        },
      },
    })
    const before = sh(repo, 'git', ['status', '--porcelain'])
    const { detail } = await execute(h, 'compare', 'Make it case-insensitive')
    expect(sh(repo, 'git', ['status', '--porcelain'])).toBe(before)
    expect(await readFile(join(repo, 'src/search.js'), 'utf8')).not.toContain('toLowerCase')
    expect(detail.run.status).toBe('completed')
    const [a, b] = detail.attempts
    expect(a?.attempt.changedFiles).toEqual(['src/search.js'])
    expect(b?.attempt.changedFiles.sort()).toEqual(['src/extra.js', 'src/search.js'])
    // each attempt ran in its own directory, distinct from the repo and each other
    const cwds = h.runtime.requests.map((r) => r.cwd)
    expect(new Set(cwds).size).toBe(2)
    expect(cwds.every((c) => c !== repo)).toBe(true)
    // tests ran in the worktree: A's change keeps tests passing
    expect(a?.tests[0]?.status).toBe('passed')
    expect(b?.tests[0]?.status).toBe('failed')
    // worktrees cleaned, results preserved as refs
    expect(wtList().trim().split('\n')).toHaveLength(1)
    expect(sh(repo, 'git', ['for-each-ref', 'refs/sidebet/runs'])).toContain(`${detail.run.id}/A`)
  })

  it('runs attempts concurrently', async () => {
    const h = await setup({
      scripts: { 'fakeai/alpha': { delayMs: 400 }, 'other/beta': { delayMs: 400 } },
    })
    const t = Date.now()
    await execute(h, 'compare', 't', {}, undefined)
    expect(Date.now() - t).toBeLessThan(1500)
    const h2 = await setup({
      scripts: { 'fakeai/alpha': { delayMs: 300 }, 'other/beta': { delayMs: 300 } },
    })
    const t2 = Date.now()
    await execute(h2, 'compare', 't', { concurrency: 1 })
    expect(Date.now() - t2).toBeGreaterThanOrEqual(600)
  })

  it('snapshots uncommitted changes (tracked and untracked) as the shared base', async () => {
    const h = await setup({ scripts: { 'fakeai/alpha': {}, 'other/beta': {} } })
    await write(repo, 'README.md', 'uncommitted edit\n')
    await write(repo, 'src/untracked.js', 'u\n')
    const status = sh(repo, 'git', ['status', '--porcelain'])
    const seen: string[] = []
    h.runtime.requests.length = 0
    const rt = new FakeRuntime({
      models: [
        { provider: 'fakeai', id: 'alpha' },
        { provider: 'other', id: 'beta' },
      ],
      scripts: (req) => {
        seen.push(
          `${existsSync(join(req.cwd, 'src/untracked.js'))}:${readFileSync(join(req.cwd, 'README.md'), 'utf8').trim()}`,
        )
        return {}
      },
    })
    const plan = await planExecution({
      project: h.project,
      runtimeInfo: h.info,
      storage: h.storage,
      kind: 'compare',
      task: 't',
      env: env(),
    })
    const detail = await executePlan(
      {
        storage: h.storage,
        runtime: rt,
        runtimeInfo: h.info,
        project: h.project,
        reporter: silentReporter,
        signal: new AbortController().signal,
      },
      plan,
    )
    expect(seen).toEqual(['true:uncommitted edit', 'true:uncommitted edit'])
    expect(sh(repo, 'git', ['status', '--porcelain'])).toBe(status) // original untouched
    expect(detail.attempts[0]?.attempt.changedFiles).toEqual([]) // diffs are relative to the snapshot
  })

  it('refuses a dirty tree when compare.uncommitted is "refuse"', async () => {
    const h = await setup({}, { compare: { uncommitted: 'refuse' } })
    await write(repo, 'README.md', 'dirty\n')
    await expect(execute(h, 'compare', 't')).rejects.toThrow(/uncommitted/)
    expect(h.storage.records.list('run')[0]?.status).toBe('failed')
  })

  it('keeps going when one attempt fails (partial) and records the error', async () => {
    const h = await setup({
      scripts: {
        'fakeai/alpha': { files: { 'src/search.js': FIXED } },
        'other/beta': { fail: 'rate limited' },
      },
    })
    const { detail } = await execute(h, 'compare', 't')
    expect(detail.run.status).toBe('partial')
    expect(detail.attempts.map((a) => a.attempt.status)).toEqual(['completed', 'failed'])
    expect(detail.attempts[1]?.attempt.error).toBe('rate limited')
    expect(detail.attempts[1]?.tests[0]?.status).toBe('skipped')
    expect(wtList().trim().split('\n')).toHaveLength(1)
  })

  it('times out hung attempts without hanging the run', async () => {
    const h = await setup({
      scripts: {
        'fakeai/alpha': { hang: true },
        'other/beta': { files: { 'src/search.js': FIXED } },
      },
    })
    const t = Date.now()
    const { detail } = await execute(h, 'compare', 't', { timeoutSec: 0.4 })
    expect(Date.now() - t).toBeLessThan(10_000)
    expect(detail.attempts[0]?.attempt.status).toBe('timeout')
    expect(detail.run.status).toBe('partial')
  })

  it('cancels cleanly: attempts end cancelled, worktrees removed, original tree untouched', async () => {
    const h = await setup({
      scripts: { 'fakeai/alpha': { hang: true }, 'other/beta': { hang: true } },
    })
    const ac = new AbortController()
    setTimeout(() => ac.abort(), 300)
    const status = sh(repo, 'git', ['status', '--porcelain'])
    const { detail } = await execute(h, 'compare', 't', {}, ac.signal)
    expect(detail.run.status).toBe('cancelled')
    expect(detail.attempts.every((a) => a.attempt.status === 'cancelled')).toBe(true)
    expect(wtList().trim().split('\n')).toHaveLength(1)
    expect(sh(repo, 'git', ['status', '--porcelain'])).toBe(status)
  })

  it('rejects policy-denied models before starting anything', async () => {
    const h = await setup({}, { policy: { allowedProviders: ['fakeai'] } })
    await expect(
      planExecution({
        project: h.project,
        runtimeInfo: h.info,
        storage: h.storage,
        kind: 'compare',
        task: 't',
        models: ['fakeai/alpha', 'other/beta'],
        env: env(),
      }),
    ).rejects.toThrow(/denied by policy/)
    await expect(
      planExecution({
        project: h.project,
        runtimeInfo: h.info,
        storage: h.storage,
        kind: 'compare',
        task: 't',
        env: env(),
      }),
    ).rejects.toThrow(/two eligible models/)
  })

  it('accepts aliases for named models', async () => {
    const h = await setup(
      {},
      { models: { aliases: { quick: 'fakeai/alpha', deep: 'other/beta' } } },
    )
    const plan = await planExecution({
      project: h.project,
      runtimeInfo: h.info,
      storage: h.storage,
      kind: 'compare',
      task: 't',
      models: ['quick', 'deep'],
      env: env(),
    })
    expect(plan.models.map((m) => m.id)).toEqual(['alpha', 'beta'])
  })
})

describe('review, apply, rerun, odds', () => {
  const twoModels = {
    scripts: {
      'fakeai/alpha': {
        files: { 'src/search.js': FIXED },
        summary: 'Note: always lowercase both sides of the comparison.',
      },
      'other/beta': { files: { 'src/search.js': broken } },
    },
  }

  it('applies the chosen attempt safely and leaves a recoverable reference', async () => {
    const h = await setup(twoModels)
    const { detail } = await execute(h, 'compare', 'Fix search')
    recordReview(h.storage, detail, {
      runId: detail.run.id,
      preferred: 'A',
      accepted: true,
      reason: 'tests pass',
    })
    const preview = await previewApply(h.project, detail, 'A')
    expect(preview.files).toEqual(['src/search.js'])
    expect(preview.applies).toBe(true)
    const app = await applyAttempt(h.project, h.storage, preview)
    expect(await readFile(join(repo, 'src/search.js'), 'utf8')).toBe(FIXED)
    expect(sh(repo, 'git', ['rev-parse', '--verify', app.backupRef]).trim()).toMatch(
      /^[0-9a-f]{40}$/,
    )
    expect(sh(repo, 'git', ['rev-parse', '--verify', app.resultRef]).trim()).toMatch(
      /^[0-9a-f]{40}$/,
    )
    expect(sh(repo, 'git', ['diff', '--cached', '--name-only']).trim()).toBe('') // index untouched
    expect(loadRunDetail(h.storage, detail.run.id).applications).toHaveLength(1)
  })

  it('refuses to apply over conflicting local edits and changes nothing', async () => {
    const h = await setup(twoModels)
    const { detail } = await execute(h, 'compare', 'Fix search')
    await write(repo, 'src/search.js', 'export const search = () => "my own work"\n')
    const preview = await previewApply(h.project, detail, 'A')
    expect(preview.applies).toBe(false)
    expect(preview.locallyModified).toEqual(['src/search.js'])
    await expect(applyAttempt(h.project, h.storage, preview)).rejects.toThrow(
      /does not apply cleanly/,
    )
    expect(await readFile(join(repo, 'src/search.js'), 'utf8')).toContain('my own work')
  })

  it('layers a patch on top of unrelated local edits without discarding them', async () => {
    const h = await setup(twoModels)
    const { detail } = await execute(h, 'compare', 'Fix search')
    await write(repo, 'README.md', 'unrelated local edit\n')
    await applyAttempt(h.project, h.storage, await previewApply(h.project, detail, 'A'))
    expect(await readFile(join(repo, 'README.md'), 'utf8')).toBe('unrelated local edit\n')
    expect(await readFile(join(repo, 'src/search.js'), 'utf8')).toBe(FIXED)
  })

  it('refuses to apply a failed attempt unless explicitly allowed', async () => {
    const h = await setup({
      scripts: {
        'fakeai/alpha': { files: { 'src/search.js': FIXED } },
        'other/beta': { fail: 'x' },
      },
    })
    const { detail } = await execute(h, 'compare', 't')
    await expect(previewApply(h.project, detail, 'B')).rejects.toThrow(/ended as "failed"/)
  })

  it('persists reviews and reruns with original or current context', async () => {
    const h = await setup(twoModels)
    const { detail } = await execute(h, 'compare', 'Fix search')
    recordReview(h.storage, detail, { runId: detail.run.id, preferred: 'A', accepted: true })
    await write(repo, 'AGENTS.md', 'CHANGED RULES\n')
    sh(repo, 'git', ['commit', '-qam', 'later'])
    const original = await planRerun(
      h.storage,
      h.project,
      h.info,
      loadRunDetail(h.storage, detail.run.id),
      { context: 'original' },
    )
    expect(original.plan.contextMode).toBe('original')
    expect(original.plan.contextPrompt).toContain('Keep functions small')
    expect(original.plan.contextPrompt).not.toContain('CHANGED RULES')
    expect(original.notes.join(' ')).toMatch(/ORIGINAL snapshot/)
    expect(original.notes.join(' ')).toMatch(/Repository has changed/)
    expect(original.notes.join(' ')).toMatch(/not guaranteed/)
    const current = await planRerun(
      h.storage,
      h.project,
      h.info,
      loadRunDetail(h.storage, detail.run.id),
      { context: 'current' },
    )
    expect(current.plan.contextMode).toBe('fresh')
    expect(current.notes[0]).toMatch(/CURRENT/)
    const rerun = await executePlan(
      {
        storage: h.storage,
        runtime: h.runtime,
        runtimeInfo: h.info,
        project: h.project,
        reporter: silentReporter,
        signal: new AbortController().signal,
      },
      original.plan,
      { parentRunId: detail.run.id },
    )
    expect(rerun.run.parentRunId).toBe(detail.run.id)
    expect(rerun.run.contextSnapshotId).toBe(detail.run.contextSnapshotId)
    expect(rerun.attempts.map((a) => a.attempt.model)).toEqual(['alpha', 'beta'])
  })

  it('computes odds with sample sizes and separates tests from preference', async () => {
    const h = await setup(twoModels)
    for (let i = 0; i < 3; i++) {
      const { detail } = await execute(h, 'compare', `Fix search ${i}`)
      if (i < 2)
        recordReview(h.storage, detail, { runId: detail.run.id, preferred: 'A', accepted: true })
    }
    const report = computeOdds(h.storage, h.project.projectId)
    const alpha = report.models.find((m) => m.model === 'fakeai/alpha')
    const beta = report.models.find((m) => m.model === 'other/beta')
    expect(alpha).toMatchObject({
      attempts: 3,
      testsRun: 3,
      testsPassed: 3,
      appearances: 2,
      preferred: 2,
      reviewsAccepted: 2,
    })
    expect(beta).toMatchObject({ attempts: 3, testsPassed: 0, preferred: 0 })
    expect(report.headToHead[0]).toMatchObject({ runs: 3, aPreferred: 2, aOnlyPassed: 3 })
    expect(report.caveats.join(' ')).toMatch(/Only 2 compare run/)
    expect(alpha?.medianCostUsd).toBeUndefined() // cost never invented
  })

  it('odds are useful with a single run and empty history', async () => {
    const h = await setup(twoModels)
    expect(computeOdds(h.storage, h.project.projectId).caveats[0]).toMatch(/No finished runs/)
    await execute(h, 'run', 'Fix search')
    expect(computeOdds(h.storage, h.project.projectId).models).toHaveLength(1)
  })

  it('suggests memories from a run summary without saving anything', async () => {
    const h = await setup(twoModels)
    const { detail } = await execute(h, 'compare', 'Fix search')
    const text = detail.attempts.map((a) => a.attempt.summary ?? '').join('\n')
    const suggestions = suggestMemories(text, h.storage.memory, h.project.projectId)
    expect(suggestions).toEqual(['Note: always lowercase both sides of the comparison.'])
    expect(h.storage.memory.list({ projectId: h.project.projectId })).toHaveLength(0)
    h.storage.memory.add({
      id: newId('mem'),
      schemaVersion: SCHEMA_VERSION,
      scope: 'project',
      projectId: h.project.projectId,
      text: suggestions[0] as string,
      tags: [],
      source: 'suggestion',
      createdAt: nowIso(),
    })
    expect(suggestMemories(text, h.storage.memory, h.project.projectId)).toEqual([])
  })
})

describe('metrics', () => {
  it('records timing, tool counts, token/cost usage and line stats per attempt', async () => {
    const h = await setup({
      scripts: {
        'fakeai/alpha': {
          files: { 'src/search.js': FIXED, 'src/new.js': 'a\nb\n' },
          delayMs: 120,
          usage: { inputTokens: 500, outputTokens: 50, costUsd: 0.02 },
        },
        'other/beta': { summary: 'nothing to do' },
      },
    })
    const { detail } = await execute(h, 'compare', 'Fix search')
    const [a, b] = detail.attempts
    expect(a?.usage).toMatchObject({
      turns: 1,
      toolCalls: 2,
      toolErrors: 0,
      toolsDenied: 0,
      toolCallsByTool: { write: 2 },
      totalTokens: 550,
      costUsd: 0.02,
    })
    expect(a?.usage?.agentDurationMs).toBeGreaterThanOrEqual(100)
    expect(a?.usage?.timeToFirstEditMs).toBeGreaterThanOrEqual(100)
    expect(a?.usage?.timeToFirstEditMs).toBeLessThanOrEqual(a?.usage?.agentDurationMs ?? 0)
    expect(a?.usage?.timeToFirstTokenMs).toBeDefined()
    expect(a?.attempt.linesAdded).toBe(3)
    expect(a?.attempt.linesRemoved).toBe(2)
    expect(b?.usage?.timeToFirstEditMs).toBeUndefined() // never edited
    expect(b?.usage?.toolCalls).toBe(0)
    expect(b?.attempt.linesAdded).toBe(0)
    expect(b?.usage?.costUsd).toBeUndefined()
  })

  it('keeps metrics for read-only runs where every write was blocked', async () => {
    const h = await setup({ scripts: { 'fakeai/alpha': { files: { 'x.js': '1' } } } })
    const { detail } = await execute(h, 'run', 'Explain', { readonly: true })
    expect(detail.attempts[0]?.usage).toMatchObject({ toolCalls: 0, toolsDenied: 1 })
    expect(detail.attempts[0]?.usage?.timeToFirstEditMs).toBeUndefined()
  })

  it('reports attempt lifecycle and usage events to the reporter', async () => {
    const h = await setup({
      scripts: { 'fakeai/alpha': { usage: { inputTokens: 7, outputTokens: 3 } }, 'other/beta': {} },
    })
    const seen: string[] = []
    const reporter: Reporter = {
      ...silentReporter,
      attempt: (who, status) => seen.push(`${who.label}:${status}`),
      event: (who, e) =>
        e.type === 'usage' && seen.push(`${who.label}:usage:${e.inputTokens + e.outputTokens}`),
    }
    await execute(h, 'compare', 't', {}, undefined, reporter)
    expect(seen).toContain('A:running')
    expect(seen).toContain('A:usage:10')
    expect(seen).toContain('A:completed')
    expect(seen).toContain('B:completed')
  })
})

describe('compare setup', () => {
  it('runs setup non-interactively, stores its output, and fails the attempt when it exits non-zero', async () => {
    const h = await setup(
      { scripts: { 'fakeai/alpha': {}, 'other/beta': {} } },
      { compare: { setup: 'echo "CI=$CI"; test -n "$CI"; echo setup-ran' } },
    )
    const { detail } = await execute(h, 'compare', 't')
    expect(detail.run.status).toBe('completed')
    const log = detail.attempts[0]?.logs.find((l) => l.name === 'setup.log')
    expect(log?.content).toContain('CI=1')
    expect(log?.content).toContain('setup-ran')
    expect(h.runtime.requests).toHaveLength(2)

    const bad = await setup(
      { scripts: { 'fakeai/alpha': {}, 'other/beta': {} } },
      { compare: { setup: 'echo boom >&2; exit 3' } },
    )
    const { detail: failed } = await execute(bad, 'compare', 't')
    expect(failed.run.status).toBe('failed')
    expect(failed.attempts[0]?.attempt.error).toMatch(/compare.setup failed \(exit 3\)/)
    expect(bad.runtime.requests).toHaveLength(0) // no model was called on a broken tree
  })
})
