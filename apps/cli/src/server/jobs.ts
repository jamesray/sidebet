import { randomBytes } from 'node:crypto'
import {
  type AgentRuntime,
  type AttemptStatus,
  type ExecutionPlan,
  executePlan,
  type ProjectContext,
  type Reporter,
  type RunStatus,
  type RuntimeEvent,
  type RuntimeInfo,
  SidebetError,
  type Storage,
} from '@sidebet/core'

/** Per-attempt live figures, the browser counterpart of the terminal dashboard's Gauge. */
export interface JobGauge {
  label: string
  model: string
  status: AttemptStatus | 'pending'
  startedAt?: string
  endedAt?: string
  turns: number
  tools: number
  denied: number
  errors: number
  input: number
  output: number
  cacheRead: number
  cost?: number
  /** What the attempt is doing right now (phase, current tool, "thinking"). */
  current: string
  /** Milliseconds from attempt start to the first allowed write/edit. */
  firstEditMs?: number
  error?: string
  /** Tail of the streamed assistant text (single runs only). */
  text: string
}

export type JobEventKind = 'info' | 'warn' | 'phase' | 'tool' | 'tool-error' | 'blocked' | 'status'

export interface JobEvent {
  at: string
  label?: string
  kind: JobEventKind
  text: string
}

export interface JobApproval {
  id: string
  label: string
  tool: string
  summary: string
  reason: string
  requestedAt: string
  decision?: 'allowed' | 'denied'
  decidedBy?: 'user' | 'timeout' | 'cancel'
}

export interface JobState {
  id: string
  kind: 'run' | 'compare'
  task: string
  /** running until executePlan settles; finished means the run record has its final status. */
  status: 'running' | 'finished' | 'failed'
  runId?: string
  runStatus?: RunStatus
  parentRunId?: string
  startedAt: string
  endedAt?: string
  error?: string
  cancelling: boolean
  attempts: JobGauge[]
  events: JobEvent[]
  approvals: JobApproval[]
}

export interface JobDeps {
  storage: Storage
  runtime: AgentRuntime
  runtimeInfo: RuntimeInfo
  project: ProjectContext
}

interface Job {
  state: JobState
  controller: AbortController
  pending: Map<string, (allow: boolean, by: JobApproval['decidedBy']) => void>
}

const LABELS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
const MAX_EVENTS = 400
const MAX_TEXT = 20_000
const KEEP_JOBS = 20
/** An approval nobody answers is denied, like a non-interactive terminal. */
export const APPROVAL_TIMEOUT_MS = 10 * 60_000

const nowIso = (): string => new Date().toISOString()

/**
 * Runs plans for the web UI, one at a time, and keeps a browser-readable picture of progress.
 * It is the same `executePlan` the CLI calls; only the reporter differs.
 */
export class JobRunner {
  private readonly jobs = new Map<string, Job>()

  get active(): JobState | undefined {
    for (const j of this.jobs.values()) if (j.state.status === 'running') return j.state
    return undefined
  }

  list(): JobState[] {
    return [...this.jobs.values()].map((j) => j.state).reverse()
  }

  get(id: string): JobState | undefined {
    return this.jobs.get(id)?.state
  }

