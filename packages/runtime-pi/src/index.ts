import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'
import {
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionFactory,
  getAgentDir,
  type InlineExtension,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  VERSION,
} from '@earendil-works/pi-coding-agent'
import {
  type AgentRuntime,
  type AttemptOutcome,
  type AttemptRequest,
  type AttemptUsage,
  allowedToolNames,
  evaluateToolCall,
  READ_ONLY_TOOLS,
  type RuntimeInfo,
  summarizeToolCall,
} from '@sidebet/core'

export interface PiRuntimeOptions {
  /** Defaults to Pi's own agent dir (~/.pi/agent or PI_CODING_AGENT_DIR). */
  agentDir?: string
  /** Pi model runtime (credentials + model catalog). Defaults to Pi's own files under agentDir. */
  modelRuntime?: ModelRuntime | Promise<ModelRuntime>
  /** Additional inline extensions. Intended for tests. */
  extensionFactories?: ExtensionFactory[]
}

const DEFAULT_TOOLS = ['read', 'bash', 'edit', 'write']
const POLICY_EXTENSION = 'sidebet-policy'

const textOf = (content: unknown): string => {
  if (!Array.isArray(content)) return typeof content === 'string' ? content : ''
  return content
    .map((c: { type?: string; text?: string }) =>
      c.type === 'text' && typeof c.text === 'string' ? c.text : '',
    )
    .join('')
}

/** Pi's built-in tools take either `path` or `file_path`; normalise to a repo-relative path. */
const makeRelative =
  (cwd: string) =>
  (p: string): string => {
    const expanded = p.startsWith('~/') ? join(homedir(), p.slice(2)) : p
    const abs = isAbsolute(expanded) ? expanded : resolve(cwd, expanded)
    const rel = relative(cwd, abs)
    return rel === '' ? '.' : rel
  }

export class PiRuntime implements AgentRuntime {
  readonly id = 'pi'
  private readonly agentDir: string
  private runtimePromise: Promise<ModelRuntime> | undefined

  constructor(private readonly options: PiRuntimeOptions = {}) {
    this.agentDir = options.agentDir ?? getAgentDir()
  }

  /** Created once per process. Reads Pi's auth.json, models.json and its model catalog. */
  private modelRuntime(): Promise<ModelRuntime> {
    this.runtimePromise ??= this.options.modelRuntime
      ? Promise.resolve(this.options.modelRuntime)
      : ModelRuntime.create({ authPath: join(this.agentDir, 'auth.json') })
    return this.runtimePromise
  }

  async detect(cwd: string = process.cwd()): Promise<RuntimeInfo> {
    const notes: string[] = []
    const problems: string[] = []
    const runtime = await this.modelRuntime()
    const err = runtime.getError()
    if (err) problems.push(`models.json: ${err}`)
    // Resolves credentials and provider-side model lists (e.g. Copilot's allowed model ids).
    const available = await runtime.getAvailable()
    const models = available.map((m) => ({
      provider: String(m.provider),
      id: m.id,
      name: m.name,
      contextWindow: m.contextWindow,
    }))
    const settings = SettingsManager.create(cwd, this.agentDir)
    const dp = settings.getDefaultProvider()
    const dm = settings.getDefaultModel()
    const defaultModel = dp && dm ? `${dp}/${dm}` : undefined
    if (defaultModel && !models.some((m) => `${m.provider}/${m.id}` === defaultModel)) {
      notes.push(
        `Pi default model ${defaultModel} has no credentials; Sidebet will pick another eligible model.`,
      )
    }
    if (!existsSync(this.agentDir))
      notes.push(
        `No Pi config directory at ${this.agentDir} (Pi has not been run on this machine yet).`,
      )
    if (models.length === 0)
      problems.push(
        'No models with credentials. Run `pi` and /login, or set a provider API key such as ANTHROPIC_API_KEY.',
      )
    const globalContext = join(this.agentDir, 'AGENTS.md')
    return {
      id: 'pi',
      available: true,
      version: VERSION,
      configDir: this.agentDir,
      models,
      defaultModel:
        defaultModel && models.some((m) => `${m.provider}/${m.id}` === defaultModel)
          ? defaultModel
          : undefined,
      skillDirs: [
        join(this.agentDir, 'skills'),
        join(homedir(), '.agents', 'skills'),
        ...settings.getSkillPaths(),
      ],
      globalContextFiles: existsSync(globalContext) ? [globalContext] : [],
      notes,
      problems,
    }
  }

