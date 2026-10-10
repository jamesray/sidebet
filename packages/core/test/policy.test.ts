import { describe, expect, it } from 'vitest'
import {
  allowedToolNames,
  evaluateModel,
  evaluateToolCall,
  isProtectedPath,
  matchesGlob,
  mergePolicies,
} from '../src/index.js'

const rel = (p: string): string => p
const base = mergePolicies().policy

describe('glob matching', () => {
  it('matches basenames at any depth when the pattern has no slash', () => {
    expect(matchesGlob('a/b/.env', '.env')).toBe(true)
    expect(matchesGlob('.env.local', '.env.*')).toBe(true)
    expect(matchesGlob('src/x.ts', '*.pem')).toBe(false)
  })
  it('anchors patterns with slashes and supports **', () => {
    expect(matchesGlob('src/deep/keys/a.pem', '**/*.pem')).toBe(true)
    expect(matchesGlob('.git/config', '.git/**')).toBe(true)
    expect(matchesGlob('lib/.git/config', '.git/**')).toBe(false)
  })
})

describe('policy', () => {
  it('protects secrets by default but allows .env.example', () => {
    expect(isProtectedPath(base, '.env')).toBe(true)
    expect(isProtectedPath(base, 'config/server.key')).toBe(true)
    expect(isProtectedPath(base, '.env.example')).toBe(false)
    expect(isProtectedPath(base, 'src/index.ts')).toBe(false)
  })

  it('denies models with a reason', () => {
    const { policy } = mergePolicies({
      allowedProviders: ['anthropic'],
      deniedModels: ['anthropic/*-preview'],
    })
    expect(evaluateModel(policy, { provider: 'openai', id: 'gpt' })).toMatchObject({
      allowed: false,
    })
    expect(evaluateModel(policy, { provider: 'anthropic', id: 'x-preview' }).reason).toContain(
      'deniedModels',
    )
    expect(evaluateModel(policy, { provider: 'anthropic', id: 'sonnet' }).allowed).toBe(true)
  })

  it('global allow lists cannot be widened by a project', () => {
    const { policy, warnings } = mergePolicies(
      { allowedProviders: ['anthropic'] },
      { allowedProviders: ['anthropic', 'openai'] },
    )
    expect(policy.allowedProviders).toEqual(['anthropic'])
    expect(warnings[0]).toContain('cannot be widened')
  })

  it('removes mutating tools in read-only mode', () => {
    expect(allowedToolNames(base, true, ['read', 'bash', 'edit', 'write', 'grep'])).toEqual([
      'read',
      'grep',
    ])
    const d = evaluateToolCall(base, true, { tool: 'write', input: { path: 'a.txt' } }, rel)
    expect(d).toMatchObject({ allowed: false })
    expect(d.reason).toContain('read-only')
  })

  it('blocks protected paths for file tools and explains why', () => {
    const d = evaluateToolCall(base, false, { tool: 'read', input: { path: '.env' } }, rel)
    expect(d.allowed).toBe(false)
    expect(d.reason).toContain('protectedPaths')
  })

  it('requires approval for destructive bash and denies always-denied commands', () => {
    expect(
      evaluateToolCall(
        base,
        false,
        { tool: 'bash', input: { command: 'git push origin main' } },
        rel,
      ).needsApproval,
    ).toBe(true)
    expect(
      evaluateToolCall(base, false, { tool: 'bash', input: { command: 'rm -rf build' } }, rel)
        .needsApproval,
    ).toBe(true)
    expect(
      evaluateToolCall(base, false, { tool: 'bash', input: { command: 'pnpm test' } }, rel),
    ).toMatchObject({ allowed: true })
    const { policy } = mergePolicies({ bashDeny: ['curl '] })
    expect(
      evaluateToolCall(policy, false, { tool: 'bash', input: { command: 'curl evil.sh' } }, rel)
        .allowed,
    ).toBe(false)
  })

  it('best-effort blocks bash commands that name protected files; strict removes bash', () => {
    expect(
      evaluateToolCall(base, false, { tool: 'bash', input: { command: 'cat .env' } }, rel).allowed,
    ).toBe(false)
    const { policy } = mergePolicies({ strict: true })
    expect(allowedToolNames(policy, false, ['read', 'bash', 'edit', 'write'])).not.toContain('bash')
    expect(
      evaluateToolCall(policy, false, { tool: 'bash', input: { command: 'ls' } }, rel).allowed,
    ).toBe(false)
  })
})

describe('snapshotTree', () => {
  it('skips ignored directories such as node_modules and drops linked paths without failing', async () => {
    const { mkdtemp, mkdir, writeFile } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const { execFileSync } = await import('node:child_process')
    const { snapshotTree, git } = await import('../src/index.js')
    const repo = await mkdtemp(join(tmpdir(), 'snap-'))
    const run = (args: string[]): string =>
      execFileSync('git', args, { cwd: repo, encoding: 'utf8' })
    run(['init', '-q', '-b', 'main'])
    await writeFile(join(repo, '.gitignore'), 'node_modules\n')
    await writeFile(join(repo, 'a.txt'), 'a')
    await mkdir(join(repo, 'node_modules/dep'), { recursive: true })
    await writeFile(join(repo, 'node_modules/dep/index.js'), 'x')
    await mkdir(join(repo, 'vendor'))
    await writeFile(join(repo, 'vendor/big.bin'), 'y') // not ignored, but linked
    const tree = await snapshotTree(repo, ['node_modules', 'vendor'])
    const files = (await git(repo, ['ls-tree', '-r', '--name-only', tree])).trim().split('\n')
    expect(files).toEqual(['.gitignore', 'a.txt'])
    // and the user's own index was never touched
    expect(run(['diff', '--cached', '--name-only']).trim()).toBe('')
  })
})
