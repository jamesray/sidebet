import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { AgentRuntime, AttemptOutcome, AttemptRequest, RuntimeInfo } from '../runtime.js'

export interface FakeScript {
  /** Files written into the working directory. */
  files?: Record<string, string>
  summary?: string
  /** Simulated duration. */
  delayMs?: number
  fail?: string
  /** Never finish until aborted. */
  hang?: boolean
  usage?: { inputTokens: number; outputTokens: number; costUsd?: number }
}

export interface FakeRuntimeOptions {
  models?: Array<{ provider: string; id: string }>
  defaultModel?: string
  /** Per "provider/id" script, or a function. */
  scripts?: Record<string, FakeScript> | ((req: AttemptRequest) => FakeScript)
  skillDirs?: string[]
  globalContextFiles?: string[]
}

/** Deterministic runtime for tests and offline demos (SIDEBET_RUNTIME=fake). Makes no model calls. */
export class FakeRuntime implements AgentRuntime {
  readonly id = 'fake'
  readonly requests: AttemptRequest[] = []
  constructor(private readonly options: FakeRuntimeOptions = {}) {}

  async detect(): Promise<RuntimeInfo> {
    const models = this.options.models ?? [
      { provider: 'fakeai', id: 'alpha' },
      { provider: 'fakeai', id: 'beta' },
    ]
    return {
      id: 'fake',
      available: true,
      version: '0.0.0',
      models,
      defaultModel: this.options.defaultModel ?? `${models[0]?.provider}/${models[0]?.id}`,
      skillDirs: this.options.skillDirs ?? [],
      globalContextFiles: this.options.globalContextFiles ?? [],
      notes: [],
      problems: [],
    }
  }

  async execute(req: AttemptRequest): Promise<AttemptOutcome> {
    this.requests.push(req)
    const ref = `${req.model.provider}/${req.model.id}`
    const s =
      typeof this.options.scripts === 'function'
        ? this.options.scripts(req)
        : (this.options.scripts?.[ref] ?? {})
    if (s.hang) {
      await new Promise<void>((resolve) => {
        if (req.signal.aborted) return resolve()
        req.signal.addEventListener('abort', () => resolve(), { once: true })
        setTimeout(resolve, req.timeoutMs).unref()
      })
      return { status: req.signal.aborted ? 'cancelled' : 'timeout', summary: '' }
    }
    if (s.delayMs) await new Promise((r) => setTimeout(r, s.delayMs))
    if (req.signal.aborted) return { status: 'cancelled', summary: '' }
    if (s.fail) return { status: 'failed', summary: '', error: s.fail }
    for (const [path, content] of Object.entries(s.files ?? {})) {
      const id = `${ref}:${path}`
      if (req.readonly) {
        req.onEvent({
          type: 'tool-denied',
          id,
          tool: 'write',
          summary: path,
          reason: 'this run is read-only',
        })
        continue
      }
      req.onEvent({ type: 'tool-start', id, tool: 'write', summary: path })
      const full = join(req.cwd, path)
      await mkdir(dirname(full), { recursive: true })
      await writeFile(full, content)
      req.onEvent({ type: 'tool-end', id, tool: 'write', summary: path, isError: false })
    }
    const summary = s.summary ?? `fake ${ref} finished: ${req.task}`
    req.onEvent({ type: 'text', delta: summary })
    const u = s.usage ?? { inputTokens: 100, outputTokens: 20 }
    req.onEvent({
      type: 'usage',
      turn: 1,
      inputTokens: u.inputTokens,
      outputTokens: u.outputTokens,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: u.costUsd,
    })
    return {
      status: 'completed',
      summary,
      usage: {
        inputTokens: u.inputTokens,
        outputTokens: u.outputTokens,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: u.inputTokens + u.outputTokens,
        costUsd: u.costUsd,
        turns: 1,
      },
    }
  }
}
