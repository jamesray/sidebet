import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'
import { makeRepo, sh } from '../../../tests/helpers.js'

const bin = fileURLToPath(new URL('../dist/bin.js', import.meta.url))
const FIXED =
  'export const search = (items, query) => items.filter((i) => i.name.toLowerCase().includes(query.toLowerCase()))\n'

let repo: string
let env: NodeJS.ProcessEnv

const script = {
  models: [
    { provider: 'fakeai', id: 'alpha' },
    { provider: 'other', id: 'beta' },
  ],
  scripts: {
    'fakeai/alpha': {
      files: { 'src/search.js': FIXED },
      summary: 'Made it case-insensitive.',
      usage: { inputTokens: 1000, outputTokens: 200, costUsd: 0.02 },
    },
    'other/beta': { files: { 'src/search.js': 'export const search = () => []\n' }, delayMs: 200 },
  },
}

const sb = (args: string[], extra: NodeJS.ProcessEnv = {}, input?: string) => {
  const r = spawnSync('node', [bin, ...args], {
    cwd: repo,
    env: { ...env, ...extra },
    encoding: 'utf8',
    input,
  })
  return { code: r.status, out: r.stdout, err: r.stderr }
}
const json = <T>(args: string[]): T => JSON.parse(sb([...args, '--json']).out) as T

beforeAll(async () => {
  expect(existsSync(bin), 'build the CLI first: pnpm build').toBe(true)
  const made = await makeRepo()
  repo = made.repo
  const scriptPath = join(await mkdtemp(join(tmpdir(), 'sb-script-')), 'fake.json')
  await writeFile(scriptPath, JSON.stringify(script))
  env = {
    ...process.env,
    SIDEBET_HOME: made.home,
    SIDEBET_RUNTIME: 'fake',
    SIDEBET_FAKE_SCRIPT: scriptPath,
    NO_COLOR: '1',
    CI: '1',
  }
})

