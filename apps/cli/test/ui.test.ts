import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { request } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import {
  type AgentRuntime,
  type AttemptOutcome,
  type AttemptRequest,
  type RuntimeInfo,
  resolveProject,
} from '@sidebet/core'
import { FakeRuntime } from '@sidebet/core/testing'
import { openStorage } from '@sidebet/storage-local'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { makeRepo, sh } from '../../../tests/helpers.js'
import { createUiServer, type UiServer } from '../src/server/index.js'

const FIXED =
  'export const search = (items, query) => items.filter((i) => i.name.toLowerCase().includes(query.toLowerCase()))\n'
const MODELS = [
  { provider: 'fakeai', id: 'alpha' },
  { provider: 'other', id: 'beta' },
]

const normal = new FakeRuntime({
  models: MODELS,
  scripts: {
    'fakeai/alpha': {
      files: { 'src/search.js': FIXED },
      summary: 'Made it case-insensitive. Always keep search case-insensitive for product names.',
      usage: { inputTokens: 1000, outputTokens: 200, costUsd: 0.02 },
    },
    'other/beta': { files: { 'src/search.js': 'export const search = () => []\n' }, delayMs: 50 },
  },
})
const hanging = new FakeRuntime({ models: MODELS, scripts: { 'fakeai/alpha': { hang: true } } })

/** Asks for approval once, then reports what the human decided. */
class ApprovingRuntime implements AgentRuntime {
  readonly id = 'fake'
  detect(): Promise<RuntimeInfo> {
    return normal.detect()
  }
  async execute(req: AttemptRequest): Promise<AttemptOutcome> {
    const ok = req.approve
      ? await req.approve({
          tool: 'bash',
          summary: 'rm -rf dist',
          reason: 'matches approvalRequired',
        })
      : false
    return { status: 'completed', summary: ok ? 'approved' : 'denied' }
  }
}

let current: AgentRuntime = normal
let repo = ''
let base = ''
let token = ''
let server: UiServer
let runId = ''

const j = async <T>(path: string): Promise<T> =>
  (await fetch(`${base}${path}`)).json() as Promise<T>
