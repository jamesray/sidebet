import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import {
  type AttemptDetail,
  applyAttempt,
  diffPatch,
  findAttempt,
  latestRunId,
  loadRunDetail,
  modelRef,
  previewApply,
  type RunDetail,
  recordReview,
  refExists,
  resolveRun,
  SidebetError,
  worktreeAdd,
  worktreePathFor,
} from '@sidebet/core'
import { type App, type CliContext, openApp } from '../app.js'
import { parse } from '../args.js'
import { VERSION } from '../help.js'
import { printMetrics } from '../metrics.js'
import { attemptLine, statusColor, testSummary } from '../present.js'
import { header } from '../style/banner.js'
import {
  askLine,
  confirmTui,
  type MenuItem,
  renderDiffLines,
  selectMenu,
  viewText,
} from '../tui.js'
import { formatDuration, plural, truncate } from '../ui.js'
import { showText } from './pager.js'

const printReview = (ctx: CliContext, detail: RunDetail): void => {
  const { ui } = ctx
  const { run } = detail
  for (const l of header(ui.p, VERSION, {
    context: `review ${run.id}`,
    detail: truncate(run.task, 90),
  }))
    ui.out(l)
  ui.out()
  ui.out(
    ui.dim(
      `${run.id} · ${run.kind} · ${statusColor(ui, run.status)} · policy ${run.policyVersion} · context ${run.contextSnapshotId}${run.contextMode === 'original' ? ' (replayed)' : ''}`,
    ),
  )
  const lastReview = detail.reviews.at(-1)
  for (const a of detail.attempts) {
    const at = a.attempt
    ui.out()
    const mark = lastReview?.preferredAttemptId === at.id ? ui.green(' ★ preferred') : ''
    ui.out(
      `${ui.bold(`${at.label}: ${modelRef({ provider: at.provider, id: at.model })}`)}  ${statusColor(ui, at.status)}${mark}`,
    )
    if (at.changedFiles.length) ui.out(`  Files: ${truncate(at.changedFiles.join(', '), 100)}`)
    if (at.error) ui.out(ui.red(`  Error: ${truncate(at.error, 300)}`))
    const denied = a.toolEvents.filter((e) => e.decision === 'denied')
    for (const d of denied.slice(0, 5))
      ui.out(ui.yellow(`  Blocked: ${d.tool} ${truncate(d.summary, 60)} - ${d.reason ?? ''}`))
    const setupLog = a.logs.find((l) => l.name === 'setup.log')
    if (setupLog && (at.status !== 'completed' || a.tests.some((t) => t.status !== 'passed'))) {
      ui.out(
        ui.dim(
          `  Setup output (tail):\n${setupLog.content
            .split('\n')
            .slice(-4)
            .map((l) => `    ${l}`)
            .join('\n')}`,
        ),
      )
    }
    const failedTests = a.tests.find((t) => t.status === 'failed')
    if (failedTests?.outputTail)
      ui.out(
        ui.dim(
          `  Test output (tail):\n${failedTests.outputTail
            .split('\n')
            .slice(-6)
            .map((l) => `    ${l}`)
            .join('\n')}`,
        ),
      )
    if (at.summary) {
      ui.out(`  Summary: ${truncate(at.summary, 400)}`)
    }
  }
  ui.out()
  printMetrics(ui, detail)
  const bet = detail.bets.at(-1)
  if (bet) {
    const picked = detail.attempts.find((a) => a.attempt.label === bet.pick)
    const outcome = lastReview?.preferredAttemptId
      ? detail.attempts.find((a) => a.attempt.id === lastReview.preferredAttemptId)?.attempt
          .label === bet.pick
        ? ui.p.fg('gold')('◉ matched your preference')
        : ui.dim('◎ did not match your preference')
      : ui.dim('(review to resolve)')
    ui.out()
    ui.out(`Your call: ${bet.pick}${picked ? ` ${ui.dim(picked.attempt.model)}` : ''}  ${outcome}`)
  }
  if (lastReview) {
    ui.out()
    ui.out(
      `Recorded review: ${lastReview.accepted ? 'accepted' : 'not accepted'}${lastReview.reason ? ` - ${lastReview.reason}` : ''}`,
    )
  }
  for (const ap of detail.applications)
    ui.out(
      ui.dim(`Applied ${ap.resultRef} at ${ap.createdAt}; working tree backup: ${ap.backupRef}`),
    )
}

const attemptDiff = async (app: App, a: AttemptDetail): Promise<string> => {
  const at = a.attempt
  if (at.baseCommit && at.resultCommit && (await refExists(app.project.root, at.resultRef ?? ''))) {
    return diffPatch(app.project.root, at.baseCommit, at.resultCommit)
  }
  return a.diff?.content ?? ''
}

const diffBetween = async (app: App, a: AttemptDetail, b: AttemptDetail): Promise<string> => {
  if (!a.attempt.resultCommit || !b.attempt.resultCommit) {
    throw new SidebetError('Cannot compare: one attempt has no stored result commit.')
  }
  return diffPatch(app.project.root, a.attempt.resultCommit, b.attempt.resultCommit)
}

