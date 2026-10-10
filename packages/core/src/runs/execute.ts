import {
  attemptRef,
  createWorktree,
  prepareCompareBase,
  removeWorktree,
  runSetup,
} from '../comparison/worktree.js'
import type { ProjectContext } from '../config/load.js'
import {
  type Artifact,
  type AttemptStatus,
  type RunStatus,
  SCHEMA_VERSION,
  type SidebetAttempt,
  type SidebetRun,
  type ToolEvent,
} from '../domain/schemas.js'
import {
  commitTree,
  diffNames,
  diffPatch,
  diffStat,
  headCommit,
  snapshotTree,
  updateRef,
} from '../git/git.js'
import type {
  AgentRuntime,
  AttemptOutcome,
  ModelInfo,
  RuntimeEvent,
  RuntimeInfo,
} from '../runtime.js'
import { modelRef } from '../runtime.js'
import type { Storage } from '../storage.js'
import { SidebetError } from '../util/exec.js'
import { sha256 } from '../util/hash.js'
import { newId, nowIso } from '../util/ids.js'
import { loadRunDetail, type RunDetail } from './history.js'
import type { ExecutionPlan } from './plan.js'
import { runTestCommand } from './tests.js'

export interface Reporter {
  info(message: string): void
  warn(message: string): void
  event(who: { label: string; model: string }, event: RuntimeEvent): void
  phase(who: { label: string; model: string }, message: string): void
  /** Attempt lifecycle, for live displays. */
  attempt?(who: { label: string; model: string }, status: AttemptStatus, error?: string): void
}

export const silentReporter: Reporter = { info() {}, warn() {}, event() {}, phase() {} }

export interface ExecDeps {
  storage: Storage
  runtime: AgentRuntime
  runtimeInfo: RuntimeInfo
  project: ProjectContext
  reporter: Reporter
  signal: AbortSignal
  approve?: (request: { tool: string; summary: string; reason: string }) => Promise<boolean>
}

export interface ExecutePlanOptions {
  parentRunId?: string
}

const MAX_SUMMARY = 20_000
const MAX_ARTIFACT = 8 * 1024 * 1024
const LABELS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'

const settle = <T>(p: Promise<T>, ms: number, onTimeout: () => T): Promise<T> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(onTimeout()), ms)
    p.then(
      (v) => {
        clearTimeout(timer)
        resolve(v)
      },
      (e) => {
        clearTimeout(timer)
        reject(e)
      },
    )
  })

export const pool = async <T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> => {
  const results: R[] = new Array(items.length)
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++
      results[i] = await fn(items[i] as T, i)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}

interface AttemptContext {
  deps: ExecDeps
  plan: ExecutionPlan
  run: SidebetRun
  attempt: SidebetAttempt
  model: ModelInfo
  who: { label: string; model: string }
}

const saveDiff = (
  deps: ExecDeps,
  run: SidebetRun,
  attempt: SidebetAttempt,
  patch: string,
): void => {
  const clipped =
    patch.length > MAX_ARTIFACT
      ? `${patch.slice(0, MAX_ARTIFACT)}\n# [diff truncated by Sidebet]\n`
      : patch
  const artifact: Artifact = {
    id: newId('art'),
    schemaVersion: SCHEMA_VERSION,
    runId: run.id,
    attemptId: attempt.id,
    kind: 'diff',
    name: 'changes.patch',
    mediaType: 'text/x-diff',
    sha256: sha256(patch),
    sizeBytes: patch.length,
    content: clipped,
  }
  deps.storage.records.put('artifact', artifact)
}

const saveLog = (
  deps: ExecDeps,
  run: SidebetRun,
  attempt: SidebetAttempt,
  name: string,
  text: string,
): void => {
  const content =
    text.length > 64_000 ? `[... earlier output omitted]\n${text.slice(-64_000)}` : text
  deps.storage.records.put('artifact', {
    id: newId('art'),
    schemaVersion: SCHEMA_VERSION,
    runId: run.id,
    attemptId: attempt.id,
    kind: 'log',
    name,
    mediaType: 'text/plain',
    sha256: sha256(text),
    sizeBytes: text.length,
    content,
  })
}