describe('sidebet CLI (built, real git repo, offline runtime)', () => {
  it('prints help and rejects unknown commands with exit code 2', () => {
    expect(sb(['help']).out).toContain('compare "<task>"')
    const r = sb(['frobnicate'])
    expect(r.code).toBe(2)
    expect(r.err).toContain('Unknown command')
  })

  it('init detects the project, writes minimal config, and is idempotent', async () => {
    const first = sb(['init'])
    expect(first.code).toBe(0)
    expect(first.out).toContain('Sidebet initialized')
    expect(first.out).toContain('AGENTS.md detected')
    expect(first.out).toContain('2 available')
    expect(first.out).toContain('npm test')
    expect(first.out).not.toMatch(/\u001b\[/) // NO_COLOR
    const cfg = JSON.parse(await readFile(join(repo, '.sidebet/config.json'), 'utf8')) as {
      projectId: string
      tests: { command: string }
    }
    expect(cfg.tests.command).toBe('npm test')
    const second = sb(['init'])
    expect(second.out).toContain('already initialized')
    expect(JSON.parse(await readFile(join(repo, '.sidebet/config.json'), 'utf8'))).toEqual(cfg)
    sh(repo, 'git', ['add', '-A'])
    sh(repo, 'git', ['commit', '-qm', 'sidebet'])
  })

  it('fails clearly outside a git repository', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'not-git-'))
    const r = spawnSync('node', [bin, 'run', 'x'], { cwd: dir, env, encoding: 'utf8' })
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('not inside a Git repository')
  })

  it('memory: add, list, search, remove (project scope) and shows up in context', () => {
    expect(sb(['memory', 'add', 'Public API responses use camelCase', '--tag', 'api']).code).toBe(0)
    sb(['memory', 'add', '--global', 'Prefer small commits'])
    expect(sb(['memory', 'list']).out).toContain('camelCase')
    expect(sb(['memory', 'search', 'camelcase']).out).toContain('camelCase')
    expect(sb(['memory', 'search', 'zzzz']).out).toContain('No memories')
    const ctx = sb(['context', '--task', 'add endpoint'])
    expect(ctx.out).toContain('Context for search-service')
    expect(ctx.out).toContain('AGENTS.md')
    expect(ctx.out).toContain('2 relevant entries')
    const snap = json<{ rendered: string }>(['context', '--task', 'x'])
    expect(snap.rendered).toContain('camelCase')
    const list = json<Array<{ id: string }>>(['memory', 'list'])
    expect(list).toHaveLength(2)
    expect(sb(['memory', 'remove', list[1]?.id ?? '']).code).toBe(0)
    expect(json<unknown[]>(['memory', 'list'])).toHaveLength(1)
  })

  it('run --dry-run shows the plan and starts nothing', () => {
    const r = sb(['run', 'Fix search', '--dry-run'])
    expect(r.code).toBe(0)
    expect(r.out).toContain('Dry run')
    expect(r.out).toContain('fakeai/alpha')
    expect(r.out).toContain('AGENTS.md')
    expect(r.out).toContain('protected paths')
    expect(sb(['runs']).out).toContain('No runs yet')
  })

  it('run --readonly cannot write; run executes and records', async () => {
    const ro = sb(['run', 'Explain the repo', '--readonly'])
    expect(ro.code).toBe(0)
    expect(ro.out).toContain('read-only')
    expect(ro.err).toContain('blocked')
    expect(sh(repo, 'git', ['status', '--porcelain'])).toBe('')
    const r = sb(['run', 'Fix search', '--model', 'alpha'])
    expect(r.code).toBe(0)
    expect(r.out).toContain('1 file changed')
    expect(await readFile(join(repo, 'src/search.js'), 'utf8')).toBe(FIXED)
    sh(repo, 'git', ['checkout', '--', '.'])
  })

  it('compare leaves the working tree alone; review selects and applies safely', async () => {
    const r = sb(['compare', 'Make search case-insensitive', '--json'])
    expect(r.code).toBe(0)
    const detail = JSON.parse(r.out) as {
      run: { id: string; status: string }
      attempts: Array<{ attempt: { label: string }; tests: Array<{ status: string }> }>
    }
    expect(detail.run.status).toBe('completed')
    expect(detail.attempts.map((a) => a.tests[0]?.status)).toEqual(['passed', 'failed'])
    expect(sh(repo, 'git', ['status', '--porcelain'])).toBe('')

    const review = sb(['review', detail.run.id])
    expect(review.out).toContain('Sidebet Review')
    expect(review.out).toContain('A: fakeai/alpha')
    expect(review.out).toContain('B: other/beta')
    expect(review.out).toContain('Time to first edit')
    expect(review.out).toContain('Lines +/-')
    expect(review.out).toContain('not reported') // beta has no cost; never estimated
    expect(sb(['review', detail.run.id, '--diff', 'B']).out).toContain(
      '+export const search = () => []',
    )
    expect(
      sb(['review', detail.run.id, '--select', 'A', '--accept', '--reason', 'tests pass']).out,
    ).toContain('Recorded review')

    const noConfirm = sb(['review', detail.run.id, '--apply', 'A'])
    expect(noConfirm.code).toBe(1)
    expect(sh(repo, 'git', ['status', '--porcelain'])).toBe('')
    const applied = sb(['review', detail.run.id, '--apply', 'A', '--yes'])
    expect(applied.code).toBe(0)
    expect(applied.out).toContain('refs/sidebet/runs')
    expect(await readFile(join(repo, 'src/search.js'), 'utf8')).toBe(FIXED)
    sh(repo, 'git', ['checkout', '--', '.'])
  })

  it('run history: list, show, diff, rerun with explicit context choice', () => {
    const runs = json<Array<{ run: { id: string; kind: string } }>>(['runs'])
    const compare = runs.find((r) => r.run.kind === 'compare')
    expect(compare).toBeDefined()
    const id = compare?.run.id ?? ''
    expect(sb(['runs']).out).toContain(id)
    const show = sb(['runs', 'show', id])
    expect(show.out).toContain('Policy version')
    expect(show.out).toContain('Context snapshot')
    expect(show.out).toContain('accepted')
    expect(sb(['runs', 'diff', id, 'A']).out).toContain('toLowerCase')
    expect(sb(['context', 'inspect', id]).out).toContain('Why each item')
    const dry = sb(['rerun', id, '--dry-run'])
    expect(dry.err).toContain('ORIGINAL snapshot')
    expect(dry.err).toContain('not guaranteed')
    const cur = sb(['rerun', id, '--current-context', '--dry-run'])
    expect(cur.err).toContain('CURRENT')
    const both = sb(['rerun', id, '--current-context', '--original-context'])
    expect(both.code).toBe(1)
    const real = sb(['rerun', id, '--json'])
    expect(JSON.parse(real.out).run.parentRunId).toBe(id)
  })

  it('odds reports counts, keeps tests and preference separate, and never invents cost', () => {
    const r = sb(['odds'])
    expect(r.out).toContain('Sidebet Odds')
    expect(r.out).toContain('fakeai/alpha')
    expect(r.out).toContain('Tests passed (objective)')
    expect(r.out).toContain('Preferred (human)')
    expect(r.out).toContain('Head-to-head')
    const data = json<{
      models: Array<{ model: string; medianCostUsd?: number; costReported: number }>
    }>(['odds'])
    const beta = data.models.find((m) => m.model === 'other/beta')
    expect(beta?.medianCostUsd).toBeUndefined()
  })

  it('dual mode: --models with two names runs a compare from `run`; aliases work', async () => {
    const r = JSON.parse(sb(['run', 'Dual task', '--models', 'alpha,beta', '--json']).out) as {
      run: { kind: string }
      attempts: unknown[]
    }
    expect(r.run.kind).toBe('compare')
    expect(r.attempts).toHaveLength(2)
    const cfgPath = join(repo, '.sidebet/config.json')
    const cfg = JSON.parse(await readFile(cfgPath, 'utf8')) as Record<string, unknown>
    await writeFile(
      cfgPath,
      JSON.stringify({
        ...cfg,
        models: { aliases: { fast: 'fakeai/alpha' }, compare: ['fast', 'other/beta'] },
        run: { dual: true },
      }),
    )
    const auto = JSON.parse(sb(['run', 'Auto dual', '--json']).out) as { run: { kind: string } }
    expect(auto.run.kind).toBe('compare')
    const single = JSON.parse(sb(['run', 'Force single', '--single', '--json']).out) as {
      run: { kind: string }
    }
    expect(single.run.kind).toBe('run')
    expect(sb(['models']).out).toContain('alias: fast')
    sh(repo, 'git', ['checkout', '--', '.'])
    await writeFile(cfgPath, `${JSON.stringify(cfg, null, 2)}\n`)
  })

  it('policy check explains denials; doctor reports health', async () => {
    expect(sb(['policy', 'check', '--tool', 'read', '--path', '.env']).out).toContain(
      'protected path',
    )
    expect(sb(['policy', 'check', '--command', 'git push']).out).toContain('needs human approval')
    expect(sb(['policy', 'check', '--command', 'pnpm test']).code).toBe(0)
    expect(sb(['policy', 'check', '--tool', 'read', '--path', '.env']).code).toBe(1)
    const full = sb(['policy', 'check'])
    expect(full.out).toContain('What is enforced, and how')
    expect(full.out).toContain('partial')
    const cfgPath = join(repo, '.sidebet/config.json')
    const cfg = JSON.parse(await readFile(cfgPath, 'utf8')) as Record<string, unknown>
    await writeFile(cfgPath, JSON.stringify({ ...cfg, policy: { allowedProviders: ['fakeai'] } }))
    expect(sb(['policy', 'check', '--model', 'other/beta']).out).toContain('allowedProviders')
    const denied = sb(['run', 'x', '--model', 'other/beta'])
    expect(denied.code).toBe(1)
    expect(denied.err).toContain('denied by policy')
    await writeFile(cfgPath, `${JSON.stringify(cfg, null, 2)}\n`)
    const doc = sb(['doctor'])
    expect(doc.out).toContain('FTS5 available')
    expect(doc.out).toContain('Runtime fake')
  })

  it('Ctrl+C cancels a running compare, cleans worktrees and records the run as cancelled', async () => {
    const hangScript = join(await mkdtemp(join(tmpdir(), 'sb-hang-')), 'hang.json')
    await writeFile(
      hangScript,
      JSON.stringify({
        models: script.models,
        scripts: { 'fakeai/alpha': { hang: true }, 'other/beta': { hang: true } },
      }),
    )
    const child = spawn('node', [bin, 'compare', 'hang forever', '--timeout', '60'], {
      cwd: repo,
      env: { ...env, SIDEBET_FAKE_SCRIPT: hangScript },
    })
    let stderr = ''
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString()
    })
    await new Promise((r) => setTimeout(r, 2500))
    child.kill('SIGINT')
    const code = await new Promise<number | null>((resolve) => child.on('close', resolve))
    expect(code).toBe(130)
    expect(stderr).toContain('Cancelling')
    expect(sh(repo, 'git', ['worktree', 'list']).trim().split('\n')).toHaveLength(1)
    expect(sb(['runs', '--status', 'cancelled']).out).toContain('hang forever')
    expect(sh(repo, 'git', ['status', '--porcelain'])).toBe('')
  })
})