  async execute(req: AttemptRequest): Promise<AttemptOutcome> {
    // Tells the Sidebet Pi extension (if installed) not to inject context a second time.
    process.env.SIDEBET_SESSION = '1'
    const modelRuntime = await this.modelRuntime()
    const model = modelRuntime.getModel(req.model.provider, req.model.id)
    if (!model) {
      return {
        status: 'failed',
        summary: '',
        error: `Pi does not know model ${req.model.provider}/${req.model.id}`,
      }
    }
    const readonly = req.readonly || req.policy.readonly
    const available = readonly ? [...READ_ONLY_TOOLS] : DEFAULT_TOOLS
    const toolNames = allowedToolNames(req.policy, readonly, available)
    const restrictTools = readonly || toolNames.length !== DEFAULT_TOOLS.length

    // Real enforcement: runs inside Pi before every tool call and can block it.
    const denied = new Set<string>()
    const approved = new Set<string>()
    const rel = makeRelative(req.cwd)
    const enforcementFactory: ExtensionFactory = (pi) => {
      pi.on('tool_call', async (event) => {
        const input = (event.input ?? {}) as Record<string, unknown>
        const call = { tool: event.toolName, input }
        const summary = summarizeToolCall(call)
        let decision = evaluateToolCall(req.policy, readonly, call, rel)
        if (decision.allowed && decision.needsApproval) {
          const ok = req.approve
            ? await req.approve({ tool: event.toolName, summary, reason: decision.reason })
            : false
          if (ok) approved.add(event.toolCallId)
          else {
            decision = {
              allowed: false,
              reason: `${decision.reason}; ${req.approve ? 'not approved by the developer' : 'no interactive approval available here, so it is denied'}`,
            }
          }
        }
        if (!decision.allowed) {
          denied.add(event.toolCallId)
          req.onEvent({
            type: 'tool-denied',
            id: event.toolCallId,
            tool: event.toolName,
            summary,
            reason: decision.reason,
          })
          return { block: true, reason: `Blocked by Sidebet policy: ${decision.reason}` }
        }
        return undefined
      })
    }

    const enforcement: InlineExtension = {
      name: POLICY_EXTENSION,
      factory: enforcementFactory,
      hidden: true,
    }
    const settingsManager = SettingsManager.create(req.cwd, this.agentDir)
    const loader = new DefaultResourceLoader({
      cwd: req.cwd,
      agentDir: this.agentDir,
      settingsManager,
      noContextFiles: !req.nativeContextFiles,
      noExtensions: readonly,
      appendSystemPrompt: req.contextPrompt ? [req.contextPrompt] : [],
      extensionFactories: [enforcement, ...(this.options.extensionFactories ?? [])],
    })
    await loader.reload()

    const { session, extensionsResult } = await createAgentSession({
      cwd: req.cwd,
      agentDir: this.agentDir,
      model,
      modelRuntime,
      resourceLoader: loader,
      settingsManager,
      sessionManager: req.persistSession
        ? SessionManager.create(req.cwd)
        : SessionManager.inMemory(),
      ...(restrictTools ? { tools: toolNames } : {}),
    })

    // Fail closed: if the enforcement hook did not load, do not run the agent without it.
    const hookPath = `<inline:${POLICY_EXTENSION}>`
    const hookErrors = extensionsResult.errors.filter((e) => e.path === hookPath)
    const hookLoaded = extensionsResult.extensions.some((e) => e.path === hookPath)
    if (hookErrors.length > 0 || !hookLoaded) {
      session.dispose()
      return {
        status: 'failed',
        summary: '',
        error: `Sidebet policy hook failed to load in Pi (${hookErrors[0]?.error ?? 'not registered'}); refusing to run without enforcement.`,
      }
    }

    try {
      session.setSessionName(`sidebet: ${req.task.slice(0, 60)}`)
    } catch {
      // naming is cosmetic
    }

    const usage: AttemptUsage = {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 0,
      turns: 0,
    }
    let cost = 0
    let lastText = ''
    let lastError: string | undefined
    let stopReason: string | undefined
    const started = new Map<string, string>()
    const unsubscribe = session.subscribe((event) => {
      switch (event.type) {
        case 'message_update':
          if (event.assistantMessageEvent.type === 'text_delta') {
            req.onEvent({ type: 'text', delta: event.assistantMessageEvent.delta })
          }
          break
        case 'tool_execution_start': {
          if (denied.has(event.toolCallId)) break
          const summary = summarizeToolCall({
            tool: event.toolName,
            input: (event.args ?? {}) as Record<string, unknown>,
          })
          started.set(event.toolCallId, summary)
          req.onEvent({
            type: 'tool-start',
            id: event.toolCallId,
            tool: event.toolName,
            summary,
            approved: approved.has(event.toolCallId),
          })
          break
        }
        case 'tool_execution_end':
          if (denied.has(event.toolCallId)) break
          req.onEvent({
            type: 'tool-end',
            id: event.toolCallId,
            tool: event.toolName,
            summary: started.get(event.toolCallId) ?? '',
            isError: Boolean(event.isError),
          })
          break
        case 'message_end': {
          const m = event.message
          if (m.role === 'assistant') {
            usage.inputTokens += m.usage.input
            usage.outputTokens += m.usage.output
            usage.cacheReadTokens += m.usage.cacheRead
            usage.cacheWriteTokens += m.usage.cacheWrite
            usage.totalTokens += m.usage.totalTokens
            cost += m.usage.cost.total
            usage.turns += 1
            req.onEvent({
              type: 'usage',
              turn: usage.turns,
              inputTokens: m.usage.input,
              outputTokens: m.usage.output,
              cacheReadTokens: m.usage.cacheRead,
              cacheWriteTokens: m.usage.cacheWrite,
              costUsd: m.usage.cost.total > 0 ? m.usage.cost.total : undefined,
            })
            const text = textOf(m.content)
            if (text) lastText = text
            stopReason = m.stopReason
            lastError = m.errorMessage
          }
          break
        }
        default:
          break
      }
    })

    let timedOut = false
    let cancelled = false
    // If a provider ignores abort, stop waiting after a grace period instead of hanging forever.
    let releaseGrace: () => void = () => {}
    const grace = new Promise<void>((resolve) => {
      releaseGrace = resolve
    })
    const stop = (): void => {
      void session.abort().catch(() => {})
      setTimeout(releaseGrace, 5000).unref()
    }
    const timer = setTimeout(() => {
      timedOut = true
      stop()
    }, req.timeoutMs)
    const onAbort = (): void => {
      cancelled = true
      stop()
    }
    if (req.signal.aborted) onAbort()
    req.signal.addEventListener('abort', onAbort, { once: true })

    const sessionRef = session.sessionFile
    try {
      if (!cancelled) await Promise.race([session.prompt(req.task), grace])
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err)
      stopReason = 'error'
    } finally {
      clearTimeout(timer)
      req.signal.removeEventListener('abort', onAbort)
      unsubscribe()
      session.dispose()
    }

    const result: Pick<AttemptOutcome, 'summary' | 'usage' | 'sessionRef'> = {
      summary: lastText,
      usage: usage.turns > 0 ? { ...usage, costUsd: cost > 0 ? cost : undefined } : undefined,
      sessionRef,
    }
    if (timedOut)
      return {
        status: 'timeout',
        error: `timed out after ${Math.round(req.timeoutMs / 1000)}s`,
        ...result,
      }
    if (cancelled || stopReason === 'aborted') return { status: 'cancelled', ...result }
    if (stopReason === 'error')
      return { status: 'failed', error: lastError ?? 'model returned an error', ...result }
    return { status: 'completed', ...result }
  }
}

export const createPiRuntime = (options?: PiRuntimeOptions): PiRuntime => new PiRuntime(options)
