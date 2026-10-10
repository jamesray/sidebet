import { createInterface } from 'node:readline/promises'
import {
  type AgentRuntime,
  type ExecutionPlan,
  executePlan,
  planExecution,
  type RunDetail,
  type RuntimeInfo,
  SidebetError,
} from '@sidebet/core'
import type { App, CliContext } from '../app.js'
import { createLiveReporter } from '../live.js'
import { printPlan, printRunSummary } from '../present.js'
import { createReporter } from '../reporter.js'

const LABELS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'

export const interactiveApprover = (ctx: CliContext) =>
  ctx.interactive
    ? async (req: { tool: string; summary: string; reason: string }): Promise<boolean> => {
        const rl = createInterface({ input: process.stdin, output: process.stderr })
        try {
          const a = await rl.question(
            `\nSidebet approval needed: ${req.tool} ${req.summary}\n  (${req.reason})\nAllow? [y/N] `,
          )
          return /^y(es)?$/i.test(a.trim())
        } finally {
          rl.close()
        }
      }
    : undefined

export interface RunRequest {
  kind: 'run' | 'compare'
  task: string
  models?: string[]
  readonly?: boolean
  dryRun?: boolean
  runTests?: boolean
  timeoutSec?: number
  concurrency?: number
  taskFiles?: string[]
  keepWorktrees?: boolean
  parentRunId?: string
}

export const planFor = (
  app: App,
  runtimeInfo: RuntimeInfo,
  req: RunRequest,
): Promise<ExecutionPlan> =>
  planExecution({
    project: app.project,
    runtimeInfo,
    storage: app.storage,
    kind: req.kind,
    task: req.task,
    models: req.models,
    readonly: req.readonly,
    taskFiles: req.taskFiles,
    runTests: req.runTests,
    timeoutSec: req.timeoutSec,
    concurrency: req.concurrency,
    env: undefined,
  })

/** Shared by run, compare and rerun: print the plan or execute it and summarise. */
export const runPlan = async (
  ctx: CliContext,
  app: App,
  runtime: AgentRuntime,
  info: RuntimeInfo,
  plan: ExecutionPlan,
  options: { dryRun?: boolean; parentRunId?: string; keepWorktrees?: boolean; json?: boolean },
): Promise<number> => {
  const { ui } = ctx
  if (options.dryRun) {
    if (options.json) {
      ui.out(
        JSON.stringify(
          {
            dryRun: true,
            plan: {
              ...plan,
              snapshot: {
                ...plan.snapshot,
                items: plan.snapshot.items.map(({ content: _c, ...rest }) => rest),
              },
            },
          },
          null,
          2,
        ),
      )
    } else {
      printPlan(ui, plan, app.project, info)
    }
    return 0
  }
  if (options.keepWorktrees) app.project.config.compare.keepWorktrees = true
  const basic = createReporter(ui, { streamText: plan.kind === 'run' })
  const live =
    plan.kind === 'compare' && (!ui.json || ui.verbose)
      ? createLiveReporter(
          ui,
          plan.models.map((m, i) => ({
            label: LABELS[i] ?? String(i + 1),
            model: `${m.provider}/${m.id}`,
          })),
          basic,
        )
      : undefined
  const reporter = live ?? basic
  for (const w of plan.warnings) reporter.warn(w)
  if (plan.kind === 'compare')
    reporter.info(`Comparing ${plan.models.map((m) => `${m.provider}/${m.id}`).join(' vs ')}`)
  const detail: RunDetail = await executePlan(
    {
      storage: app.storage,
      runtime,
      runtimeInfo: info,
      project: app.project,
      reporter,
      signal: ctx.signal,
      approve: plan.kind === 'run' ? interactiveApprover(ctx) : undefined,
    },
    plan,
    { parentRunId: options.parentRunId },
  ).finally(() => live?.stop())
  if (options.json) {
    ui.out(JSON.stringify(detail, null, 2))
  } else {
    ui.err('')
    printRunSummary(ui, detail)
  }
  if (ctx.signal.aborted) return 130
  return detail.run.status === 'failed' || detail.run.status === 'cancelled' ? 1 : 0
}

export const requireTask = (positionals: string[], what: string): string => {
  const task = positionals.join(' ').trim()
  if (!task)
    throw new SidebetError(
      `${what} needs a task.`,
      `Example: sidebet ${what} "Fix the failing tests"`,
    )
  return task
}
