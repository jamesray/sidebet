import type { AttemptDetail, RunDetail } from '@sidebet/core'
import { statusColor, testSummary } from './present.js'
import { formatCost, formatDuration, formatTokens, table, type Ui } from './ui.js'

const ms = formatDuration
const rate = (tokens?: number, durationMs?: number): string =>
  tokens === undefined || !durationMs ? '-' : `${(tokens / (durationMs / 1000)).toFixed(1)} tok/s`

interface Row {
  label: string
  value: (a: AttemptDetail) => string
  /** Pick a "best" column to highlight: lower or higher wins. Only numeric rows. */
  best?: { of: (a: AttemptDetail) => number | undefined; prefer: 'lower' | 'higher' }
  /** Printed under the table once, explaining what the row does and does not mean. */
  note?: string
}

const rows: Row[] = [
  { label: 'Status', value: (a) => a.attempt.status },
  {
    label: 'Total time',
    value: (a) => formatDuration(a.attempt.durationMs),
    best: { of: (a) => a.attempt.durationMs, prefer: 'lower' },
    note: 'Total time includes worktree setup and tests; agent time is the model+tools loop only.',
  },
  {
    label: 'Agent time',
    value: (a) => formatDuration(a.usage?.agentDurationMs),
    best: { of: (a) => a.usage?.agentDurationMs, prefer: 'lower' },
  },
  {
    label: 'Time to first token',
    value: (a) => ms(a.usage?.timeToFirstTokenMs),
    best: { of: (a) => a.usage?.timeToFirstTokenMs, prefer: 'lower' },
  },
  {
    label: 'Time to first edit',
    value: (a) => ms(a.usage?.timeToFirstEditMs),
    best: { of: (a) => a.usage?.timeToFirstEditMs, prefer: 'lower' },
  },
  { label: 'Turns', value: (a) => (a.usage ? String(a.usage.turns) : '-') },
  {
    label: 'Tool calls',
    value: (a) => {
      if (!a.usage) return '-'
      const by = Object.entries(a.usage.toolCallsByTool)
        .sort((x, y) => y[1] - x[1])
        .map(([t, n]) => `${t} ${n}`)
        .join(', ')
      return `${a.usage.toolCalls}${by ? ` (${by})` : ''}`
    },
  },
  {
    label: 'Tool errors / blocked',
    value: (a) => (a.usage ? `${a.usage.toolErrors} / ${a.usage.toolsDenied}` : '-'),
  },
  {
    label: 'Input tokens',
    value: (a) => formatTokens(a.usage?.inputTokens),
    best: { of: (a) => a.usage?.inputTokens, prefer: 'lower' },
  },
  {
    label: 'Output tokens',
    value: (a) => formatTokens(a.usage?.outputTokens),
    best: { of: (a) => a.usage?.outputTokens, prefer: 'lower' },
  },
  {
    label: 'Cache read / write',
    value: (a) =>
      a.usage
        ? `${formatTokens(a.usage.cacheReadTokens)} / ${formatTokens(a.usage.cacheWriteTokens)}`
        : '-',
  },
  {
    label: 'Total tokens',
    value: (a) => formatTokens(a.usage?.totalTokens),
    best: { of: (a) => a.usage?.totalTokens, prefer: 'lower' },
  },
  { label: 'Output speed', value: (a) => rate(a.usage?.outputTokens, a.usage?.agentDurationMs) },
  {
    label: 'Cost',
    value: (a) => (a.usage?.costUsd !== undefined ? formatCost(a.usage.costUsd) : 'not reported'),
    best: { of: (a) => a.usage?.costUsd, prefer: 'lower' },
    note: 'Cost is what the runtime reported; subscription logins often report none, and nothing is estimated.',
  },
  { label: 'Files changed', value: (a) => String(a.attempt.changedFiles.length) },
  {
    label: 'Lines +/-',
    value: (a) =>
      a.attempt.linesAdded === undefined
        ? '-'
        : `+${a.attempt.linesAdded} / -${a.attempt.linesRemoved ?? 0}`,
  },
  { label: 'Tests', value: (a) => testSummary(a) },
  {
    label: 'Test time',
    value: (a) => formatDuration(a.tests.find((t) => t.status !== 'skipped')?.durationMs),
  },
]

/** Side-by-side metrics, one column per attempt. "Best" markers are per metric, never an overall score. */
export const printMetrics = (ui: Ui, detail: RunDetail, options: { title?: string } = {}): void => {
  const attempts = detail.attempts
  if (attempts.length === 0) return
  ui.out(ui.bold(options.title ?? 'Metrics'))
  const header = ['', ...attempts.map((a) => ui.bold(`${a.attempt.label}  ${a.attempt.model}`))]
  const body = rows.map((r) => {
    const values = attempts.map((a) => r.value(a))
    let bestIdx = -1
    if (r.best && attempts.length > 1) {
      const nums = attempts.map((a) => r.best?.of(a))
      const defined = nums.filter((n): n is number => n !== undefined)
      if (defined.length === attempts.length && new Set(defined).size > 1) {
        const target = r.best.prefer === 'lower' ? Math.min(...defined) : Math.max(...defined)
        bestIdx = nums.indexOf(target)
      }
    }
    return [
      ui.dim(r.label),
      ...values.map((v, i) => {
        const text = r.label === 'Status' ? statusColor(ui, v) : v
        return i === bestIdx ? ui.green(`${text} ◂`) : text
      }),
    ]
  })
  for (const line of table([header, ...body], 3)) ui.out(`  ${line}`)
  const notes = rows.filter((r) => r.note).map((r) => r.note as string)
  if (attempts.length > 1)
    notes.unshift(
      '◂ marks the better value for that single metric; metrics are not combined into a score.',
    )
  for (const n of notes) ui.out(ui.dim(`  ${n}`))
}