/** Run the agent for one attempt and persist tool events and usage. */
const runAgent = async (
  ctx: AttemptContext,
  cwd: string,
  approve: ExecDeps['approve'],
): Promise<AttemptOutcome> => {
  const { deps, plan, run, attempt, model, who } = ctx
  const events: ToolEvent[] = []
  const open = new Map<
    string,
    { tool: string; summary: string; startedAt: number; approved: boolean }
  >()
  const controller = new AbortController()
  const onAbort = (): void => controller.abort()
  if (deps.signal.aborted) controller.abort()
  deps.signal.addEventListener('abort', onAbort, { once: true })

  const base = { schemaVersion: SCHEMA_VERSION, runId: run.id, attemptId: attempt.id }
  const agentStarted = Date.now()
  const m = {
    firstTokenAt: undefined as number | undefined,
    firstEditAt: undefined as number | undefined,
    toolCalls: 0,
    toolErrors: 0,
    toolsDenied: 0,
    byTool: {} as Record<string, number>,
    // tracked from usage events as a fallback when the runtime returns no final usage
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    costSeen: false,
    turns: 0,
  }
  const onEvent = (event: RuntimeEvent): void => {
    deps.reporter.event(who, event)
    if (event.type === 'text' && m.firstTokenAt === undefined && event.delta.trim()) {
      m.firstTokenAt = Date.now()
    } else if (event.type === 'usage') {
      m.turns = Math.max(m.turns, event.turn)
      m.input += event.inputTokens
      m.output += event.outputTokens
      m.cacheRead += event.cacheReadTokens
      m.cacheWrite += event.cacheWriteTokens
      if (event.costUsd !== undefined) {
        m.cost += event.costUsd
        m.costSeen = true
      }
    }
    if (event.type === 'tool-start') {
      m.firstTokenAt ??= Date.now()
      m.toolCalls += 1
      m.byTool[event.tool] = (m.byTool[event.tool] ?? 0) + 1
      if ((event.tool === 'write' || event.tool === 'edit') && m.firstEditAt === undefined) {
        m.firstEditAt = Date.now()
      }
      open.set(event.id, {
        tool: event.tool,
        summary: event.summary,
        startedAt: Date.now(),
        approved: Boolean(event.approved),
      })
    } else if (event.type === 'tool-end') {
      const o = open.get(event.id)
      open.delete(event.id)
      if (event.isError) m.toolErrors += 1
      events.push({
        ...base,
        id: newId('tev'),
        tool: event.tool,
        summary: (o?.summary ?? event.summary).slice(0, 500),
        decision: o?.approved ? 'approved' : 'allowed',
        status: event.isError ? 'error' : 'ok',
        startedAt: new Date(o?.startedAt ?? Date.now()).toISOString(),
        durationMs: o ? Date.now() - o.startedAt : undefined,
      })
    } else if (event.type === 'tool-denied') {
      m.toolsDenied += 1
      events.push({
        ...base,
        id: newId('tev'),
        tool: event.tool,
        summary: event.summary.slice(0, 500),
        decision: 'denied',
        status: 'denied',
        reason: event.reason,
        startedAt: nowIso(),
      })
    }
  }

  let outcome: AttemptOutcome
  try {
    outcome = await settle(
      deps.runtime.execute({
        cwd,
        task: plan.task,
        model: { provider: model.provider, id: model.id },
        contextPrompt: plan.contextPrompt,
        nativeContextFiles: plan.nativeContextFiles,
        policy: deps.project.policy,
        readonly: plan.readonly,
        persistSession: plan.kind === 'run',
        signal: controller.signal,
        timeoutMs: plan.timeoutMs,
        onEvent,
        approve,
      }),
      plan.timeoutMs + 20_000,
      () => {
        controller.abort()
        return {
          status: 'timeout',
          summary: '',
          error: 'runtime did not stop after the timeout',
        } as AttemptOutcome
      },
    )
  } catch (err) {
    outcome = {
      status: 'failed',
      summary: '',
      error: err instanceof Error ? err.message : String(err),
    }
  } finally {
    deps.signal.removeEventListener('abort', onAbort)
  }
  const agentDurationMs = Date.now() - agentStarted
  for (const e of events) deps.storage.records.put('toolEvent', e)
  const u = outcome.usage ?? {
    inputTokens: m.input,
    outputTokens: m.output,
    cacheReadTokens: m.cacheRead,
    cacheWriteTokens: m.cacheWrite,
    totalTokens: m.input + m.output + m.cacheRead + m.cacheWrite,
    costUsd: m.costSeen && m.cost > 0 ? m.cost : undefined,
    turns: m.turns,
  }
  // Record metrics whenever anything happened, so failed/cancelled attempts keep their numbers.
  if (u.turns > 0 || m.toolCalls > 0 || m.toolsDenied > 0) {
    deps.storage.records.put('usage', {
      ...base,
      id: newId('use'),
      inputTokens: u.inputTokens,
      outputTokens: u.outputTokens,
      cacheReadTokens: u.cacheReadTokens,
      cacheWriteTokens: u.cacheWriteTokens,
      totalTokens: u.totalTokens,
      costUsd: u.costUsd,
      turns: u.turns,
      agentDurationMs,
      timeToFirstTokenMs: m.firstTokenAt === undefined ? undefined : m.firstTokenAt - agentStarted,
      timeToFirstEditMs: m.firstEditAt === undefined ? undefined : m.firstEditAt - agentStarted,
      toolCalls: m.toolCalls,
      toolErrors: m.toolErrors,
      toolsDenied: m.toolsDenied,
      toolCallsByTool: m.byTool,
    })
  }
  return outcome
}