const send = (
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<Response> =>
  fetch(`${base}${path}`, {
    method,
    headers: {
      'x-sidebet-token': token,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
const ok = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
  const r = await send(method, path, body)
  const data = (await r.json()) as T & { error?: string }
  expect(r.status, `${method} ${path}: ${data.error ?? ''}`).toBeLessThan(300)
  return data
}
interface Job {
  id: string
  status: string
  runId?: string
  runStatus?: string
  cancelling: boolean
  attempts: Array<{ status: string; turns: number; input: number; text: string }>
  approvals: Array<{ id: string; decision?: string }>
  error?: string
}
const waitJob = async (id: string, until: (job: Job) => boolean, ms = 25_000): Promise<Job> => {
  const deadline = Date.now() + ms
  for (;;) {
    const job = await j<Job>(`/api/jobs/${id}`)
    if (until(job)) return job
    if (Date.now() > deadline) throw new Error(`job ${id} did not settle: ${JSON.stringify(job)}`)
    await new Promise((r) => setTimeout(r, 100))
  }
}
const done = (job: Job): boolean => job.status !== 'running'
/** fetch() drops a custom Host header, so the DNS-rebinding check needs a raw request. */
const statusWithHost = (path: string, host: string): Promise<number> =>
  new Promise((resolve, reject) => {
    const r = request(`${base}${path}`, { headers: { host } }, (res) => {
      res.resume()
      resolve(res.statusCode ?? 0)
    })
    r.on('error', reject)
    r.end()
  })

beforeAll(async () => {
  const made = await makeRepo()
  repo = made.repo
  // Everything the server (and the worktree helpers that read process.env) touches stays in the temp home.
  process.env.SIDEBET_HOME = made.home
  process.env.SIDEBET_RUNTIME = 'fake'
  const project = await resolveProject(repo, process.env)
  const storage = openStorage({ path: ':memory:' })
  server = createUiServer(
    { project, storage },
    { env: process.env, loadRuntime: async () => current, version: '0.0.0-test' },
  )
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  token = server.token
})
afterAll(() => server.close())

describe('sidebet ui server', () => {
  it('serves the page with its token and the static assets', async () => {
    const html = await (await fetch(`${base}/`)).text()
    expect(html).toContain('<title>Sidebet</title>')
    expect(html).toContain(`<meta name="sidebet-token" content="${token}">`)
    expect(html).not.toContain('__SIDEBET_TOKEN__')
    const js = await fetch(`${base}/app.js`)
    expect(js.headers.get('content-type')).toContain('text/javascript')
    expect(await js.text()).toContain('sidebet-token')
    expect((await fetch(`${base}/style.css`)).status).toBe(200)
    expect((await fetch(`${base}/nope.html`)).status).toBe(404)
    const svg = await fetch(`${base}/chip.svg?variant=blue`)
    expect(svg.headers.get('content-type')).toContain('image/svg+xml')
    expect(await svg.text()).toContain('Sidebet chip (blue)')
    expect((await fetch(`${base}/`)).headers.get('content-security-policy')).toContain(
      "script-src 'self'",
    )
  })

  it('rejects mutations without the token, from other origins, and for foreign hosts', async () => {
    const noToken = await fetch(`${base}/api/memory`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"text":"x"}',
    })
    expect(noToken.status).toBe(403)
    expect(
      (await send('POST', '/api/memory', { text: 'x' }, { origin: 'http://evil.example' })).status,
    ).toBe(403)
    expect(await statusWithHost('/api/project', 'evil.example')).toBe(403)
    expect(await statusWithHost('/api/project', 'localhost:1')).toBe(200)
    const preflight = await fetch(`${base}/api/memory`, { method: 'OPTIONS' })
    expect(preflight.status).toBe(204)
    expect(preflight.headers.get('access-control-allow-origin')).toBeNull()
    expect((await send('PUT', '/api/runs')).status).toBe(405)
    expect((await send('POST', '/api/memory', 'not json')).status).toBe(400)
    expect((await j<{ error: string }>('/api/nope')).error).toBe('not found')
  })

  it('initializes the project and edits its settings', async () => {
    expect((await j<{ initialized: boolean }>('/api/project')).initialized).toBe(false)
    const init = await ok<{
      initialized: boolean
      raw: { projectId: string; tests: { command: string } }
    }>('POST', '/api/init')
    expect(init.initialized).toBe(true)
    expect(init.raw.tests.command).toBe('npm test')
    expect(existsSync(join(repo, '.sidebet/config.json'))).toBe(true)
    expect((await send('POST', '/api/init')).status).toBe(409)

    const bad = await send('PUT', '/api/settings', {
      config: { ...init.raw, tests: { timeoutSec: -1 } },
    })
    expect(bad.status).toBe(400)
    expect(((await bad.json()) as { issues: Array<{ path: string }> }).issues[0]?.path).toBe(
      'tests.timeoutSec',
    )

    const saved = await ok<{
      raw: { projectId: string; name: string; ui: { chip: string } }
      effective: { ui: { chip: string } }
    }>('PUT', '/api/settings', {
      config: {
        ...init.raw,
        projectId: 'prj_forged',
        name: 'renamed',
        ui: { chip: 'green' },
        run: { dual: '' },
      },
    })
    expect(saved.raw.projectId).toBe(init.raw.projectId) // the id is never changed through the UI
    expect(saved.raw.name).toBe('renamed')
    expect(saved.effective.ui.chip).toBe('green')
    expect(
      JSON.parse(await readFile(join(repo, '.sidebet/config.json'), 'utf8')).run,
    ).toBeUndefined() // empty values are pruned
    expect((await j<{ name: string; chip: string }>('/api/project')).name).toBe('renamed')
    expect((await j<{ chip: string }>('/api/project')).chip).toBe('green')
    sh(repo, 'git', ['add', '-A'])
    sh(repo, 'git', ['commit', '-qm', 'config'])
  })

  it('previews a plan without starting anything', async () => {
    const r = await ok<{
      plan: {
        models: unknown[]
        snapshot: { items: Array<{ content?: string }>; rendered: string }
        contextPrompt?: string
      }
    }>('POST', '/api/plan', { kind: 'compare', task: 'Make search case-insensitive' })
    expect(r.plan.models).toHaveLength(2)
    expect(r.plan.snapshot.items.every((i) => i.content === undefined)).toBe(true)
    expect(r.plan.contextPrompt).toBeUndefined()
    expect(await j<unknown[]>('/api/runs')).toHaveLength(0)
    expect((await send('POST', '/api/plan', { kind: 'compare' })).status).toBe(400)
  })

  it('starts a compare job, reports progress, and records the run', async () => {
    const r = await ok<{ job: Job }>('POST', '/api/jobs', {
      kind: 'compare',
      task: 'Make search case-insensitive',
      models: ['fakeai/alpha', 'other/beta'],
    })
    expect(r.job.runId).toMatch(/^run_/)
    runId = r.job.runId as string
    expect((await j<{ activeJob: string | null }>('/api/project')).activeJob).toBe(r.job.id)
    const job = await waitJob(r.job.id, done)
    expect(job.status).toBe('finished')
    expect(job.runStatus).toBe('completed')
    expect(job.attempts.map((a) => a.status)).toEqual(['completed', 'completed'])
    expect(job.attempts[0]?.turns).toBe(1)
    expect(job.attempts[0]?.input).toBe(1000)

    const runs =
      await j<Array<{ run: { id: string }; attempts: Array<{ diff?: { content?: string } }> }>>(
        '/api/runs',
      )
    expect(runs[0]?.run.id).toBe(runId)
    expect(runs[0]?.attempts[0]?.diff?.content).toBeUndefined() // list omits diff bodies
    const detail = await j<{
      jobId: string
      attempts: Array<{ diff?: { content: string }; tests: Array<{ status: string }> }>
    }>(`/api/runs/${runId.slice(0, 8)}`)
    expect(detail.jobId).toBe(r.job.id)
    expect(detail.attempts[0]?.diff?.content).toContain('toLowerCase')
    expect(detail.attempts[0]?.tests[0]?.status).toBe('passed')
    expect(detail.attempts[1]?.tests[0]?.status).toBe('failed')
  })

  it('places a bet, records a review, and resolves the call in odds', async () => {
    expect((await ok<{ pick: string }>('POST', `/api/runs/${runId}/bet`, { pick: 'a' })).pick).toBe(
      'A',
    )
    await ok('POST', `/api/runs/${runId}/review`, {
      preferred: 'A',
      accepted: true,
      reason: 'tests pass',
    })
    expect((await send('POST', `/api/runs/${runId}/bet`, { pick: 'B' })).status).toBe(400) // bets come before reviews
    const odds = await j<{ models: unknown[]; calls: { total: number; hits: number } }>('/api/odds')
    expect(odds.models).toHaveLength(2)
    expect(odds.calls).toMatchObject({ total: 1, hits: 1 })
    expect((await send('GET', '/api/odds?category=nonsense')).status).toBe(400)
  })

  it('previews and applies an attempt with a backup, and can diff A against B', async () => {
    const original = await readFile(join(repo, 'src/search.js'), 'utf8')
    const preview = await j<{
      applies: boolean
      files: string[]
      patchBytes: number
      patch?: string
    }>(`/api/runs/${runId}/apply/A`)
    expect(preview).toMatchObject({ applies: true, files: ['src/search.js'] })
    expect(preview.patchBytes).toBeGreaterThan(0)
    expect(preview.patch).toBeUndefined()
    const applied = await ok<{ application: { backupRef: string; files: string[] } }>(
      'POST',
      `/api/runs/${runId}/apply`,
      { label: 'A' },
    )
    expect(await readFile(join(repo, 'src/search.js'), 'utf8')).toBe(FIXED)
    expect(sh(repo, 'git', ['show', `${applied.application.backupRef}:src/search.js`])).toBe(
      original,
    )
    sh(repo, 'git', ['checkout', '--', 'src/search.js'])
    const ab = await j<{ from: string; to: string; patch: string }>(`/api/runs/${runId}/compare`)
    expect(ab).toMatchObject({ from: 'A', to: 'B' })
    expect(ab.patch).toContain('diff --git')
  })

  it('checks out an attempt, cleans worktrees, and suggests memories', async () => {
    const co = await ok<{ path: string }>('POST', `/api/runs/${runId}/checkout`, { label: 'B' })
    expect(existsSync(join(co.path, 'src/search.js'))).toBe(true)
    const cleaned = await ok<{ removed: string[] }>('POST', '/api/clean')
    expect(cleaned.removed).toContain(co.path)
    expect(existsSync(co.path)).toBe(false)
    const s = await j<{ candidates: string[] }>(`/api/runs/${runId}/memory-suggestions`)
    expect(s.candidates.some((c) => c.includes('Always keep search case-insensitive'))).toBe(true)
    const saved = await ok<{ source: string }>('POST', '/api/memory', {
      text: s.candidates[0],
      source: 'suggestion',
    })
    expect(saved.source).toBe('suggestion')
  })

  it('adds, searches, and removes memory', async () => {
    const entry = await ok<{ id: string; tags: string[]; scope: string }>('POST', '/api/memory', {
      text: 'Public API responses use camelCase',
      tags: 'api, style',
      global: true,
    })
    expect(entry).toMatchObject({ tags: ['api', 'style'], scope: 'global' })
    expect(await j<unknown[]>('/api/memory?q=camelCase')).toHaveLength(1)
    expect(await j<unknown[]>('/api/memory?scope=global')).toHaveLength(1)
    expect(await j<unknown[]>('/api/memory')).toHaveLength(2)
    await ok('DELETE', `/api/memory/${entry.id}`)
    expect(await j<unknown[]>('/api/memory?q=camelCase')).toHaveLength(0)
    expect((await send('DELETE', `/api/memory/${entry.id}`)).status).toBe(404)
  })

  it('reports context, policy, doctor and models', async () => {
    const ctx = await j<{ items: unknown[]; rendered: string }>('/api/context?task=search')
    expect(ctx.items.length).toBeGreaterThan(0)
    expect(typeof ctx.rendered).toBe('string')
    const pol = await j<{
      checks: Array<{ allowed: boolean; needsApproval?: boolean }>
      enforcement: unknown[]
      models: unknown[]
    }>('/api/policy?model=alpha&command=rm%20-rf%20dist')
    expect(pol.models).toHaveLength(2)
    expect(pol.checks[0]).toMatchObject({ allowed: true })
    expect(pol.checks[1]).toMatchObject({ allowed: true, needsApproval: true })
    expect(pol.enforcement.length).toBeGreaterThan(3)
    const doc = await j<{ checks: Array<{ level: string; title: string }> }>('/api/doctor')
    expect(doc.checks.find((c) => c.title.startsWith('Node'))?.level).toBe('ok')
    const models = await j<{
      runtime: { available: boolean }
      models: Array<{ eligible: boolean }>
    }>('/api/models')
    expect(models.runtime.available).toBe(true)
    expect(models.models.filter((m) => m.eligible)).toHaveLength(2)
  })

  it('reruns with the original context', async () => {
    const dry = await ok<{ plan: { contextMode: string }; notes: string[] }>(
      'POST',
      `/api/runs/${runId}/rerun`,
      { dryRun: true },
    )
    expect(dry.plan.contextMode).toBe('original')
    expect(dry.notes.some((n) => n.includes('ORIGINAL'))).toBe(true)
    const r = await ok<{ job: Job }>('POST', `/api/runs/${runId}/rerun`, { context: 'original' })
    const job = await waitJob(r.job.id, done)
    expect(job.runStatus).toBe('completed')
    const detail = await j<{ run: { parentRunId?: string; contextMode: string } }>(
      `/api/runs/${job.runId}`,
    )
    expect(detail.run.parentRunId).toBe(runId)
    expect(detail.run.contextMode).toBe('original')
  })

  it('refuses a second concurrent job and cancels a hanging one', async () => {
    current = hanging
    const r = await ok<{ job: Job }>('POST', '/api/jobs', {
      kind: 'run',
      task: 'hang',
      models: ['fakeai/alpha'],
    })
    const again = await send('POST', '/api/jobs', { kind: 'run', task: 'again' })
    expect(again.status).toBe(400)
    expect(((await again.json()) as { error: string }).error).toContain('still running')
    const cancelled = await ok<Job>('POST', `/api/jobs/${r.job.id}/cancel`)
    expect(cancelled.cancelling).toBe(true)
    const job = await waitJob(r.job.id, done)
    expect(job.runStatus).toBe('cancelled')
    expect((await j<{ run: { status: string } }>(`/api/runs/${job.runId}`)).run.status).toBe(
      'cancelled',
    )
    current = normal
  })

  it('routes approval requests from single runs to the browser', async () => {
    current = new ApprovingRuntime()
    const r = await ok<{ job: Job }>('POST', '/api/jobs', {
      kind: 'run',
      task: 'needs approval',
      models: ['fakeai/alpha'],
    })
    const asked = await waitJob(r.job.id, (job) => job.approvals.length === 1)
    const approval = asked.approvals[0]
    expect(approval?.decision).toBeUndefined()
    await ok('POST', `/api/jobs/${r.job.id}/approvals/${approval?.id}`, { allow: true })
    expect(
      (await send('POST', `/api/jobs/${r.job.id}/approvals/${approval?.id}`, { allow: true }))
        .status,
    ).toBe(400)
    const job = await waitJob(r.job.id, done)
    expect(job.approvals[0]).toMatchObject({ decision: 'allowed', decidedBy: 'user' })
    const detail = await j<{ attempts: Array<{ attempt: { summary: string } }> }>(
      `/api/runs/${job.runId}`,
    )
    expect(detail.attempts[0]?.attempt.summary).toBe('approved')
    current = normal
  })

  it('stays a viewer when started read-only', async () => {
    const project = await resolveProject(repo, process.env)
    const ro = createUiServer(
      { project, storage: openStorage({ path: ':memory:' }) },
      { env: process.env, readonly: true, loadRuntime: async () => normal },
    )
    await new Promise<void>((r) => ro.listen(0, '127.0.0.1', () => r()))
    const roBase = `http://127.0.0.1:${(ro.address() as AddressInfo).port}`
    try {
      expect(
        ((await (await fetch(`${roBase}/api/project`)).json()) as { readonly: boolean }).readonly,
      ).toBe(true)
      const r = await fetch(`${roBase}/api/memory`, {
        method: 'POST',
        headers: { 'x-sidebet-token': ro.token, 'content-type': 'application/json' },
        body: '{"text":"x"}',
      })
      expect(r.status).toBe(405)
    } finally {
      ro.close()
    }
  })
})
