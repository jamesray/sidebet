import {
  type AttemptDetail,
  type ContextSnapshot,
  type ExecutionPlan,
  modelRef,
  type ProjectContext,
  type RunDetail,
  type RuntimeInfo,
  summarizeContext,
} from '@sidebet/core'
import { printMetrics } from './metrics.js'
import { formatCost, formatDuration, formatTokens, plural, table, truncate, type Ui } from './ui.js'

export const testSummary = (a: AttemptDetail): string => {
  const t = a.tests[0]
  if (!t) return 'not run'
  if (t.status === 'skipped') return `skipped${t.note ? ` (${t.note})` : ''}`
  const counts =
    t.passed !== undefined ? ` (${t.passed} passed${t.failed ? `, ${t.failed} failed` : ''})` : ''
  return `${t.status}${counts}`
}

export const statusColor = (ui: Ui, status: string): string => {
  if (status === 'completed' || status === 'passed') return ui.green(status)
  if (status === 'failed' || status === 'timeout' || status === 'error') return ui.red(status)
  if (status === 'partial' || status === 'cancelled' || status === 'skipped')
    return ui.yellow(status)
  return status
}

export const attemptLine = (ui: Ui, a: AttemptDetail, index = 0): string[] => {
  const at = a.attempt
  const files = at.changedFiles.length
  const lane = ui.p.lane(index)
  const parts = [
    `${ui.bold(lane(at.label))}  ${lane(modelRef({ provider: at.provider, id: at.model }))}`,
    statusColor(ui, at.status),
    `${plural(files, 'file')} changed`,
    `tests: ${testSummary(a)}`,
    formatDuration(at.durationMs),
    a.usage ? `${plural(a.usage.turns, 'turn')}, ${plural(a.usage.toolCalls, 'tool')}` : '',
    a.usage ? `${formatTokens(a.usage.totalTokens)} tokens` : 'usage n/a',
    a.usage?.costUsd !== undefined ? formatCost(a.usage.costUsd) : 'cost n/a',
  ]
  return parts
}

export const printRunSummary = (
  ui: Ui,
  detail: RunDetail,
  options: { next?: boolean } = {},
): void => {
  const { run } = detail
  ui.out()
  ui.out(
    `${ui.bold(ui.accent(run.kind === 'compare' ? 'Compare' : 'Run'))} ${ui.dim(run.id)}  ${statusColor(ui, run.status)}${run.readonly ? ui.dim('  read-only') : ''}`,
  )
  ui.out(`${ui.dim('task')}  ${truncate(run.task, 120)}`)
  ui.out()
  for (const line of table(detail.attempts.map((a, i) => attemptLine(ui, a, i))))
    ui.out(`  ${line}`)
  for (const a of detail.attempts) {
    if (a.attempt.error) ui.out(ui.red(`  ${a.attempt.label}: ${truncate(a.attempt.error, 200)}`))
    const denied = a.toolEvents.filter((e) => e.decision === 'denied')
    if (denied.length > 0)
      ui.out(
        ui.yellow(`  ${a.attempt.label}: ${plural(denied.length, 'tool call')} blocked by policy`),
      )
  }
  if (run.kind === 'compare') {
    ui.out()
    printMetrics(ui, detail)
    for (const a of detail.attempts) {
      if (!a.attempt.summary) continue
      ui.out()
      ui.out(
        ui.bold(ui.p.lane(detail.attempts.indexOf(a))(`${a.attempt.label}  ${a.attempt.model}`)),
      )
      ui.out(
        a.attempt.summary
          .split('\n')
          .slice(0, 8)
          .map((l) => `  ${l}`)
          .join('\n'),
      )
    }
  }
  if (options.next !== false) {
    ui.out()
    if (run.kind === 'compare')
      ui.out(
        `${ui.dim('next')}  ${ui.accent(`sidebet review ${run.id}`)}   ${ui.dim('your working tree was not modified')}`,
      )
    else if (detail.attempts[0]?.attempt.changedFiles.length)
      ui.out(`${ui.dim('next')}  ${ui.accent(`sidebet runs diff ${run.id}`)}`)
  }
}