const recordTests = async (
  ctx: AttemptContext,
  cwd: string,
  outcome: AttemptOutcome,
): Promise<void> => {
  const { deps, plan, run, attempt, who } = ctx
  if (!plan.runTests) return
  const base = {
    schemaVersion: SCHEMA_VERSION,
    runId: run.id,
    attemptId: attempt.id,
    id: newId('tst'),
  }
  const skip = (note: string): void => {
    deps.storage.records.put('testResult', {
      ...base,
      command: plan.testCommand ?? '',
      status: 'skipped',
      durationMs: 0,
      note,
      outputTail: '',
    })
  }
  if (!plan.testCommand) return skip('no tests.command configured')
  if (outcome.status !== 'completed') return skip(`not run: attempt ${outcome.status}`)
  deps.reporter.phase(who, `running tests: ${plan.testCommand}`)
  const result = await runTestCommand(
    plan.testCommand,
    cwd,
    deps.project.config.tests.timeoutSec * 1000,
    deps.signal,
  )
  deps.storage.records.put('testResult', {
    ...base,
    command: plan.testCommand,
    status: result.status,
    exitCode: result.exitCode,
    durationMs: result.durationMs,
    passed: result.passed,
    failed: result.failed,
    note: result.note,
    outputTail: result.outputTail,
  })
  deps.storage.records.put('evaluation', {
    schemaVersion: SCHEMA_VERSION,
    id: newId('evl'),
    runId: run.id,
    attemptId: attempt.id,
    evaluator: 'tests',
    outcome: result.status === 'passed' ? 'pass' : result.status === 'failed' ? 'fail' : 'unknown',
    detail: result.status,
    createdAt: nowIso(),
  })
}

const finishAttempt = (
  ctx: AttemptContext,
  outcome: AttemptOutcome,
  startedMs: number,
): SidebetAttempt => {
  const done: SidebetAttempt = {
    ...ctx.attempt,
    status: outcome.status,
    summary: outcome.summary ? outcome.summary.slice(0, MAX_SUMMARY) : undefined,
    runtimeSession: outcome.sessionRef,
    error: outcome.error,
    completedAt: nowIso(),
    durationMs: Date.now() - startedMs,
  }
  ctx.deps.storage.records.put('attempt', done)
  return done
}

