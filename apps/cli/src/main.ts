import { SidebetError } from '@sidebet/core'
import type { CliContext } from './app.js'
import { HELP, VERSION } from './help.js'
import { header } from './style/banner.js'
import { createUi } from './ui.js'

type Handler = (ctx: CliContext, args: string[]) => Promise<number>

const commands: Record<string, () => Promise<Handler>> = {
  init: async () => (await import('./commands/init.js')).initCommand,
  run: async () => (await import('./commands/run.js')).runCommand,
  compare: async () => (await import('./commands/compare.js')).compareCommand,
  review: async () => (await import('./commands/review.js')).reviewCommand,
  runs: async () => (await import('./commands/runs.js')).runsCommand,
  rerun: async () => (await import('./commands/rerun.js')).rerunCommand,
  odds: async () => (await import('./commands/odds.js')).oddsCommand,
  context: async () => (await import('./commands/context.js')).contextCommand,
  memory: async () => (await import('./commands/memory.js')).memoryCommand,
  policy: async () => (await import('./commands/policy.js')).policyCommand,
  doctor: async () => (await import('./commands/doctor.js')).doctorCommand,
  models: async () => (await import('./commands/models.js')).modelsCommand,
  clean: async () => (await import('./commands/clean.js')).cleanCommand,
  bet: async () => (await import('./commands/bet.js')).betCommand,
}

/** Pull global flags out of argv wherever they appear. */
const extractGlobals = (
  argv: string[],
): { rest: string[]; json: boolean; verbose: boolean; noColor: boolean; cwd?: string } => {
  const rest: string[] = []
  let json = false
  let verbose = false
  let noColor = false
  let cwd: string | undefined
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string
    if (a === '--verbose' || a === '-v') verbose = true
    else if (a === '--no-color') noColor = true
    else if (a === '--cwd') cwd = argv[++i]
    else if (a === '--json') {
      json = true
      rest.push(a)
    } else rest.push(a)
  }
  return { rest, json, verbose, noColor, cwd }
}

export const main = async (
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> => {
  const g = extractGlobals(argv)
  const ui = createUi({ json: g.json, verbose: g.verbose, color: !g.noColor, env })
  const [name, ...args] = g.rest
  if (!name || name === 'help' || name === '-h' || name === '--help') {
    if (ui.color) {
      for (const l of header(ui.p, VERSION, { hint: 'sidebet <command> --help' })) ui.out(l)
      ui.out()
    }
    ui.out(HELP)
    return 0
  }
  if (name === '--version' || name === '-V') {
    if (ui.color) for (const l of header(ui.p, VERSION)) ui.out(l)
    else ui.out(VERSION)
    return 0
  }
  const load = commands[name]
  if (!load) {
    ui.err(`Unknown command "${name}". Run \`sidebet help\`.`)
    return 2
  }

  const controller = new AbortController()
  let interrupts = 0
  const onSigint = (): void => {
    interrupts += 1
    if (interrupts === 1) {
      ui.err(
        ui.yellow(
          '\nCancelling: stopping agents and cleaning up (press Ctrl+C again to force quit)...',
        ),
      )
      controller.abort()
    } else process.exit(130)
  }
  process.on('SIGINT', onSigint)
  process.on('SIGTERM', onSigint)

  const ctx: CliContext = {
    cwd: g.cwd ?? process.cwd(),
    env,
    ui,
    signal: controller.signal,
    cancel: () => onSigint(),
    interactive:
      Boolean(process.stdin.isTTY && process.stdout.isTTY) && !g.json && env.CI === undefined,
  }
  if (args.includes('--help') || args.includes('-h')) {
    ui.out(HELP)
    return 0
  }
  try {
    const handler = await load()
    return await handler(ctx, args)
  } catch (err) {
    if (err instanceof SidebetError) {
      ui.err(ui.red(`error: ${err.message}`))
      if (err.hint) ui.err(ui.dim(`hint: ${err.hint}`))
    } else {
      ui.err(ui.red(`error: ${err instanceof Error ? err.message : String(err)}`))
      if (g.verbose && err instanceof Error && err.stack) ui.err(err.stack)
    }
    return controller.signal.aborted ? 130 : 1
  } finally {
    process.off('SIGINT', onSigint)
    process.off('SIGTERM', onSigint)
  }
}