  start(
    deps: JobDeps,
    plan: ExecutionPlan,
    options: { parentRunId?: string; approvalTimeoutMs?: number } = {},
  ): JobState {
    const active = this.active
    if (active) {
      throw new SidebetError(
        `Job ${active.id} is still running.`,
        'Wait for it to finish, or cancel it first. One job runs at a time in this repository.',
      )
    }
    const id = `job_${randomBytes(4).toString('hex')}`
    const controller = new AbortController()
    const state: JobState = {
      id,
      kind: plan.kind,
      task: plan.task,
      status: 'running',
      parentRunId: options.parentRunId,
      startedAt: nowIso(),
      cancelling: false,
      attempts: plan.models.map((m, i) => ({
        label: LABELS[i] ?? String(i + 1),
        model: `${m.provider}/${m.id}`,
        status: 'pending',
        turns: 0,
        tools: 0,
        denied: 0,
        errors: 0,
        input: 0,
        output: 0,
        cacheRead: 0,
        current: plan.kind === 'compare' ? 'waiting for a worktree' : 'starting',
        text: '',
      })),
      events: [],
      approvals: [],
    }
    const job: Job = { state, controller, pending: new Map() }
    this.jobs.set(id, job)
    this.trim()

    const push = (kind: JobEventKind, text: string, label?: string): void => {
      state.events.push({ at: nowIso(), kind, text, label })
      if (state.events.length > MAX_EVENTS) state.events.splice(0, state.events.length - MAX_EVENTS)
    }
    const gauge = (who: { label: string }): JobGauge | undefined =>
      state.attempts.find((g) => g.label === who.label)
    const started = new Map<string, number>()

    const reporter: Reporter = {
      info: (m) => push('info', m),
      warn: (m) => push('warn', m),
      run: (run) => {
        state.runId = run.id
      },
      phase: (who, m) => {
        const g = gauge(who)
        if (g) g.current = m
        push('phase', m, who.label)
      },
      attempt: (who, status, error) => {
        const g = gauge(who)
        if (!g) return
        g.status = status
        if (status === 'running') {
          g.startedAt ??= nowIso()
          g.current = 'waiting for the model'
          started.set(who.label, Date.now())
        } else g.endedAt = nowIso()
        if (error) g.error = error
        push('status', `${status}${error ? `: ${error}` : ''}`, who.label)
      },
      event: (who, e: RuntimeEvent) => {
        const g = gauge(who)
        if (!g) return
        switch (e.type) {
          case 'tool-start':
            g.tools += 1
            g.current = `${e.tool} ${e.summary}`
            if ((e.tool === 'write' || e.tool === 'edit') && g.firstEditMs === undefined)
              g.firstEditMs = Date.now() - (started.get(who.label) ?? Date.now())
            push('tool', `${e.tool} ${e.summary}${e.approved ? ' (approved)' : ''}`, who.label)
            break
          case 'tool-end':
            if (e.isError) {
              g.errors += 1
              push('tool-error', `${e.tool} failed`, who.label)
            }
            g.current = e.isError ? `${e.tool} failed` : 'thinking'
            break
          case 'tool-denied':
            g.denied += 1
            g.current = `${e.tool} blocked: ${e.reason}`
            push('blocked', `${e.tool} ${e.summary}: ${e.reason}`, who.label)
            break
          case 'usage':
            g.turns = Math.max(g.turns, e.turn)
            g.input += e.inputTokens
            g.output += e.outputTokens
            g.cacheRead += e.cacheReadTokens
            if (e.costUsd !== undefined) g.cost = (g.cost ?? 0) + e.costUsd
            break
          case 'text':
            g.current = 'writing'
            g.text = (g.text + e.delta).slice(-MAX_TEXT)
            break
          case 'warning':
            push('warn', e.message, who.label)
            break
        }
      },
    }

    // Approvals only exist for single runs; compare attempts never prompt (same as the CLI).
    const timeoutMs = options.approvalTimeoutMs ?? APPROVAL_TIMEOUT_MS
    const approve =
      plan.kind === 'run'
        ? (req: { tool: string; summary: string; reason: string }): Promise<boolean> =>
            new Promise<boolean>((resolve) => {
              const approval: JobApproval = {
                id: `apr_${randomBytes(4).toString('hex')}`,
                label: state.attempts[0]?.label ?? 'A',
                tool: req.tool,
                summary: req.summary,
                reason: req.reason,
                requestedAt: nowIso(),
              }
              state.approvals.push(approval)
              push('warn', `approval needed: ${req.tool} ${req.summary}`, approval.label)
              const settle = (allow: boolean, by: JobApproval['decidedBy']): void => {
                if (approval.decision) return
                approval.decision = allow ? 'allowed' : 'denied'
                approval.decidedBy = by
                job.pending.delete(approval.id)
                clearTimeout(timer)
                resolve(allow)
              }
              const timer = setTimeout(() => settle(false, 'timeout'), timeoutMs)
              timer.unref()
              controller.signal.addEventListener('abort', () => settle(false, 'cancel'), {
                once: true,
              })
              job.pending.set(approval.id, settle)
            })
        : undefined

    executePlan(
      {
        storage: deps.storage,
        runtime: deps.runtime,
        runtimeInfo: deps.runtimeInfo,
        project: deps.project,
        reporter,
        signal: controller.signal,
        approve,
      },
      plan,
      { parentRunId: options.parentRunId },
    )
      .then((detail) => {
        state.status = 'finished'
        state.runId = detail.run.id
        state.runStatus = detail.run.status
      })
      .catch((err: unknown) => {
        state.status = 'failed'
        state.error = err instanceof Error ? err.message : String(err)
        push('warn', state.error)
      })
      .finally(() => {
        state.endedAt = nowIso()
        for (const settle of job.pending.values()) settle(false, 'cancel')
      })
    return state
  }

  cancel(id: string): JobState {
    const job = this.require(id)
    if (job.state.status === 'running' && !job.state.cancelling) {
      job.state.cancelling = true
      job.controller.abort()
      job.state.events.push({
        at: nowIso(),
        kind: 'warn',
        text: 'cancelling: stopping agents and keeping partial work',
      })
    }
    return job.state
  }

  decide(id: string, approvalId: string, allow: boolean): JobState {
    const job = this.require(id)
    const settle = job.pending.get(approvalId)
    if (!settle) {
      throw new SidebetError(
        `Approval ${approvalId} is not pending.`,
        'It was already answered, timed out, or the job ended.',
      )
    }
    settle(allow, 'user')
    return job.state
  }

  private require(id: string): Job {
    const job = this.jobs.get(id)
    if (!job) throw new SidebetError(`Job ${id} not found.`)
    return job
  }

  private trim(): void {
    const finished = [...this.jobs.values()].filter((j) => j.state.status !== 'running')
    while (this.jobs.size > KEEP_JOBS && finished.length > 0) {
      const oldest = finished.shift()
      if (oldest) this.jobs.delete(oldest.state.id)
    }
  }
}
