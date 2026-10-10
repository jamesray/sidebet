import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { createInterface } from 'node:readline/promises'
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
import { printMetrics } from '../metrics.js'
import { attemptLine, statusColor } from '../present.js'
import { plural, truncate } from '../ui.js'
import { showText } from './pager.js'

const printReview = (ctx: CliContext, detail: RunDetail): void => {
  const { ui } = ctx
  const { run } = detail
  ui.out(ui.bold('Sidebet Review'))
  ui.out()
  ui.out(`Task: ${run.task}`)
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
  let detail = initial
  let preferred: string | undefined = detail.reviews.at(-1)?.preferredAttemptId
    ? detail.attempts.find((a) => a.attempt.id === detail.reviews.at(-1)?.preferredAttemptId)
        ?.attempt.label
    : undefined
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  const ask = (q: string): Promise<string> => rl.question(q)
  const labels = detail.attempts.map((a) => a.attempt.label)
  try {
    for (;;) {
      ui.out()
      ui.out(ui.bold('Actions:'))
      const menu: Array<[string, string]> = [
        ...labels.map((l): [string, string] => [`d${l.toLowerCase()}`, `View ${l} diff`]),
        ...(labels.length === 2
          ? ([['c', 'Compare changes (A vs B)']] as Array<[string, string]>)
          : []),
        ['s', `Select preferred result${preferred ? ` (now ${preferred})` : ''}`],
        ['r', 'Record review'],
        ['a', 'Apply a result to this repository'],
        ['w', 'Check out an attempt in a worktree'],
        ['q', 'Exit'],
      ]
      for (const [k, d] of menu) ui.out(`  ${ui.cyan(k.padEnd(3))} ${d}`)
      const choice = (await ask('> ')).trim().toLowerCase()
      try {
        if (choice === 'q' || choice === '') break
        if (/^d[a-z]$/.test(choice))
          await showText(ui, await attemptDiff(app, findAttempt(detail, choice.slice(1))), true)
        else if (choice === 'c') {
          const [a, b] = detail.attempts
          if (a && b) await showText(ui, await diffBetween(app, a, b), true)
        } else if (choice === 's') {
          const l = (await ask(`Preferred attempt (${labels.join('/')}): `)).trim().toUpperCase()
          findAttempt(detail, l)
          preferred = l
          ui.out(`Selected ${l}. Choose "r" to record your review.`)
        } else if (choice === 'r') {
          const accepted = /^y/i.test((await ask('Accept this solution? [y/N] ')).trim())
          const reason = (await ask('Reason (optional): ')).trim()
          const notes = (await ask('Notes (optional): ')).trim()
          const review = recordReview(app.storage, detail, {
            runId: detail.run.id,
            preferred,
            accepted,
            reason: reason || undefined,
            notes: notes || undefined,
          })
          ui.out(ui.green(`Recorded review ${review.id}.`))
          detail = loadRunDetail(app.storage, detail.run.id)
        } else if (choice === 'a') {
          const l =
            (
              await ask(
                `Apply which attempt? (${labels.join('/')}${preferred ? `, enter = ${preferred}` : ''}): `,
              )
            )
              .trim()
              .toUpperCase() || preferred
          if (l) await applyFlow(ctx, app, detail, l, { yes: false, allowIncomplete: false, ask })
        } else if (choice === 'w') {
          const l = (await ask(`Check out which attempt? (${labels.join('/')}): `))
            .trim()
            .toUpperCase()
          await checkout(app, detail, l, ctx)
        } else ui.out('Unknown action.')
      } catch (err) {
        ui.out(ui.red(err instanceof Error ? err.message : String(err)))
      }
    }
  } finally {
    rl.close()
  }
  return 0
}

export { attemptLine }