const newAttempt = (
  run: SidebetRun,
  model: ModelInfo,
  index: number,
  runtimeId: string,
): SidebetAttempt => ({
  id: newId('att'),
  schemaVersion: SCHEMA_VERSION,
  runId: run.id,
  label: LABELS[index] ?? String(index + 1),
  runtime: runtimeId,
  provider: model.provider,
  model: model.id,
  status: 'pending',
  changedFiles: [],
})

/** Single task in the working tree. The change set is the delta between two private tree snapshots. */
const executeSingle = async (
  deps: ExecDeps,
  plan: ExecutionPlan,
  run: SidebetRun,
): Promise<void> => {
  const model = plan.models[0] as ModelInfo
  let attempt = newAttempt(run, model, 0, deps.runtime.id)
  const who = { label: attempt.label, model: modelRef(model) }
  const started = Date.now()
  attempt = { ...attempt, status: 'running', startedAt: nowIso() }
  deps.storage.records.put('attempt', attempt)
  deps.reporter.attempt?.(who, 'running')
  const ctx: AttemptContext = { deps, plan, run, attempt, model, who }
  const root = deps.project.root

  const before = await snapshotTree(root)
  const outcome = await runAgent(ctx, root, deps.approve)
  const after = await snapshotTree(root)

  let changedFiles: string[] = []
  let lines: { added: number; removed: number } | undefined
  if (before !== after) {
    changedFiles = await diffNames(root, before, after)
    lines = await diffStat(root, before, after)
    saveDiff(deps, run, attempt, await diffPatch(root, before, after))
  }
  if (plan.readonly) {
    deps.storage.records.put('evaluation', {
      schemaVersion: SCHEMA_VERSION,
      id: newId('evl'),
      runId: run.id,
      attemptId: attempt.id,
      evaluator: 'readonly-check',
      outcome: before === after ? 'pass' : 'fail',
      detail:
        before === after
          ? 'working tree unchanged'
          : `working tree changed: ${changedFiles.join(', ')}`,
      createdAt: nowIso(),
    })
    if (before !== after)
      deps.reporter.warn(`Read-only run changed the working tree: ${changedFiles.join(', ')}`)
  }
  await recordTests(ctx, root, outcome)
  const done = finishAttempt(ctx, outcome, started)
  deps.storage.records.put('attempt', {
    ...done,
    changedFiles,
    linesAdded: lines?.added,
    linesRemoved: lines?.removed,
  })
  deps.reporter.attempt?.(who, done.status, done.error)
}

const executeCompareAttempt = async (
  deps: ExecDeps,
  plan: ExecutionPlan,
  run: SidebetRun,
  model: ModelInfo,
  index: number,
  base: string,
): Promise<void> => {
  let attempt = newAttempt(run, model, index, deps.runtime.id)
  const who = { label: attempt.label, model: modelRef(model) }
  const started = Date.now()
  attempt = { ...attempt, baseCommit: base, startedAt: nowIso() }
  deps.storage.records.put('attempt', attempt)
  const root = deps.project.root
  const exclude = deps.project.config.compare.linkPaths
  let worktree: string | undefined
  let outcome: AttemptOutcome = { status: 'failed', summary: '', error: 'attempt did not run' }
  try {
    if (deps.signal.aborted) throw new SidebetError('cancelled before start')
    deps.reporter.phase(who, 'creating worktree')
    worktree = await createWorktree(deps.project, run.id, attempt.label, base)
    attempt = { ...attempt, status: 'running', worktreePath: worktree }
    deps.storage.records.put('attempt', attempt)
    deps.reporter.attempt?.(who, 'running')
    if (deps.project.config.compare.setup) {
      deps.reporter.phase(who, `setup: ${deps.project.config.compare.setup}`)
      const setup = await runSetup(deps.project.config.compare.setup, worktree, deps.signal)
      saveLog(deps, run, attempt, 'setup.log', setup.output)
    }
    const ctx: AttemptContext = { deps, plan, run, attempt, model, who }
    outcome = await runAgent(ctx, worktree, undefined)

    // Capture whatever exists, even after failure/timeout/cancel: partial work is still evidence.
    deps.reporter.phase(who, 'capturing changes')
    const tree = await snapshotTree(worktree, exclude)
    const commit = await commitTree(
      worktree,
      tree,
      `sidebet: ${run.id} attempt ${attempt.label} (${who.model})`,
      base,
    )
    const ref = attemptRef(run.id, attempt.label)
    await updateRef(root, ref, commit)
    const patch = await diffPatch(root, base, commit)
    const changedFiles = patch ? await diffNames(root, base, commit) : []
    if (patch) saveDiff(deps, run, attempt, patch)
    const lines = patch ? await diffStat(root, base, commit) : { added: 0, removed: 0 }
    attempt = {
      ...attempt,
      resultCommit: commit,
      resultRef: ref,
      changedFiles,
      linesAdded: lines.added,
      linesRemoved: lines.removed,
    }
    deps.storage.records.put('attempt', attempt)
    await recordTests({ ...ctx, attempt }, worktree, outcome)
  } catch (err) {
    outcome = {
      status: deps.signal.aborted ? 'cancelled' : 'failed',
      summary: outcome.summary,
      usage: outcome.usage,
      error: err instanceof Error ? err.message : String(err),
    }
  } finally {
    const done = finishAttempt({ deps, plan, run, attempt, model, who }, outcome, started)
    deps.reporter.attempt?.(who, done.status, done.error)
    deps.storage.records.put('attempt', {
      ...done,
      worktreePath: deps.project.config.compare.keepWorktrees ? worktree : undefined,
    })
    if (worktree && !deps.project.config.compare.keepWorktrees) {
      await removeWorktree(deps.project, worktree).catch(() => {})
    }
  }
}

