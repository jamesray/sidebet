import type { SidebetAttempt, TaskCategory } from '../domain/schemas.js'
import { loadRunDetail } from '../runs/history.js'
import type { Storage } from '../storage.js'
import { median } from '../util/stats.js'

export interface CategoryOdds {
  attempts: number
  testsRun: number
  testsPassed: number
  appearances: number
  preferred: number
}

export interface ModelOdds {
  model: string
  attempts: number
  completed: number
  /** Objective: attempts whose tests ran (passed or failed). */
  testsRun: number
  testsPassed: number
  /** Human: attempts that appeared in a compare run where a preference was recorded. */
  appearances: number
  preferred: number
  /** Reviews that picked this model, and how many of those were accepted. */
  reviewsPicked: number
  reviewsAccepted: number
  medianDurationMs?: number
  medianCostUsd?: number
  medianTotalTokens?: number
  costReported: number
  byCategory: Partial<Record<TaskCategory, CategoryOdds>>
}

export interface HeadToHead {
  a: string
  b: string
  runs: number
  aPreferred: number
  bPreferred: number
  bothRanTests: number
  aOnlyPassed: number
  bOnlyPassed: number
  bothPassed: number
  bothFailed: number
}

export interface CallRecord {
  /** Oldest first. */
  outcomes: Array<'hit' | 'miss'>
  hits: number
  total: number
  /** Current streak of hits (0 if the last call missed). */
  streak: number
}

export interface OddsReport {
  generatedFromRuns: number
  compareRuns: number
  reviewedRuns: number
  models: ModelOdds[]
  headToHead: HeadToHead[]
  /** How often the developer's pre-review bet matched their recorded preference. */
  calls: CallRecord
  caveats: string[]
}

const key = (a: SidebetAttempt): string => `${a.provider}/${a.model}`