const checkout = async (
  app: App,
  detail: RunDetail,
  label: string,
  ctx: CliContext,
): Promise<string> => {
  const a = findAttempt(detail, label)
  if (!a.attempt.resultCommit)
    throw new SidebetError('This attempt has no stored result commit to check out.')
  const path = worktreePathFor(app.project, detail.run.id, `${a.attempt.label}-review`)
  await mkdir(dirname(path), { recursive: true })
  await worktreeAdd(app.project.root, path, a.attempt.resultCommit)
  ctx.ui.out(`Checked out ${a.attempt.label} at ${path}`)
  ctx.ui.out(ui(ctx).dim(`Remove it later with: sidebet clean   (or git worktree remove ${path})`))
  return path
}
const ui = (ctx: CliContext) => ctx.ui

const applyFlow = async (
  ctx: CliContext,
  app: App,
  detail: RunDetail,
  label: string,
  opts: { yes: boolean; allowIncomplete: boolean; ask: (q: string) => Promise<string> },
): Promise<boolean> => {
  const { ui } = ctx
  const preview = await previewApply(app.project, detail, label, {
    allowIncomplete: opts.allowIncomplete,
  })
  ui.out()
  ui.out(ui.bold(`Apply ${preview.label} (${preview.model}) to ${app.project.root}`))
  for (const f of preview.files)
    ui.out(`  ${preview.locallyModified.includes(f) ? ui.yellow('M*') : '  '} ${f}`)
  if (preview.locallyModified.length > 0)
    ui.out(
      ui.yellow(
        `  M* = you have local edits in ${plural(preview.locallyModified.length, 'of these files')}; the patch layers on top without discarding them.`,
      ),
    )
  if (!preview.applies) {
    ui.out(ui.red(`\nCannot apply cleanly:\n${preview.conflict ?? ''}`))
    ui.out('Nothing was changed.')
    return false
  }
  ui.out(
    ui.dim(
      'Applies to the working tree only (no commit, index untouched). A backup ref of your current tree is saved first.',
    ),
  )
  const ok = opts.yes || /^y(es)?$/i.test((await opts.ask('Apply these changes? [y/N] ')).trim())
  if (!ok) {
    ui.out('Not applied.')
    return false
  }
  const application = await applyAttempt(app.project, app.storage, preview)
  ui.out(ui.green(`Applied ${plural(application.files.length, 'file')}.`))
  ui.out(`  Attempt kept at:   ${application.resultRef}`)
  ui.out(
    `  To undo:           git checkout ${application.backupRef} -- ${application.files.map((f) => JSON.stringify(f)).join(' ')}   (for files that existed before)`,
  )
  return true
}

export const reviewCommand = async (ctx: CliContext, args: string[]): Promise<number> => {
  const { values, positionals } = parse(args, {
    diff: { type: 'string' },
    compare: { type: 'boolean' },
    select: { type: 'string' },
    accept: { type: 'boolean' },
    reject: { type: 'boolean' },
    reason: { type: 'string' },
    notes: { type: 'string' },
    apply: { type: 'string' },
    checkout: { type: 'string' },
    yes: { type: 'boolean', short: 'y' },
    'allow-incomplete': { type: 'boolean' },
    json: { type: 'boolean' },
  })
  const { ui } = ctx
  const app = await openApp(ctx)
  try {
    const runId = positionals[0]
      ? resolveRun(app.storage, positionals[0])
      : (latestRunId(app.storage, app.project.projectId, (r) => r.kind === 'compare') ??
        latestRunId(app.storage, app.project.projectId))
    if (!runId)
      throw new SidebetError('No runs to review yet.', 'Try `sidebet compare "<task>"` first.')
    let detail = loadRunDetail(app.storage, runId)

    if (
      values.json &&
      !values.select &&
      !values.apply &&
      values.accept === undefined &&
      values.reject === undefined
    ) {
      ui.out(JSON.stringify(detail, null, 2))
      return 0
    }

    const actions = Boolean(
      values.diff ||
        values.compare ||
        values.select ||
        values.accept ||
        values.reject ||
        values.apply ||
        values.checkout,
    )
    if (values.diff)
      await showText(ui, await attemptDiff(app, findAttempt(detail, values.diff)), true)
    if (values.compare) {
      const [a, b] = detail.attempts
      if (!a || !b) throw new SidebetError('Need two attempts to compare.')
      await showText(ui, await diffBetween(app, a, b), true)
    }
    if (values.checkout) await checkout(app, detail, values.checkout, ctx)
    if (values.select || values.accept || values.reject) {
      const review = recordReview(app.storage, detail, {
        runId,
        preferred: values.select,
        accepted: Boolean(values.accept) && !values.reject,
        reason: values.reason,
        notes: values.notes,
      })
      ui.out(
        ui.green(
          `Recorded review ${review.id}${values.select ? ` (preferred ${values.select})` : ''}.`,
        ),
      )
      detail = loadRunDetail(app.storage, runId)
    }
    if (values.apply) {
      const applied = await applyFlow(ctx, app, detail, values.apply, {
        yes: Boolean(values.yes),
        allowIncomplete: Boolean(values['allow-incomplete']),
        ask: async () => 'n',
      })
      if (!applied && !values.yes) ui.out(ui.dim('Re-run with --yes to confirm non-interactively.'))
      return applied ? 0 : 1
    }
    if (actions) return 0

    printReview(ctx, detail)
    if (!ctx.interactive) {
      ui.out()
      ui.out(
        ui.dim(
          'Actions (non-interactive): --diff A | --compare | --select A --accept --reason "..." | --apply A --yes | --checkout A',
        ),
      )
      return 0
    }
    return await interactiveLoop(ctx, app, detail)
  } finally {
    app.close()
  }
}

