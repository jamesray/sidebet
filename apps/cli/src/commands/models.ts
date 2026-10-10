import { evaluateModel, modelRef } from '@sidebet/core'
import { type CliContext, openApp, openRuntime } from '../app.js'
import { parse } from '../args.js'
import { table } from '../ui.js'

/** Models you are logged into in Pi, with aliases and policy eligibility. */
export const modelsCommand = async (ctx: CliContext, args: string[]): Promise<number> => {
  const { values } = parse(args, { json: { type: 'boolean' } })
  const { ui } = ctx
  const app = await openApp(ctx)
  try {
    const { info } = await openRuntime(ctx)
    const aliases = app.project.config.models.aliases
    const byRef = new Map(Object.entries(aliases).map(([a, r]) => [r, a]))
    const rows = info.models.map((m) => {
      const d = evaluateModel(app.project.policy, m)
      return {
        ref: modelRef(m),
        name: m.name,
        alias: byRef.get(modelRef(m)),
        eligible: d.allowed,
        reason: d.allowed ? undefined : d.reason,
        isDefault: info.defaultModel === modelRef(m),
      }
    })
    if (values.json) {
      ui.out(JSON.stringify({ runtime: info.id, models: rows, aliases }, null, 2))
      return 0
    }
    if (rows.length === 0) {
      ui.out('No models with credentials in Pi. Run `pi` and /login, or set a provider API key.')
      return 1
    }
    ui.out(ui.bold(`Models available through ${info.id} (${rows.length})`))
    ui.out()
    for (const l of table(
      rows.map((r) => [
        r.ref,
        [r.isDefault ? 'default' : '', r.alias ? `alias: ${r.alias}` : '']
          .filter(Boolean)
          .join(', '),
        r.eligible ? ui.green('eligible') : ui.red(`denied: ${r.reason}`),
      ]),
    ))
      ui.out(`  ${l}`)
    ui.out()
    ui.out(
      ui.dim(
        'Use any of these with --model/--models (provider/id, bare id, unique substring, or alias).',
      ),
    )
    ui.out(
      ui.dim(
        'Set models.compare and models.aliases in .sidebet/config.json; run.dual=true makes plain `sidebet run` show two models side by side.',
      ),
    )
    return 0
  } finally {
    app.close()
  }
}
