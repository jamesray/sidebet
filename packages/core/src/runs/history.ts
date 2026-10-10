import type {
  Application,
  Artifact,
  Evaluation,
  HumanReview,
  SidebetAttempt,
  SidebetRun,
  TestResult,
  ToolEvent,
  UsageMetrics,
} from '../domain/schemas.js'
import type { Storage } from '../storage.js'
import { SidebetError } from '../util/exec.js'

export interface AttemptDetail {
  attempt: SidebetAttempt
  usage?: UsageMetrics
  tests: TestResult[]
  diff?: Artifact
  toolEvents: ToolEvent[]
  evaluations: Evaluation[]
}

export interface RunDetail {
  run: SidebetRun
  attempts: AttemptDetail[]
  reviews: HumanReview[]
  applications: Application[]
}

export const loadRunDetail = (storage: Storage, runId: string): RunDetail => {
  const run = storage.records.get('run', runId)
  if (!run) throw new SidebetError(`Run ${runId} not found.`, 'List runs with `sidebet runs`.')
  const attempts = storage.records.list('attempt', { runId }).map((attempt) => {
    const f = { attemptId: attempt.id }
    return {
      attempt,
      usage: storage.records.list('usage', f)[0],
      tests: storage.records.list('testResult', f),
      diff: storage.records.list('artifact', f).find((a) => a.kind === 'diff'),
      toolEvents: storage.records.list('toolEvent', f),
      evaluations: storage.records.list('evaluation', f),
    }
  })
  return {
    run,
    attempts,
    reviews: storage.records.list('review', { runId }),
    applications: storage.records.list('application', { runId }),
  }
}

export const resolveRun = (storage: Storage, idOrPrefix: string): string => {
  let id: string | undefined
  try {
    id = storage.records.resolveId('run', idOrPrefix)
  } catch (err) {
    throw new SidebetError(
      err instanceof Error ? err.message : String(err),
      'Use a longer id prefix.',
    )
  }
  if (!id)
    throw new SidebetError(`Run "${idOrPrefix}" not found.`, 'List runs with `sidebet runs`.')
  return id
}

export const latestRunId = (
  storage: Storage,
  projectId: string,
  filter?: (r: SidebetRun) => boolean,
): string | undefined =>
  storage.records.list('run', { projectId, order: 'desc' }).find((r) => (filter ? filter(r) : true))
    ?.id

export const findAttempt = (detail: RunDetail, labelOrId: string): AttemptDetail => {
  const wanted = labelOrId.toLowerCase()
  const found = detail.attempts.find(
    (a) =>
      a.attempt.label.toLowerCase() === wanted ||
      a.attempt.id === labelOrId ||
      a.attempt.model.toLowerCase() === wanted ||
      `${a.attempt.provider}/${a.attempt.model}`.toLowerCase() === wanted,
  )
  if (!found) {
    throw new SidebetError(
      `Attempt "${labelOrId}" not found in ${detail.run.id}.`,
      `Attempts: ${detail.attempts.map((a) => `${a.attempt.label} (${a.attempt.model})`).join(', ')}`,
    )
  }
  return found
}