export const contextLines = (ui: Ui, s: ContextSnapshot, verbose: boolean): string[] => {
  const sum = summarizeContext(s)
  const lines: string[] = []
  const group = (title: string, items: string[]): void => {
    if (items.length === 0) return
    lines.push(ui.bold(title))
    for (const i of items) lines.push(`  ${i}`)
    lines.push('')
  }
  group('Rules', [...sum.native.map((n) => `${n} ${ui.dim('(loaded by Pi)')}`), ...sum.rules])
  group('Documentation', [...sum.docs, ...sum.taskFiles])
  if (sum.memoryIncluded > 0 || sum.memoryOmitted > 0) {
    lines.push(ui.bold('Memory'))
    lines.push(
      `  ${plural(sum.memoryIncluded, 'relevant entry', 'relevant entries')}${sum.memoryOmitted ? ui.dim(` (${sum.memoryOmitted} not relevant to this task)`) : ''}`,
    )
    lines.push('')
  }
  group('Skills', sum.skills)
  if (sum.omitted.length > 0)
    group(
      'Omitted',
      sum.omitted.map((o) => `${o.source} ${ui.dim(`- ${o.reason}`)}`),
    )
  lines.push(
    `Estimated context: ${formatTokens(sum.estimatedTokens)} tokens ${ui.dim(`(${formatTokens(s.injectedTokens)} injected by Sidebet, ${formatTokens(s.nativeTokens)} loaded by the runtime, budget ${formatTokens(s.budgetTokens)})`)}`,
  )
  if (verbose) {
    lines.push('')
    lines.push(ui.bold('Why each item'))
    for (const i of s.items)
      lines.push(
        `  ${i.delivery.padEnd(8)} ${i.kind.padEnd(7)} ${i.source}  ${ui.dim(`~${i.tokens}t - ${i.reason}`)}`,
      )
  }
  return lines
}

export const printPlan = (
  ui: Ui,
  plan: ExecutionPlan,
  project: ProjectContext,
  info: RuntimeInfo,
): void => {
  ui.out(ui.bold('Dry run: nothing will be executed, no model will be called, nothing is saved.'))
  ui.out()
  const mode =
    plan.kind === 'compare'
      ? `compare in isolated Git worktrees (${plan.models.length} attempts, concurrency ${Math.min(plan.concurrency, plan.models.length)}, timeout ${formatDuration(plan.timeoutMs)} each)`
      : plan.readonly
        ? 'read-only run (write tools are not exposed)'
        : 'run in your working tree'
  const rows: string[][] = [
    ['Task', plan.task],
    ['Mode', mode],
    ...plan.models.map((m, i): string[] => [i === 0 ? 'Models' : '', modelRef(m)]),
    ['Model basis', plan.modelBasis],
    ['Runtime', `${info.id}${info.version ? ` ${info.version}` : ''}`],
    ['Tools', plan.tools.join(', ') || '(none)'],
    ['Tests', plan.runTests ? (plan.testCommand ?? 'none configured') : 'not run (use --test)'],
    [
      'Context mode',
      plan.contextMode === 'original'
        ? 'original snapshot (replay)'
        : 'assembled now from current files and memory',
    ],
    ['Policy', project.policyVersion],
  ]
  for (const l of table(rows)) ui.out(l)
  ui.out()
  for (const l of contextLines(ui, plan.snapshot, true)) ui.out(l)
  const pol = project.policy
  ui.out()
  ui.out(ui.bold('Policy decisions'))
  ui.out(`  protected paths: ${pol.protectedPaths.join(', ') || '(none)'}`)
  ui.out(
    `  approval required (bash): ${pol.approvalRequired.bash.length} pattern(s); denied automatically when no human can approve`,
  )
  if (plan.rejectedModels.length > 0) {
    ui.out('  models excluded:')
    for (const r of plan.rejectedModels) ui.out(`    ${r.ref}: ${r.reason}`)
  }
  if (plan.kind === 'compare' && plan.dirtyFiles.length > 0) {
    ui.out()
    ui.out(
      `Working tree has ${plural(plan.dirtyFiles.length, 'uncommitted change')}: attempts would start from a snapshot that includes them (${project.config.compare.uncommitted === 'refuse' ? ui.red('but compare.uncommitted=refuse would stop here') : 'your files stay untouched'}).`,
    )
  }
  for (const w of plan.warnings) ui.out(ui.yellow(`warning: ${w}`))
  ui.out()
  ui.out(
    ui.dim(
      `Note: ${plural(plan.snapshot.items.filter((i) => i.delivery === 'injected').length, 'item')} would be injected, estimates use ~4 characters per token.`,
    ),
  )
}
