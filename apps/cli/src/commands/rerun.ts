import { loadRunDetail, planRerun, resolveRun, SidebetError } from '@sidebet/core'
import { type CliContext, openApp, openRuntime } from '../app.js'
import { parse } from '../args.js'
import { runPlan } from './execution.js'

export const rerunCommand = async (ctx: CliContext, args: string[]): Promise<number> => {
  const { values, positionals } = parse(args, {
    'original-context': { type: 'boolean' },
    'current-context': { type: 'boolean' },
    models: { type: 'string' },
    readonly: { type: 'boolean' },
    'dry-run': { type: 'boolean' },
    json: { type: 'boolean' },
  })
  const { ui } = ctx
  if (!positionals[0])
    throw new SidebetError(
      'rerun needs a run id.',
      'Example: sidebet rerun run_1a2b3c4d --current-context',
    )
  if (values['original-context'] && values['current-context']) {
    throw new SidebetError('Choose one of --original-context or --current-context.')
  }
  const app = await openApp(ctx)
  try {
    const { runtime, info } = await openRuntime(ctx)
    const original = loadRunDetail(app.storage, resolveRun(app.storage, positionals[0]))
    const rp = await planRerun(app.storage, app.project, info, original, {
      context: values['current-context'] ? 'current' : 'original',
      models: values.models?.split(',').map((s) => s.trim()),
      readonly: values.readonly,
    })
    if (!values.json) {
      ui.err(ui.bold(`Rerunning ${original.run.id}`))
      for (const n of rp.notes) ui.err(`  - ${n}`)
      ui.err('')
    }
    return await runPlan(ctx, app, runtime, info, rp.plan, {
      dryRun: values['dry-run'],
      parentRunId: rp.parentRunId,
      json: values.json,
    })
  } finally {
    app.close()
  }
}
