import {
  findAttempt,
  latestRunId,
  loadRunDetail,
  newId,
  nowIso,
  resolveRun,
  SCHEMA_VERSION,
  SidebetError,
} from '@sidebet/core'
import { type CliContext, openApp } from '../app.js'
import { parse } from '../args.js'

/**
 * Record which attempt you expect to prefer, before reading the diffs. `sidebet odds` reports how
 * often your calls matched your recorded preference. It changes nothing about the run itself.
 */
export const betCommand = async (ctx: CliContext, args: string[]): Promise<number> => {
  const { values, positionals } = parse(args, {
    run: { type: 'string' },
    json: { type: 'boolean' },
  })
  const { ui } = ctx
  const pick = positionals[0]?.toUpperCase()
  if (!pick) {
    throw new SidebetError(
      'bet needs an attempt label.',
      'Example: sidebet bet A   (or: sidebet bet B --run run_1a2b3c4d)',
    )
  }
  const app = await openApp(ctx)
  try {
    const runId = values.run
      ? resolveRun(app.storage, values.run)
      : latestRunId(app.storage, app.project.projectId, (r) => r.kind === 'compare')
    if (!runId)
      throw new SidebetError(
        'No compare run to bet on.',
        'Start one with `sidebet compare "<task>"`.',
      )
    const detail = loadRunDetail(app.storage, runId)
    if (detail.reviews.some((r) => r.preferredAttemptId)) {
      throw new SidebetError(
        `${runId} already has a recorded preference; a bet must come before the review.`,
      )
    }
    const attempt = findAttempt(detail, pick)
    const bet = {
      id: newId('bet'),
      schemaVersion: SCHEMA_VERSION,
      projectId: app.project.projectId,
      runId,
      pick: attempt.attempt.label,
      createdAt: nowIso(),
    }
    app.storage.records.put('bet', bet)
    if (values.json) ui.out(JSON.stringify(bet))
    else {
      ui.out(
        `${ui.p.fg('gold')('◉')} ${ui.bold(attempt.attempt.label)} ${ui.dim(attempt.attempt.model)}  ${ui.dim(`on ${runId}`)}`,
      )
      ui.out(
        ui.dim(
          'Resolved when you record a preference in `sidebet review`; tallied in `sidebet odds`.',
        ),
      )
    }
    return 0
  } finally {
    app.close()
  }
}
