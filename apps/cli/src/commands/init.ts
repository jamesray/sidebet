import { existsSync } from 'node:fs'
import { createInterface } from 'node:readline/promises'
import type { RuntimeInfo } from '@sidebet/core'
import {
  discoverProject,
  modelRef,
  newProjectId,
  projectConfigPath,
  readJsonFile,
  repoRoot,
  resolveProject,
  SidebetError,
  writeProjectConfig,
} from '@sidebet/core'
import { type CliContext, loadRuntime } from '../app.js'
import { parse } from '../args.js'
import { plural, table } from '../ui.js'

export const initCommand = async (ctx: CliContext, args: string[]): Promise<number> => {
  const { values } = parse(args, { force: { type: 'boolean' }, json: { type: 'boolean' } })
  const { ui } = ctx
  const root = await repoRoot(ctx.cwd)
  if (!root) {
    throw new SidebetError(
      `${ctx.cwd} is not inside a Git repository.`,
      'Run `git init` first, then `sidebet init`.',
    )
  }

  // Runtime detection never blocks init: a missing Pi is reported, not fatal.
  let runtimeInfo: RuntimeInfo | undefined
  let runtimeError: string | undefined
  try {
    runtimeInfo = await (await loadRuntime(ctx.env)).detect()
  } catch (err) {
    runtimeError = err instanceof Error ? err.message : String(err)
  }
  const found = await discoverProject(root, runtimeInfo)
  const configPath = projectConfigPath(root)
  const alreadyInitialized = existsSync(configPath)

  let wrote = false
  if (!alreadyInitialized) {
    const config: Record<string, unknown> = {
      version: 1,
      projectId: newProjectId(),
      name: found.name,
    }
    if (found.testCommand) config.tests = { command: found.testCommand }
    if (found.compareSetup) {
      config.compare = { linkPaths: found.compareSetup.linkPaths, setup: found.compareSetup.setup }
    }
    await writeProjectConfig(root, config)
    wrote = true
  } else if (values.force) {
    // --force is the explicit approval to refresh detected values; the project id is always preserved.
    const existing = ((await readJsonFile(configPath)) ?? {}) as Record<string, unknown>
    const merged: Record<string, unknown> = { ...existing, version: 1, name: found.name }
    if (found.testCommand && !(existing.tests as { command?: string } | undefined)?.command) {
      merged.tests = {
        ...((existing.tests as object | undefined) ?? {}),
        command: found.testCommand,
      }
    }
    await writeProjectConfig(root, merged)
    wrote = true
  }

  const project = await resolveProject(root, ctx.env)
  const models = runtimeInfo?.models ?? []
  if (values.json) {
    ui.out(
      JSON.stringify(
        {
          initialized: true,
          wrote,
          alreadyInitialized,
          project: { id: project.projectId, name: project.name, root },
          discovered: found,
          runtime: runtimeInfo
            ? {
                id: runtimeInfo.id,
                version: runtimeInfo.version,
                models: models.map(modelRef),
                defaultModel: runtimeInfo.defaultModel,
                problems: runtimeInfo.problems,
              }
            : null,
        },
        null,
        2,
      ),
    )
    return 0
  }

  ui.out(
    alreadyInitialized && !wrote
      ? ui.bold('Sidebet is already initialized (nothing changed)')
      : ui.bold('Sidebet initialized'),
  )
  ui.out()
  const rows: string[][] = [['Project', found.name]]
  if (runtimeInfo)
    rows.push([
      'Runtime',
      `${runtimeInfo.id === 'pi' ? 'Pi' : runtimeInfo.id} ${runtimeInfo.version ?? ''}`.trim(),
    ])
  if (found.languages.length > 0) rows.push(['Language', found.languages.join(', ')])
  if (found.packageManager) rows.push(['Package mgr', found.packageManager])
  if (found.agentsMd) rows.push(['Rules', 'AGENTS.md detected'])
  if (found.rulesFiles.length > 0)
    rows.push(['Sidebet rules', plural(found.rulesFiles.length, 'file')])
  if (models.length > 0)
    rows.push([
      'Models',
      `${models.length} available${runtimeInfo?.defaultModel ? ` (default ${runtimeInfo.defaultModel})` : ''}`,
    ])
  if (found.skills.length > 0) rows.push(['Skills', `${found.skills.length} detected`])
  const testCommand = project.config.tests.command ?? found.testCommand
  if (testCommand) rows.push(['Tests', testCommand])
  if (found.compareSetup) rows.push(['Worktrees', found.compareSetup.reason])
  for (const l of table(rows)) ui.out(l)

  const problems: string[] = []
  if (runtimeError) problems.push(`Could not load the Pi runtime: ${runtimeError}`)
  if (runtimeInfo && models.length === 0)
    problems.push(
      'Pi has no models with credentials yet. Run `pi` and /login (or set ANTHROPIC_API_KEY / OPENAI_API_KEY), then `sidebet doctor`.',
    )
  if (!testCommand)
    problems.push(
      'No test command detected. Set tests.command in .sidebet/config.json so `compare` can run your tests.',
    )
  if (models.length === 1)
    problems.push(
      'Only one model is available; `sidebet compare` needs two (add another provider in Pi, or use --models).',
    )
  if (wrote)
    ui.out(`\nWrote ${configPath.replace(`${root}/`, '')} (commit it to share the project id)`)
  if (problems.length > 0) {
    ui.out()
    for (const p of problems) ui.out(ui.yellow(`! ${p}`))
  }
  if (problems.length === 0 || models.length > 0) {
    ui.out()
    ui.out("You're ready.")
    ui.out()
    ui.out(`  ${ui.cyan('sidebet run')} "Explain this repository"`)
    if (models.length >= 2) ui.out(`  ${ui.cyan('sidebet compare')} "Improve the search handler"`)
  }
  return 0
}

export const confirm = async (question: string): Promise<boolean> => {
  if (!process.stdin.isTTY) return false
  const rl = createInterface({ input: process.stdin, output: process.stderr })
  try {
    const a = (await rl.question(`${question} [y/N] `)).trim().toLowerCase()
    return a === 'y' || a === 'yes'
  } finally {
    rl.close()
  }
}
