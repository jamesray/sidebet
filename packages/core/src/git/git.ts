import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type ExecOptions, exec, SidebetError } from '../util/exec.js'

export class GitError extends SidebetError {
  readonly args: string[]
  readonly stderr: string
  constructor(args: string[], stderr: string) {
    super(`git ${args.slice(0, 3).join(' ')} failed: ${stderr.trim() || 'unknown error'}`)
    this.name = 'GitError'
    this.args = args
    this.stderr = stderr
  }
}

const INTERNAL_IDENTITY = {
  GIT_AUTHOR_NAME: 'Sidebet',
  GIT_AUTHOR_EMAIL: 'sidebet@localhost',
  GIT_COMMITTER_NAME: 'Sidebet',
  GIT_COMMITTER_EMAIL: 'sidebet@localhost',
}

export interface GitOptions extends Pick<ExecOptions, 'input' | 'signal' | 'env'> {
  allowFail?: boolean
}

export const git = async (
  cwd: string,
  args: string[],
  options: GitOptions = {},
): Promise<string> => {
  const result = await exec('git', args, {
    cwd,
    input: options.input,
    signal: options.signal,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...options.env },
  })
  if (result.code !== 0 && !options.allowFail) throw new GitError(args, result.stderr)
  return result.stdout
}

export const gitOk = async (cwd: string, args: string[]): Promise<boolean> => {
  const r = await exec('git', args, { cwd })
  return r.code === 0
}

export const isGitAvailable = async (): Promise<boolean> => {
  try {
    const r = await exec('git', ['--version'])
    return r.code === 0
  } catch {
    return false
  }
}

export const repoRoot = async (cwd: string): Promise<string | undefined> => {
  try {
    const out = await git(cwd, ['rev-parse', '--show-toplevel'])
    return out.trim() || undefined
  } catch {
    return undefined
  }
}

export const headCommit = async (cwd: string): Promise<string | undefined> => {
  const out = await git(cwd, ['rev-parse', '--verify', '-q', 'HEAD'], { allowFail: true })
  return out.trim() || undefined
}

export const currentBranch = async (cwd: string): Promise<string | undefined> => {
  const out = await git(cwd, ['symbolic-ref', '--short', '-q', 'HEAD'], { allowFail: true })
  return out.trim() || undefined
}

export const statusLines = async (cwd: string): Promise<string[]> => {
  const out = await git(cwd, ['status', '--porcelain=v1', '-uall'])
  return out.split('\n').filter(Boolean)
}

const excludeSpecs = (exclude: string[]): string[] => exclude.map((p) => `:(exclude,glob)${p}`)

/**
 * Write a tree object for the current working tree (tracked + untracked, honouring .gitignore)
 * using a private temporary index, so the user's index and files are never touched.
 */
export const snapshotTree = async (cwd: string, exclude: string[] = []): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), 'sidebet-index-'))
  const env = { GIT_INDEX_FILE: join(dir, 'index') }
  try {
    const head = await headCommit(cwd)
    if (head) await git(cwd, ['read-tree', head], { env })
    await git(cwd, ['add', '-A', '--', '.', ...excludeSpecs(exclude)], { env })
    return (await git(cwd, ['write-tree'], { env })).trim()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

export const commitTree = async (
  cwd: string,
  tree: string,
  message: string,
  parent?: string,
): Promise<string> => {
  const args = ['commit-tree', tree, '-m', message]
  if (parent) args.push('-p', parent)
  return (await git(cwd, args, { env: INTERNAL_IDENTITY })).trim()
}

export const updateRef = async (cwd: string, ref: string, commit: string): Promise<void> => {
  await git(cwd, ['update-ref', ref, commit])
}

export const deleteRef = async (cwd: string, ref: string): Promise<void> => {
  await git(cwd, ['update-ref', '-d', ref], { allowFail: true })
}

export const refExists = (cwd: string, ref: string): Promise<boolean> =>
  gitOk(cwd, ['rev-parse', '--verify', '-q', `${ref}^{commit}`])

export const diffPatch = async (cwd: string, from: string, to: string): Promise<string> =>
  git(cwd, ['diff', '--binary', '--full-index', '--no-color', '--no-ext-diff', from, to])

export const diffNames = async (cwd: string, from: string, to: string): Promise<string[]> => {
  const out = await git(cwd, ['diff', '--name-only', '--no-renames', '-z', from, to])
  return out.split('\0').filter(Boolean)
}

export const diffStat = async (
  cwd: string,
  from: string,
  to: string,
): Promise<{ added: number; removed: number }> => {
  const out = await git(cwd, ['diff', '--numstat', '--no-renames', from, to])
  let added = 0
  let removed = 0
  for (const line of out.split('\n')) {
    const [a, r] = line.split('\t')
    // binary files show "-"
    if (a && a !== '-') added += Number(a)
    if (r && r !== '-') removed += Number(r)
  }
  return { added, removed }
}

export const patchFiles = async (cwd: string, patch: string): Promise<string[]> => {
  const out = await git(cwd, ['apply', '--numstat', '-z', '-'], { input: patch })
  // numstat -z: "added\tdeleted\tpath\0" for non-renames
  return out
    .split('\0')
    .filter(Boolean)
    .map((e) => e.split('\t').slice(2).join('\t'))
    .filter(Boolean)
}

export const applyCheck = async (
  cwd: string,
  patch: string,
): Promise<{ ok: boolean; error?: string }> => {
  const r = await exec('git', ['apply', '--check', '--whitespace=nowarn', '-'], {
    cwd,
    input: patch,
  })
  return r.code === 0 ? { ok: true } : { ok: false, error: r.stderr.trim() }
}

export const applyPatch = async (cwd: string, patch: string): Promise<void> => {
  await git(cwd, ['apply', '--whitespace=nowarn', '-'], { input: patch })
}

export const worktreeAdd = async (cwd: string, path: string, commit: string): Promise<void> => {
  await git(cwd, ['worktree', 'add', '--detach', '--quiet', path, commit])
}

export const worktreeRemove = async (cwd: string, path: string): Promise<void> => {
  await git(cwd, ['worktree', 'remove', '--force', path], { allowFail: true })
  await git(cwd, ['worktree', 'prune'], { allowFail: true })
}

export const worktreeList = async (cwd: string): Promise<string[]> => {
  const out = await git(cwd, ['worktree', 'list', '--porcelain'])
  return out
    .split('\n')
    .filter((l) => l.startsWith('worktree '))
    .map((l) => l.slice('worktree '.length))
}
