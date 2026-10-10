import { type CliContext, openApp, openRuntime } from '../app.js'
import { parse } from '../args.js'
import { planFor, requireTask, runPlan } from './execution.js'

export const compareCommand = async (ctx: CliContext, args: string[]): Promise<number> => {
  const { values, positionals } = parse(args, {
    models: { type: 'string' },
    readonly: { type: 'boolean' },
    'dry-run': { type: 'boolean' },
    context: { type: 'string', multiple: true },
    timeout: { type: 'string' },
    concurrency: { type: 'string' },
    'keep-worktrees': { type: 'boolean' },
    json: { type: 'boolean' },
  })
  const task = requireTask(positionals, 'compare')
  const app = await openApp(ctx)
  try {
    const { runtime, info } = await openRuntime(ctx)
    const plan = await planFor(app, info, {
      kind: 'compare',
      task,
      models: values.models
        ?.split(',')
        .map((s) => s.trim())
        .filter(Boolean),
      readonly: values.readonly,
      taskFiles: values.context,
      timeoutSec: values.timeout ? Number(values.timeout) : undefined,
      concurrency: values.concurrency ? Number(values.concurrency) : undefined,
    })
    return await runPlan(ctx, app, runtime, info, plan, {
      dryRun: values['dry-run'],
      keepWorktrees: values['keep-worktrees'],
      json: values.json,
    })
  } finally {
    app.close()
  }
}
