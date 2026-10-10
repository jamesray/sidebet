import { existsSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { ProjectContext } from '@sidebet/core'
import {
  dbPath,
  git,
  isGitAvailable,
  modelRef,
  resolveProject,
  SidebetError,
  worktreeList,
  worktreesDir,
} from '@sidebet/core'
import { type CliContext, loadRuntime } from '../app.js'
import { parse } from '../args.js'

type Level = 'ok' | 'warn' | 'fail'
interface Check {
  level: Level
  title: string
  detail?: string
}

export const doctorCommand = async (ctx: CliContext, args: string[]): Promise<number> => {
  const { values } = parse(args, { json: { type: 'boolean' } })
  const { ui } = ctx
  const checks: Check[] = []
  const add = (level: Level, title: string, detail?: string): void =>
    void checks.push({ level, title, detail })

  const [maj = 0, min = 0] = process.versions.node.split('.').map(Number)
  if (maj > 22 || (maj === 22 && min >= 19)) add('ok', `Node ${process.versions.node}`)
  else
    add(
      'fail',
      `Node ${process.versions.node}`,
      'Sidebet needs Node 22.19+ (built-in SQLite; required by Pi 1.x).',
    )

  if (await isGitAvailable())
    add(
      'ok',
      `Git ${(await git(ctx.cwd, ['--version']).catch(() => '')).trim().replace('git version ', '')}`,
    )
  else add('fail', 'Git not found on PATH')

  let project: ProjectContext | undefined
  try {
    project = await resolveProject(ctx.cwd, ctx.env)
    add(
      'ok',
      `Repository ${project.root}`,
      project.initialized ? `project ${project.name} (${project.projectId})` : undefined,
    )
    if (!project.initialized)
      add('warn', 'Not initialized', 'Run `sidebet init` (optional: defaults work without it).')
    add(
      'ok',
      `Config valid (${project.sources.length || 'no'} file(s))`,
      project.sources.join(', ') || undefined,
    )
    for (const w of project.policyWarnings) add('warn', 'Policy', w)
    if (!project.config.tests.command)
      add(
        'warn',
        'No tests.command',
        'compare cannot run tests until you set one in .sidebet/config.json.',
      )
    else add('ok', `Tests: ${project.config.tests.command}`)
  } catch (err) {
    add(
      err instanceof SidebetError && /not inside a Git/.test(err.message) ? 'warn' : 'fail',
      'Project',
      err instanceof Error ? err.message : String(err),
    )
  }

  const path = dbPath(ctx.env)
  try {
    const { openStorage, inspectStorage } = await import('@sidebet/storage-local')
    openStorage({ path }).close()
    const h = inspectStorage(path)
    add(
      h.fts5 ? 'ok' : 'fail',
      `Storage ${path}`,
      `layout v${h.layoutVersion}, FTS5 ${h.fts5 ? 'available' : 'MISSING (memory search will not work)'}, ${h.runs} run(s), ${h.memories} memories`,
    )
  } catch (err) {
    add('fail', `Storage ${path}`, err instanceof Error ? err.message : String(err))
  }

  try {
    const info = await (await loadRuntime(ctx.env)).detect()
    add(
      info.available ? 'ok' : 'fail',
      `Runtime ${info.id}${info.version ? ` ${info.version}` : ''}`,
      info.configDir ? `config: ${info.configDir}` : undefined,
    )
    if (info.models.length > 0) {
      const byProvider = new Map<string, number>()
      for (const m of info.models) byProvider.set(m.provider, (byProvider.get(m.provider) ?? 0) + 1)
      add(
        'ok',
        `${info.models.length} model(s) with credentials`,
        [...byProvider].map(([p, n]) => `${p}: ${n}`).join(', '),
      )
      if (info.models.length < 2)
        add(
          'warn',
          'Only one model available',
          'compare needs two (log in to another provider in Pi).',
        )
      if (info.defaultModel) add('ok', `Default model ${info.defaultModel}`)
      if (project) {
        const bad = info.models.filter(
          (m) =>
            !project.policy.allowedProviders ||
            project.policy.allowedProviders.includes(m.provider),
        ).length
        if (bad === 0)
          add('fail', 'Policy excludes every available model', 'Run `sidebet policy check`.')
      }
    }
    for (const p of info.problems) add('fail', 'Runtime', p)
    for (const n of info.notes) add('warn', 'Runtime', n)
    void modelRef
  } catch (err) {
    add('fail', 'Runtime pi failed to load', err instanceof Error ? err.message : String(err))
  }

  if (project) {
    const dir = worktreesDir(project.projectId, ctx.env)
    const leftovers = existsSync(dir) ? await readdir(dir).catch(() => []) : []
    const registered = new Set((await worktreeList(project.root).catch(() => [])).map((p) => p))
    const stale = leftovers.filter((d) => !registered.has(join(dir, d)))
    if (leftovers.length > 0)
      add(
        'warn',
        `${leftovers.length} leftover Sidebet worktree(s)`,
        `${stale.length} unregistered. Run \`sidebet clean\`.`,
      )
    else add('ok', 'No leftover worktrees')
  }

  if (values.json) {
    ui.out(JSON.stringify({ checks }, null, 2))
  } else {
    for (const c of checks) {
      const mark =
        c.level === 'ok' ? ui.green('✓') : c.level === 'warn' ? ui.yellow('!') : ui.red('✗')
      ui.out(`${mark} ${c.title}${c.detail ? ui.dim(`  ${c.detail}`) : ''}`)
    }
    const fails = checks.filter((c) => c.level === 'fail').length
    ui.out()
    ui.out(fails ? ui.red(`${fails} problem(s) found.`) : ui.green('No blocking problems.'))
  }
  return checks.some((c) => c.level === 'fail') ? 1 : 0
}
