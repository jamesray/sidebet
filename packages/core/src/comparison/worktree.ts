import { existsSync } from 'node:fs'
import { mkdir, symlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { ProjectContext } from '../config/load.js'
import { worktreesDir } from '../config/paths.js'
import {
  commitTree,
  git,
  headCommit,
  snapshotTree,
  statusLines,
  updateRef,
  worktreeAdd,
  worktreeRemove,
} from '../git/git.js'
import { exec, SidebetError } from '../util/exec.js'

export const baseRef = (runId: string): string => `refs/sidebet/runs/${runId}/base`
export const attemptRef = (runId: string, label: string): string =>
  `refs/sidebet/runs/${runId}/${label}`
export const backupRef = (runId: string, stamp: string): string =>
  `refs/sidebet/backups/${runId}-${stamp}`

export interface CompareBase {
  commit: string
  /** True when the base is a synthetic commit capturing uncommitted changes. */
  snapshotted: boolean
  dirtyFiles: string[]
}

/**
 * Pick the commit every attempt starts from, without touching the user's working tree or index.
 * Clean tree: HEAD. Dirty tree: a synthetic commit of the working state (tracked and untracked,
 * non-ignored files) on top of HEAD, kept alive by a ref. `uncommitted: refuse` stops instead.
 */
export const prepareCompareBase = async (
  project: ProjectContext,
  runId: string,
): Promise<CompareBase> => {
  const root = project.root
  const dirtyFiles = (await statusLines(root)).map((l) => l.slice(3))
  const head = await headCommit(root)
  const exclude = project.config.compare.linkPaths
  if (dirtyFiles.length > 0 && project.config.compare.uncommitted === 'refuse') {
    throw new SidebetError(
      `Your working tree has ${dirtyFiles.length} uncommitted change(s), and compare.uncommitted is "refuse":\n${dirtyFiles
        .slice(0, 10)
        .map((f) => `  ${f}`)
        .join('\n')}`,
      'Commit or stash them, or set compare.uncommitted to "snapshot" in .sidebet/config.json.',
    )
  }
  const tree = await snapshotTree(root, exclude)
  const headTree = head ? (await git(root, ['rev-parse', `${head}^{tree}`])).trim() : undefined
  if (head && tree === headTree) {
    await updateRef(root, baseRef(runId), head)
    return { commit: head, snapshotted: false, dirtyFiles }
  }
  const commit = await commitTree(root, tree, `sidebet: working tree snapshot for ${runId}`, head)
  await updateRef(root, baseRef(runId), commit)
  return { commit, snapshotted: true, dirtyFiles }
}

export const worktreePathFor = (project: ProjectContext, runId: string, label: string): string =>
  join(worktreesDir(project.projectId), `${runId}-${label}`)

export const createWorktree = async (
  project: ProjectContext,
  runId: string,
  label: string,
  commit: string,
): Promise<string> => {
  const path = worktreePathFor(project, runId, label)
  await mkdir(dirname(path), { recursive: true })
  await worktreeAdd(project.root, path, commit)
  for (const link of project.config.compare.linkPaths) {
    const source = join(project.root, link)
    const target = join(path, link)
    if (existsSync(source) && !existsSync(target)) {
      await mkdir(dirname(target), { recursive: true })
      await symlink(source, target, 'dir')
    }
  }
  return path
}

export const runSetup = async (
  command: string,
  cwd: string,
  signal?: AbortSignal,
): Promise<void> => {
  const r = await exec('sh', ['-c', command], {
    cwd,
    signal,
    detached: true,
    timeoutMs: 10 * 60_000,
  })
  if (r.code !== 0) {
    throw new SidebetError(
      `compare.setup failed (exit ${r.code}) in ${cwd}:\n${(r.stderr || r.stdout).trim().slice(-800)}`,
    )
  }
}

export const removeWorktree = async (project: ProjectContext, path: string): Promise<void> => {
  await worktreeRemove(project.root, path)
}
