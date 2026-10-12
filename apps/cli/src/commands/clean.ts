import { existsSync } from 'node:fs'
import { readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import {
  git,
  type ProjectContext,
  resolveProject,
  worktreeRemove,
  worktreesDir,
} from '@sidebet/core'
import type { CliContext } from '../app.js'

/** Remove Sidebet's leftover worktrees for a project; returns the removed paths. Refs and diffs are kept. */
export const cleanWorktrees = async (
  project: ProjectContext,
  env: NodeJS.ProcessEnv,
): Promise<string[]> => {
  const dir = worktreesDir(project.projectId, env)
  const entries = existsSync(dir) ? await readdir(dir) : []
  const removed: string[] = []
  for (const e of entries) {
    const p = join(dir, e)
    await worktreeRemove(project.root, p)
    await rm(p, { recursive: true, force: true })
    removed.push(p)
  }
  await git(project.root, ['worktree', 'prune'], { allowFail: true })
  return removed
}

/** Remove Sidebet's leftover worktrees for this project. Run records, refs and diffs are kept. */
export const cleanCommand = async (ctx: CliContext): Promise<number> => {
  const project = await resolveProject(ctx.cwd, ctx.env)
  const removed = await cleanWorktrees(project, ctx.env)
  for (const p of removed) ctx.ui.out(`removed ${p}`)
  ctx.ui.out(
    removed.length
      ? `Cleaned ${removed.length} worktree(s). Attempt results remain available through refs/sidebet/runs/*.`
      : 'Nothing to clean.',
  )
  return 0
}
