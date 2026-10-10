import type { ProjectContext } from '../config/load.js'
import { assembleContext, renderForReplay } from '../context/assemble.js'
import type { ContextSnapshot, RunKind, TaskCategory } from '../domain/schemas.js'
import { statusLines } from '../git/git.js'
import {
  allowedToolNames,
  evaluateModel,
  isProtectedPath,
  READ_ONLY_TOOLS,
} from '../policy/evaluate.js'
import { DEFAULT_PROTECTED_PATHS } from '../policy/schema.js'
import type { Rejection } from '../routing/select.js'
import { categorizeTask, selectModelForRun, selectModelsForCompare } from '../routing/select.js'
import { type ModelInfo, modelRef, type RuntimeInfo } from '../runtime.js'
import type { Storage } from '../storage.js'
import { SidebetError } from '../util/exec.js'

export const DEFAULT_TOOLS = ['read', 'bash', 'edit', 'write']

export interface PlanInput {
  project: ProjectContext
  runtimeInfo: RuntimeInfo
  storage: Storage
  kind: RunKind
  task: string
  models?: string[]
  readonly?: boolean
  taskFiles?: string[]
  /** Rerun with a stored snapshot instead of assembling fresh context. */
  replaySnapshot?: ContextSnapshot
  runTests?: boolean
  timeoutSec?: number
  concurrency?: number
  env?: NodeJS.ProcessEnv
}

export interface ExecutionPlan {
  kind: RunKind
  task: string
  category: TaskCategory
  readonly: boolean
  models: ModelInfo[]
  modelBasis: string
  rejectedModels: Rejection[]
  snapshot: ContextSnapshot
  /** Text appended to the agent's system prompt. */
  contextPrompt: string
  nativeContextFiles: boolean
  contextMode: 'fresh' | 'original'
  tools: string[]
  testCommand?: string
  runTests: boolean
  timeoutMs: number
  concurrency: number
  dirtyFiles: string[]
  warnings: string[]
}

/** Everything a run will do, decided before anything starts. `--dry-run` prints this verbatim. */
export const planExecution = async (input: PlanInput): Promise<ExecutionPlan> => {
  const { project, runtimeInfo, storage } = input
  const warnings = [...project.policyWarnings]
  const readonly = Boolean(input.readonly || project.policy.readonly)
  if (!runtimeInfo.available) {
    throw new SidebetError(
      `Runtime "${runtimeInfo.id}" is not available.`,
      runtimeInfo.problems.join('; ') || 'Run `sidebet doctor`.',
    )
  }
  const selection =
    input.kind === 'compare'
      ? selectModelsForCompare(project, runtimeInfo, input.models)
      : selectModelForRun(project, runtimeInfo, input.models?.[0])
  if (input.kind === 'compare' && readonly) {
    warnings.push(
      'Read-only compare: attempts cannot change files, so only their answers can be compared.',
    )
  }

  let snapshot: ContextSnapshot
  let contextPrompt: string
  let nativeContextFiles: boolean
  let contextMode: 'fresh' | 'original' = 'fresh'
  if (input.replaySnapshot) {
    snapshot = input.replaySnapshot
    contextMode = 'original'
    for (const item of snapshot.items) {
      if (item.delivery === 'omitted') continue
      if (
        ['agents', 'rule', 'doc', 'task'].includes(item.kind) &&
        isProtectedPath(project.policy, item.source)
      ) {
        throw new SidebetError(
          `The original context includes ${item.source}, which is now protected by policy.`,
          'Rerun with --current-context, or relax policy.protectedPaths.',
        )
      }
    }
    contextPrompt = renderForReplay(snapshot)
    nativeContextFiles = false
    if (snapshot.items.some((i) => i.kind === 'skill')) {
      warnings.push('Skills are loaded by Pi from disk and may differ from the original run.')
    }
  } else {
    snapshot = await assembleContext({
      project,
      task: input.task,
      memory: storage.memory,
      runtime: runtimeInfo,
      taskFiles: input.taskFiles,
      env: input.env,
    })
    contextPrompt = snapshot.rendered
    nativeContextFiles = snapshot.nativeContextFiles
  }

  const tools = allowedToolNames(
    project.policy,
    readonly,
    readonly ? [...READ_ONLY_TOOLS] : DEFAULT_TOOLS,
  )
  const customProtected =
    project.policy.protectedPaths.join('\0') !== DEFAULT_PROTECTED_PATHS.join('\0')
  if (customProtected && tools.includes('bash') && !project.policy.strict) {
    warnings.push(
      'Protected paths are enforced for file tools only; bash can still read them (policy.strict removes bash).',
    )
  }
  const testCommand = project.config.tests.command
  const runTests =
    input.kind === 'compare' ? true : Boolean(input.runTests ?? project.config.run.runTests)
  if (runTests && !testCommand)
    warnings.push('No tests.command configured; test results will be recorded as skipped.')
  for (const m of selection.models) {
    const d = evaluateModel(project.policy, m)
    if (!d.allowed) throw new SidebetError(`${modelRef(m)} denied by policy: ${d.reason}`)
  }
  const timeoutSec =
    input.timeoutSec ??
    (input.kind === 'compare' ? project.config.compare.timeoutSec : project.config.run.timeoutSec)
  return {
    kind: input.kind,
    task: input.task,
    category: categorizeTask(input.task),
    readonly,
    models: selection.models,
    modelBasis: selection.basis,
    rejectedModels: selection.rejected,
    snapshot,
    contextPrompt,
    nativeContextFiles,
    contextMode,
    tools,
    testCommand,
    runTests,
    timeoutMs: timeoutSec * 1000,
    concurrency: input.concurrency ?? project.config.compare.concurrency,
    dirtyFiles: (await statusLines(project.root)).map((l) => l.slice(3)),
    warnings,
  }
}
