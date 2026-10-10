import { existsSync } from 'node:fs'
import { readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { git, resolveProject, worktreeRemove, worktreesDir } from '@sidebet/core'
import type { CliContext } from '../app.js'

/** Remove Sidebet's leftover worktrees for this project. Run records, refs and diffs are kept. */
export const cleanCommand = async (ctx: CliContext): Promise<number> => {
  const project = await resolveProject(ctx.cwd, ctx.env)
  const dir = worktreesDir(project.projectId, ctx.env)
  const entries = existsSync(dir) ? await readdir(dir) : []
  for (const e of entries) {
    const p = join(dir, e)
    await worktreeRemove(project.root, p)
    await rm(p, { recursive: true, force: true })
    ctx.ui.out(`removed ${p}`)
  }
  await git(project.root, ['worktree', 'prune'], { allowFail: true })
  ctx.ui.out(
    entries.length
      ? `Cleaned ${entries.length} worktree(s). Attempt results remain available through refs/sidebet/runs/*.`
      : 'Nothing to clean.',
  )
  return 0
}