export const computeOdds = (
  storage: Storage,
  projectId: string,
  options: { category?: TaskCategory } = {},
): OddsReport => {
  const runs = storage.records
    .list('run', { projectId })
    .filter((r) => r.status !== 'running' && (!options.category || r.category === options.category))
  const stats = new Map<
    string,
    ModelOdds & { durations: number[]; costs: number[]; tokens: number[] }
  >()
  const h2h = new Map<string, HeadToHead>()
  let compareRuns = 0
  let reviewedRuns = 0
  const callOutcomes: Array<'hit' | 'miss'> = []
  const get = (
    m: string,
  ): ModelOdds & { durations: number[]; costs: number[]; tokens: number[] } => {
    let s = stats.get(m)
    if (!s) {
      s = {
        model: m,
        attempts: 0,
        completed: 0,
        testsRun: 0,
        testsPassed: 0,
        appearances: 0,
        preferred: 0,
        reviewsPicked: 0,
        reviewsAccepted: 0,
        costReported: 0,
        byCategory: {},
        durations: [],
        costs: [],
        tokens: [],
      }
      stats.set(m, s)
    }
    return s
  }
  const cat = (s: ModelOdds, c: TaskCategory): CategoryOdds => {
    let o = s.byCategory[c]
    if (!o) {
      o = { attempts: 0, testsRun: 0, testsPassed: 0, appearances: 0, preferred: 0 }
      s.byCategory[c] = o
    }
    return o
  }

  for (const run of runs) {
    const detail = loadRunDetail(storage, run.id)
    if (run.kind === 'compare') compareRuns += 1
    const review = [...detail.reviews].reverse().find((r) => r.preferredAttemptId !== undefined)
    if (review) reviewedRuns += 1
    const bet = detail.bets.at(-1)
    if (bet && review?.preferredAttemptId) {
      const preferred = detail.attempts.find((a) => a.attempt.id === review.preferredAttemptId)
      if (preferred) callOutcomes.push(preferred.attempt.label === bet.pick ? 'hit' : 'miss')
    }
    for (const a of detail.attempts) {
      const s = get(key(a.attempt))
      const c = cat(s, run.category)
      s.attempts += 1
      c.attempts += 1
      if (a.attempt.status === 'completed') s.completed += 1
      if (a.attempt.durationMs !== undefined && a.attempt.status === 'completed')
        s.durations.push(a.attempt.durationMs)
      if (a.usage) s.tokens.push(a.usage.totalTokens)
      if (a.usage?.costUsd !== undefined) {
        s.costs.push(a.usage.costUsd)
        s.costReported += 1
      }
      const t = a.tests.find((x) => x.status === 'passed' || x.status === 'failed')
      if (t) {
        s.testsRun += 1
        c.testsRun += 1
        if (t.status === 'passed') {
          s.testsPassed += 1
          c.testsPassed += 1
        }
      }
      if (run.kind === 'compare' && review) {
        s.appearances += 1
        c.appearances += 1
        if (review.preferredAttemptId === a.attempt.id) {
          s.preferred += 1
          c.preferred += 1
        }
      }
      if (review?.preferredAttemptId === a.attempt.id) {
        s.reviewsPicked += 1
        if (review.accepted) s.reviewsAccepted += 1
      }
    }
    if (run.kind === 'compare') {
      for (let i = 0; i < detail.attempts.length; i++) {
        for (let j = i + 1; j < detail.attempts.length; j++) {
          const x = detail.attempts[i]
          const y = detail.attempts[j]
          if (!x || !y) continue
          const [first, second] = key(x.attempt) <= key(y.attempt) ? [x, y] : [y, x]
          const id = `${key(first.attempt)}|${key(second.attempt)}`
          let h = h2h.get(id)
          if (!h) {
            h = {
              a: key(first.attempt),
              b: key(second.attempt),
              runs: 0,
              aPreferred: 0,
              bPreferred: 0,
              bothRanTests: 0,
              aOnlyPassed: 0,
              bOnlyPassed: 0,
              bothPassed: 0,
              bothFailed: 0,
            }
            h2h.set(id, h)
          }
          h.runs += 1
          if (review?.preferredAttemptId === first.attempt.id) h.aPreferred += 1
          if (review?.preferredAttemptId === second.attempt.id) h.bPreferred += 1
          const ta = first.tests.find((t) => t.status === 'passed' || t.status === 'failed')
          const tb = second.tests.find((t) => t.status === 'passed' || t.status === 'failed')
          if (ta && tb) {
            h.bothRanTests += 1
            const pa = ta.status === 'passed'
            const pb = tb.status === 'passed'
            if (pa && pb) h.bothPassed += 1
            else if (pa) h.aOnlyPassed += 1
            else if (pb) h.bOnlyPassed += 1
            else h.bothFailed += 1
          }
        }
      }
    }
  }

  const models = [...stats.values()]
    .map(
      ({ durations, costs, tokens, ...rest }): ModelOdds => ({
        ...rest,
        medianDurationMs: median(durations),
        medianCostUsd: median(costs),
        medianTotalTokens: median(tokens),
      }),
    )
    .sort((a, b) => b.attempts - a.attempts || a.model.localeCompare(b.model))

  const caveats: string[] = []
  if (runs.length === 0)
    caveats.push(
      'No finished runs yet. Run `sidebet compare "<task>"` and `sidebet review` to build history.',
    )
  if (reviewedRuns < 5 && runs.length > 0) {
    caveats.push(
      `Only ${reviewedRuns} compare run(s) have a recorded human preference. Treat preference rates as anecdotes until you have more.`,
    )
  }
  caveats.push(
    'Test pass rate and preference are different evidence: tests are objective but only as good as your suite; preference is your judgement. They are shown separately and never blended.',
  )
  caveats.push(
    'Models were not necessarily given the same tasks. Medians and pass rates across different tasks are not directly comparable; the head-to-head table only uses runs where both models attempted the same task.',
  )
  if (models.some((m) => m.costReported < m.attempts)) {
    caveats.push(
      'Cost is shown only where the runtime reported one; missing costs are not estimated.',
    )
  }
  let streak = 0
  for (let i = callOutcomes.length - 1; i >= 0 && callOutcomes[i] === 'hit'; i--) streak += 1
  const calls: CallRecord = {
    outcomes: callOutcomes,
    hits: callOutcomes.filter((o) => o === 'hit').length,
    total: callOutcomes.length,
    streak,
  }
  return {
    calls,
    generatedFromRuns: runs.length,
    compareRuns,
    reviewedRuns,
    models,
    headToHead: [...h2h.values()],
    caveats,
  }
}
