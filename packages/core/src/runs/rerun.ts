import type { ProjectContext } from '../config/load.js'
import { headCommit } from '../git/git.js'
import type { RuntimeInfo } from '../runtime.js'
import type { Storage } from '../storage.js'
import { SidebetError } from '../util/exec.js'
import { loadRunDetail, type RunDetail } from './history.js'
import { type ExecutionPlan, planExecution } from './plan.js'

export interface RerunOptions {
  context: 'original' | 'current'
  models?: string[]
  readonly?: boolean
}

export interface RerunPlan {
  plan: ExecutionPlan
  parentRunId: string
  /** Plain-language account of what is and is not the same as the original run. */
  notes: string[]
}

export const planRerun = async (
  storage: Storage,
  project: ProjectContext,
  runtimeInfo: RuntimeInfo,
  original: RunDetail,
  options: RerunOptions,
): Promise<RerunPlan> => {
  const run = original.run
  const snapshot = storage.records.get('snapshot', run.contextSnapshotId)
  if (options.context === 'original' && !snapshot) {
    throw new SidebetError(
      `The original context snapshot ${run.contextSnapshotId} is missing.`,
      'Rerun with --current-context.',
    )
  }
  const models = options.models ?? [
    ...new Set(original.attempts.map((a) => `${a.attempt.provider}/${a.attempt.model}`)),
  ]
  const plan = await planExecution({
    project,
    runtimeInfo,
    storage,
    kind: run.kind,
    task: run.task,
    models,
    readonly: options.readonly ?? run.readonly,
    replaySnapshot: options.context === 'original' ? snapshot : undefined,
  })
  const notes: string[] = []
  notes.push(
    options.context === 'original'
      ? `Context: the ORIGINAL snapshot ${run.contextSnapshotId} from ${run.createdAt} (rules and memory as they were then; current files on disk are ignored for context).`
      : 'Context: CURRENT project rules, memory and docs, assembled fresh. This is not the same input as the original run.',
  )
  const head = await headCommit(project.root)
  if (run.baseCommit && head && run.baseCommit !== head) {
    notes.push(
      `Repository has changed: the original run started at ${run.baseCommit.slice(0, 8)}, HEAD is now ${head.slice(0, 8)}.`,
    )
  }
  if (run.policyVersion !== project.policyVersion)
    notes.push(
      `Policy changed since the original run (${run.policyVersion} -> ${project.policyVersion}).`,
    )
  if (run.configVersion !== project.configVersion)
    notes.push(
      `Configuration changed since the original run (${run.configVersion} -> ${project.configVersion}).`,
    )
  notes.push(
    'A rerun repeats the inputs, not the outputs: model behaviour, provider versions and dependencies may differ, so results are not guaranteed to match.',
  )
  return { plan, parentRunId: run.id, notes }
}

export { loadRunDetail }