const interactiveLoop = async (ctx: CliContext, app: App, initial: RunDetail): Promise<number> => {
  const { ui } = ctx
  const p = ui.p
  let detail = initial
  const labelOf = (id?: string): string | undefined =>
    detail.attempts.find((a) => a.attempt.id === id)?.attempt.label
  let preferred: string | undefined = labelOf(detail.reviews.at(-1)?.preferredAttemptId)
  const labels = detail.attempts.map((a) => a.attempt.label)
  const laneOf = (label: string): ((s: string) => string) => p.lane(labels.indexOf(label))
  const ask = async (q: string): Promise<string> => (await askLine(p, q)) ?? ''

  for (;;) {
    const items: MenuItem[] = [
      ...detail.attempts.map((a) => ({
        value: `diff:${a.attempt.label}`,
        label: `View ${a.attempt.label} diff`,
        description: `${a.attempt.model} · ${plural(a.attempt.changedFiles.length, 'file')}`,
      })),
      ...(labels.length === 2
        ? [
            {
              value: 'compare',
              label: 'Compare A and B',
              description: 'the difference between the two results',
            },
          ]
        : []),
      {
        value: 'select',
        label: 'Select preferred result',
        description: preferred ? `currently ${preferred}` : 'not chosen yet',
      },
      { value: 'record', label: 'Record review', description: 'accepted or not, with a reason' },
      {
        value: 'apply',
        label: 'Apply a result to this repository',
        description: 'previews, confirms, keeps a backup',
      },
      { value: 'checkout', label: 'Check out an attempt in a worktree' },
      { value: 'exit', label: 'Exit' },
    ]
    const choice = await selectMenu(p, 'Review', items)
    if (!choice || choice === 'exit') break
    try {
      if (choice.startsWith('diff:')) {
        const label = choice.slice(5)
        const a = findAttempt(detail, label)
        const patch = await attemptDiff(app, a)
        if (!patch.trim()) ui.out(p.dim(`${label} made no changes.`))
        else await viewText(p, `${label}  ${a.attempt.model}`, await renderDiffLines(p, patch))
      } else if (choice === 'compare') {
        const [a, b] = detail.attempts
        if (a && b)
          await viewText(p, 'A → B', await renderDiffLines(p, await diffBetween(app, a, b)))
      } else if (choice === 'select') {
        const pick = await selectMenu(
          p,
          'Preferred result',
          detail.attempts.map((a) => ({
            value: a.attempt.label,
            label: `${a.attempt.label}  ${a.attempt.model}`,
            description: `tests ${testSummary(a)} · ${formatDuration(a.attempt.durationMs)}`,
          })),
        )
        if (pick) {
          preferred = pick
          ui.out(`${laneOf(pick)(pick)} selected. Record the review to save it.`)
        }
      } else if (choice === 'record') {
        const accepted = await confirmTui(p, 'Accept this solution?')
        const reason = (await askLine(p, 'Reason (optional)')) ?? ''
        const notes = (await askLine(p, 'Notes (optional)')) ?? ''
        const review = recordReview(app.storage, detail, {
          runId: detail.run.id,
          preferred,
          accepted,
          reason: reason || undefined,
          notes: notes || undefined,
        })
        detail = loadRunDetail(app.storage, detail.run.id)
        const bet = detail.bets.at(-1)
        const called =
          bet && preferred
            ? bet.pick === preferred
              ? 'matched your call'
              : `your call was ${bet.pick}`
            : undefined
        ui.out(
          `${p.fg('success')('Recorded')} ${p.dim(review.id)}${called ? p.dim(` · ${called}`) : ''}`,
        )
      } else if (choice === 'apply') {
        const pick = await selectMenu(
          p,
          'Apply which result?',
          detail.attempts.map((a) => ({
            value: a.attempt.label,
            label: `${a.attempt.label}  ${a.attempt.model}`,
            description: a.attempt.label === preferred ? 'preferred' : undefined,
          })),
        )
        if (pick)
          await applyFlow(ctx, app, detail, pick, { yes: false, allowIncomplete: false, ask })
      } else if (choice === 'checkout') {
        const pick = await selectMenu(
          p,
          'Check out which attempt?',
          detail.attempts.map((a) => ({
            value: a.attempt.label,
            label: `${a.attempt.label}  ${a.attempt.model}`,
          })),
        )
        if (pick) await checkout(app, detail, pick, ctx)
      }
    } catch (err) {
      ui.out(p.fg('error')(err instanceof Error ? err.message : String(err)))
    }
  }
  return 0
}

export { attemptLine }
