import {
  findAttempt,
  latestRunId,
  loadRunDetail,
  modelRef,
  resolveRun,
  SidebetError,
  summarizeContext,
} from '@sidebet/core'
import { type CliContext, openApp } from '../app.js'
import { parse } from '../args.js'
import { printMetrics } from '../metrics.js'
import { contextLines, statusColor, testSummary } from '../present.js'
import { ago, formatDuration, formatTokens, table, truncate } from '../ui.js'
import { showText } from './pager.js'

export const runsCommand = async (ctx: CliContext, args: string[]): Promise<number> => {
  const sub = args[0] && ['show', 'diff', 'list'].includes(args[0]) ? args[0] : 'list'
  const rest = sub === 'list' && args[0] !== 'list' ? args : args.slice(1)
  const { values, positionals } = parse(rest, {
    limit: { type: 'string', short: 'n' },
    json: { type: 'boolean' },
    status: { type: 'string' },
  })
  const { ui } = ctx
  const app = await openApp(ctx)
  try {
    if (sub === 'list') {
      const limit = Number(values.limit ?? 20)
      let runs = app.storage.records.list('run', {
        projectId: app.project.projectId,
        order: 'desc',
      })
      if (values.status) runs = runs.filter((r) => r.status === values.status)
      runs = runs.slice(0, limit)
      const details = runs.map((r) => loadRunDetail(app.storage, r.id))
      if (values.json) {
        ui.out(JSON.stringify(details, null, 2))
        return 0
      }
      if (runs.length === 0) {
        ui.out('No runs yet. Try `sidebet run "Explain this repository"`.')
        return 0
      }
      const rows = details.map((d) => [
        d.run.id,
        statusColor(ui, d.run.status),
        d.run.kind,
        d.attempts.map((a) => a.attempt.model).join(' vs '),
        ago(d.run.createdAt),
        truncate(d.run.task, 50),
      ])
      for (const l of table([
        ['ID', 'STATUS', 'KIND', 'MODELS', 'WHEN', 'TASK'].map((h) => ui.dim(h)),
        ...rows,
      ]))
        ui.out(l)
      return 0
    }
    const id = positionals[0]
      ? resolveRun(app.storage, positionals[0])
      : latestRunId(app.storage, app.project.projectId)
    if (!id) throw new SidebetError('No runs found.')
    const detail = loadRunDetail(app.storage, id)
    if (sub === 'diff') {
      const attempt = positionals[1] ? findAttempt(detail, positionals[1]) : detail.attempts[0]
      if (!attempt) throw new SidebetError('Run has no attempts.')
      if (!attempt.diff) {
        ui.out(`Attempt ${attempt.attempt.label} made no changes.`)
        return 0
      }
      await showText(ui, attempt.diff.content, true)
      return 0
    }
    // show
    if (values.json) {
      const snapshot = app.storage.records.get('snapshot', detail.run.contextSnapshotId)
      ui.out(JSON.stringify({ ...detail, snapshot }, null, 2))
      return 0
    }
    const { run } = detail
    ui.out(
      `${ui.bold(`${run.kind === 'compare' ? 'Compare' : 'Run'} ${run.id}`)}  ${statusColor(ui, run.status)}`,
    )
    const meta: string[][] = [
      ['Task', run.task],
      ['Category', run.category],
      ['Created', `${run.createdAt} (${ago(run.createdAt)})`],
      ['Completed', run.completedAt ?? '-'],
      ['Mode', run.readonly ? 'read-only' : 'read-write'],
      ['Base commit', run.baseCommit?.slice(0, 12) ?? '-'],
      ['Config version', run.configVersion],
      ['Policy version', run.policyVersion],
      [
        'Context snapshot',
        `${run.contextSnapshotId}${run.contextMode === 'original' ? ' (replayed from original)' : ''}`,
      ],
      ...(run.parentRunId ? [['Rerun of', run.parentRunId]] : []),
    ]
    for (const l of table(meta)) ui.out(`  ${l}`)
    const snapshot = app.storage.records.get('snapshot', run.contextSnapshotId)
    if (snapshot)
      ui.out(
        `  Context: ~${formatTokens(summarizeContext(snapshot).estimatedTokens)} tokens; see \`sidebet context inspect ${run.id}\``,
      )
    for (const a of detail.attempts) {
      const at = a.attempt
      ui.out()
      ui.out(
        `${ui.bold(`${at.label}  ${modelRef({ provider: at.provider, id: at.model })}`)}  ${statusColor(ui, at.status)}  ${ui.dim(`runtime ${at.runtime}`)}`,
      )
      const rows: string[][] = [
        ['Duration', formatDuration(at.durationMs)],
        ['Files', at.changedFiles.length ? at.changedFiles.join(', ') : 'none'],
        ['Tests', testSummary(a)],
        ...(at.resultRef ? [['Result ref', at.resultRef]] : []),
        ...(at.runtimeSession ? [['Pi session', at.runtimeSession]] : []),
      ]
      for (const l of table(rows)) ui.out(`  ${l}`)
      if (at.error) ui.out(ui.red(`  Error: ${at.error}`))
      if (at.summary) ui.out(`\n  ${at.summary.split('\n').slice(0, 12).join('\n  ')}`)
    }
    ui.out()
    printMetrics(ui, detail)
    for (const r of detail.reviews)
      ui.out(
        `\nReview ${r.id}: ${r.accepted ? 'accepted' : 'not accepted'}${r.preferredAttemptId ? `, preferred ${detail.attempts.find((a) => a.attempt.id === r.preferredAttemptId)?.attempt.label}` : ''}${r.reason ? `; ${r.reason}` : ''}${r.notes ? `; notes: ${r.notes}` : ''}`,
      )
    return 0
  } finally {
    app.close()
  }
}

export { contextLines }
