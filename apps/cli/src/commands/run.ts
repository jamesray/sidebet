import { type CliContext, openApp, openRuntime } from '../app.js'
import { parse } from '../args.js'
import { planFor, requireTask, runPlan } from './execution.js'

export const runCommand = async (ctx: CliContext, args: string[]): Promise<number> => {
  const { values, positionals } = parse(args, {
    model: { type: 'string', short: 'm' },
    models: { type: 'string' },
    dual: { type: 'boolean' },
    single: { type: 'boolean' },
    readonly: { type: 'boolean' },
    'dry-run': { type: 'boolean' },
    test: { type: 'boolean' },
    context: { type: 'string', multiple: true },
    timeout: { type: 'string' },
    json: { type: 'boolean' },
  })
  const task = requireTask(positionals, 'run')
  const app = await openApp(ctx)
  try {
    const { runtime, info } = await openRuntime(ctx)
    const named = values.models
      ?.split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    // Dual output: two or more named models, --dual, or run.dual=true in config (unless --single / --model).
    const explicitSingle = Boolean(values.single || values.model)
    const dual =
      !explicitSingle &&
      Boolean(values.dual || (named && named.length > 1) || app.project.config.run.dual)
    if (dual) {
      const plan = await planFor(app, info, {
        kind: 'compare',
        task,
        models: named,
        readonly: values.readonly,
        taskFiles: values.context,
        timeoutSec: values.timeout ? Number(values.timeout) : undefined,
      })
      return await runPlan(ctx, app, runtime, info, plan, {
        dryRun: values['dry-run'],
        json: values.json,
      })
    }
    const plan = await planFor(app, info, {
      kind: 'run',
      task,
      models: values.model ? [values.model] : named,
      readonly: values.readonly,
      runTests: values.test,
      taskFiles: values.context,
      timeoutSec: values.timeout ? Number(values.timeout) : undefined,
    })
    return await runPlan(ctx, app, runtime, info, plan, {
      dryRun: values['dry-run'],
      json: values.json,
    })
  } finally {
    app.close()
  }
}
