import type { Policy } from './policy/schema.js'

export interface ModelInfo {
  provider: string
  id: string
  name?: string
  contextWindow?: number
}

export const modelRef = (m: { provider: string; id: string }): string => `${m.provider}/${m.id}`

export interface RuntimeInfo {
  id: string
  available: boolean
  version?: string
  /** Runtime's own configuration directory, e.g. ~/.pi/agent. */
  configDir?: string
  /** Models with working credentials. */
  models: ModelInfo[]
  /** "provider/model" the runtime would use by default. */
  defaultModel?: string
  /** Global directories the runtime loads skills from. */
  skillDirs: string[]
  /** Global context files the runtime loads on its own (e.g. ~/.pi/agent/AGENTS.md). */
  globalContextFiles: string[]
  /** Human-readable diagnostics for `sidebet doctor`. */
  notes: string[]
  problems: string[]
}

export type RuntimeEvent =
  | { type: 'text'; delta: string }
  | { type: 'tool-start'; id: string; tool: string; summary: string; approved?: boolean }
  | { type: 'tool-end'; id: string; tool: string; summary: string; isError: boolean }
  | { type: 'tool-denied'; id: string; tool: string; summary: string; reason: string }
  | { type: 'warning'; message: string }
  /** Emitted after every model turn with that turn's usage (not cumulative). */
  | {
      type: 'usage'
      turn: number
      inputTokens: number
      outputTokens: number
      cacheReadTokens: number
      cacheWriteTokens: number
      /** Only when the runtime reported one. */
      costUsd?: number
    }

export interface AttemptRequest {
  /** Directory the agent works in (repo root, or an isolated worktree). */
  cwd: string
  task: string
  model: { provider: string; id: string }
  /** Text appended to the system prompt: rules, memory, task context. */
  contextPrompt: string
  /** If false the runtime must not load context files (AGENTS.md etc.) itself. */
  nativeContextFiles: boolean
  policy: Policy
  /** Enforce no mutation: runtime must not expose write-capable tools. */
  readonly: boolean
  /** Keep the runtime's own session log (so the developer can resume it in the runtime). */
  persistSession: boolean
  signal: AbortSignal
  timeoutMs: number
  onEvent: (event: RuntimeEvent) => void
  /** Ask a human to approve an operation. Absent in non-interactive/concurrent contexts => deny. */
  approve?: (request: { tool: string; summary: string; reason: string }) => Promise<boolean>
}

export interface AttemptUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  totalTokens: number
  /** Only when the runtime reported a cost > 0. */
  costUsd?: number
  turns: number
}

export interface AttemptOutcome {
  status: 'completed' | 'failed' | 'timeout' | 'cancelled'
  /** Final assistant message text. */
  summary: string
  usage?: AttemptUsage
  error?: string
  /** Runtime-native session reference (e.g. a Pi session file path). */
  sessionRef?: string
}

/**
 * Boundary between Sidebet and any agent runtime. Pi is the first implementation.
 * Nothing in @sidebet/core imports a runtime package.
 */
export interface AgentRuntime {
  readonly id: string
  detect(): Promise<RuntimeInfo>
  execute(request: AttemptRequest): Promise<AttemptOutcome>
}