const deriveStatus = (statuses: string[], aborted: boolean): RunStatus => {
  if (aborted) return 'cancelled'
  const ok = statuses.filter((s) => s === 'completed').length
  if (ok === statuses.length) return 'completed'
  return ok > 0 ? 'partial' : 'failed'
}

export const executePlan = async (
  deps: ExecDeps,
  plan: ExecutionPlan,
  options: ExecutePlanOptions = {},
): Promise<RunDetail> => {
  const { storage, project } = deps
  const policyRecord = {
    id: project.policyVersion,
    schemaVersion: SCHEMA_VERSION,
    hash: project.policyVersion.replace('pol_', ''),
    policy: project.policy as unknown as Record<string, unknown>,
    sources: project.sources,
    createdAt: nowIso(),
  }
  if (!storage.records.get('policy', policyRecord.id)) storage.records.put('policy', policyRecord)
  storage.records.put('snapshot', plan.snapshot)

  let run: SidebetRun = {
    id: newId('run'),
    schemaVersion: SCHEMA_VERSION,
    projectId: project.projectId,
    kind: plan.kind,
    task: plan.task,
    category: plan.category,
    status: 'running',
    readonly: plan.readonly,
    contextSnapshotId: plan.snapshot.id,
    policyVersion: project.policyVersion,
    configVersion: project.configVersion,
    parentRunId: options.parentRunId,
    contextMode: plan.contextMode,
    createdAt: nowIso(),
  }
  storage.records.put('run', run)

  try {
    if (plan.kind === 'run') {
      run = { ...run, baseCommit: await headCommit(project.root) }
      storage.records.put('run', run)
      await executeSingle(deps, plan, run)
    } else {
      const base = await prepareCompareBase(project, run.id)
      run = { ...run, baseCommit: base.commit }
      storage.records.put('run', run)
      if (base.snapshotted) {
        deps.reporter.info(
          `Attempts start from a snapshot of your working tree (${base.dirtyFiles.length} uncommitted change(s) included). Your files are untouched.`,
        )
      }
      await pool(plan.models, plan.concurrency, (model, i) =>
        executeCompareAttempt(deps, plan, run, model, i, base.commit),
      )
    }
  } catch (err) {
    run = { ...run, status: 'failed', completedAt: nowIso() }
    storage.records.put('run', run)
    throw err
  }

  const statuses = storage.records.list('attempt', { runId: run.id }).map((a) => a.status)
  run = { ...run, status: deriveStatus(statuses, deps.signal.aborted), completedAt: nowIso() }
  storage.records.put('run', run)
  return loadRunDetail(storage, run.id)
}
