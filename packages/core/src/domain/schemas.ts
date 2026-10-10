import { z } from 'zod'

/** Bump when a persisted record shape changes incompatibly. */
export const SCHEMA_VERSION = 1

export const RunStatus = z.enum([
  'pending',
  'running',
  'completed',
  'partial',
  'failed',
  'cancelled',
])
export type RunStatus = z.infer<typeof RunStatus>

export const AttemptStatus = z.enum([
  'pending',
  'running',
  'completed',
  'failed',
  'timeout',
  'cancelled',
])
export type AttemptStatus = z.infer<typeof AttemptStatus>

export const RunKind = z.enum(['run', 'compare'])
export type RunKind = z.infer<typeof RunKind>

export const TaskCategory = z.enum([
  'bugfix',
  'feature',
  'refactor',
  'test',
  'docs',
  'question',
  'other',
])
export type TaskCategory = z.infer<typeof TaskCategory>

export const SidebetRunSchema = z.object({
  id: z.string(),
  schemaVersion: z.number().int(),
  projectId: z.string(),
  kind: RunKind,
  task: z.string(),
  category: TaskCategory,
  status: RunStatus,
  readonly: z.boolean(),
  contextSnapshotId: z.string(),
  policyVersion: z.string(),
  configVersion: z.string(),
  /** Commit the run started from (HEAD, or the snapshot commit for compare runs). */
  baseCommit: z.string().optional(),
  /** Set when this run is a rerun of another. */
  parentRunId: z.string().optional(),
  contextMode: z.enum(['fresh', 'original']).default('fresh'),
  createdAt: z.string(),
  completedAt: z.string().optional(),
})
export type SidebetRun = z.infer<typeof SidebetRunSchema>

export const SidebetAttemptSchema = z.object({
  id: z.string(),
  schemaVersion: z.number().int(),
  runId: z.string(),
  /** Human-friendly label within a run: A, B, C... */
  label: z.string(),
  runtime: z.string(),
  provider: z.string(),
  model: z.string(),
  status: AttemptStatus,
  worktreePath: z.string().optional(),
  baseCommit: z.string().optional(),
  /** Commit holding the attempt's resulting tree; kept alive by `resultRef`. */
  resultCommit: z.string().optional(),
  resultRef: z.string().optional(),
  changedFiles: z.array(z.string()).default([]),
  linesAdded: z.number().optional(),
  linesRemoved: z.number().optional(),
  runtimeSession: z.string().optional(),
  summary: z.string().optional(),
  error: z.string().optional(),
  startedAt: z.string().optional(),
  completedAt: z.string().optional(),
  durationMs: z.number().optional(),
})
export type SidebetAttempt = z.infer<typeof SidebetAttemptSchema>

export const ContextItemSchema = z.object({
  id: z.string(),
  kind: z.enum(['agents', 'rule', 'doc', 'memory', 'skill', 'task']),
  /** File path (repo-relative or absolute), memory id, or skill name. */
  source: z.string(),
  scope: z.enum(['global', 'project', 'task']),
  /** Higher wins. Used for ordering and for dropping items when over budget. */
  priority: z.number(),
  /** injected: Sidebet puts it in the prompt. pi-native: the runtime loads it itself. omitted: not delivered. */
  delivery: z.enum(['injected', 'native', 'omitted']),
  tokens: z.number(),
  contentHash: z.string(),
  /** Redacted content, kept for injected items only. */
  content: z.string().optional(),
  reason: z.string(),
  redactions: z.number().default(0),
})
export type ContextItem = z.infer<typeof ContextItemSchema>

export const ContextSnapshotSchema = z.object({
  id: z.string(),
  schemaVersion: z.number().int(),
  projectId: z.string(),
  task: z.string(),
  createdAt: z.string(),
  budgetTokens: z.number(),
  injectedTokens: z.number(),
  nativeTokens: z.number(),
  /** False when Sidebet had to take over context-file delivery to satisfy policy. */
  nativeContextFiles: z.boolean(),
  items: z.array(ContextItemSchema),
  /** Exact text appended to the agent's system prompt. */
  rendered: z.string(),
  hash: z.string(),
})
export type ContextSnapshot = z.infer<typeof ContextSnapshotSchema>

export const PolicyRecordSchema = z.object({
  id: z.string(),
  schemaVersion: z.number().int(),
  hash: z.string(),
  policy: z.record(z.string(), z.unknown()),
  sources: z.array(z.string()),
  createdAt: z.string(),
})
export type PolicyRecord = z.infer<typeof PolicyRecordSchema>

export const ToolEventSchema = z.object({
  id: z.string(),
  schemaVersion: z.number().int(),
  runId: z.string(),
  attemptId: z.string(),
  tool: z.string(),
  summary: z.string(),
  decision: z.enum(['allowed', 'denied', 'approved']),
  status: z.enum(['ok', 'error', 'denied']),
  reason: z.string().optional(),
  startedAt: z.string(),
  durationMs: z.number().optional(),
})
export type ToolEvent = z.infer<typeof ToolEventSchema>

export const UsageMetricsSchema = z.object({
  id: z.string(),
  schemaVersion: z.number().int(),
  runId: z.string(),
  attemptId: z.string(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  cacheReadTokens: z.number(),
  cacheWriteTokens: z.number(),
  totalTokens: z.number(),
  /** Only set when the runtime reported a non-zero cost. Never estimated by Sidebet. */
  costUsd: z.number().optional(),
  turns: z.number(),
  /** Agent wall time only (excludes worktree setup and tests). */
  agentDurationMs: z.number().optional(),
  /** Until the first streamed assistant text or first tool call. */
  timeToFirstTokenMs: z.number().optional(),
  /** Until the first write/edit tool call that was allowed to run. */
  timeToFirstEditMs: z.number().optional(),
  toolCalls: z.number().default(0),
  toolErrors: z.number().default(0),
  toolsDenied: z.number().default(0),
  toolCallsByTool: z.record(z.string(), z.number()).default({}),
})
export type UsageMetrics = z.infer<typeof UsageMetricsSchema>

export const ArtifactSchema = z.object({
  id: z.string(),
  schemaVersion: z.number().int(),
  runId: z.string(),
  attemptId: z.string(),
  kind: z.enum(['diff', 'summary', 'log']),
  name: z.string(),
  mediaType: z.string(),
  sha256: z.string(),
  sizeBytes: z.number(),
  content: z.string(),
})
export type Artifact = z.infer<typeof ArtifactSchema>

export const TestStatus = z.enum(['passed', 'failed', 'skipped', 'error', 'timeout'])
export type TestStatus = z.infer<typeof TestStatus>

export const TestResultSchema = z.object({
  id: z.string(),
  schemaVersion: z.number().int(),
  runId: z.string(),
  attemptId: z.string(),
  command: z.string(),
  status: TestStatus,
  exitCode: z.number().nullable().optional(),
  durationMs: z.number(),
  /** Parsed from output on a best-effort basis; absent when the format is not recognised. */
  passed: z.number().optional(),
  failed: z.number().optional(),
  note: z.string().optional(),
  outputTail: z.string().default(''),
})
export type TestResult = z.infer<typeof TestResultSchema>

export const EvaluationSchema = z.object({
  id: z.string(),
  schemaVersion: z.number().int(),
  runId: z.string(),
  attemptId: z.string(),
  evaluator: z.enum(['tests', 'readonly-check']),
  outcome: z.enum(['pass', 'fail', 'unknown']),
  detail: z.string().optional(),
  createdAt: z.string(),
})
export type Evaluation = z.infer<typeof EvaluationSchema>

export const HumanReviewSchema = z.object({
  id: z.string(),
  schemaVersion: z.number().int(),
  runId: z.string(),
  preferredAttemptId: z.string().optional(),
  accepted: z.boolean(),
  reason: z.string().optional(),
  notes: z.string().optional(),
  createdAt: z.string(),
})
export type HumanReview = z.infer<typeof HumanReviewSchema>

export const ApplicationSchema = z.object({
  id: z.string(),
  schemaVersion: z.number().int(),
  runId: z.string(),
  attemptId: z.string(),
  /** Ref holding a snapshot of the working tree taken immediately before applying. */
  backupRef: z.string(),
  resultRef: z.string(),
  files: z.array(z.string()),
  createdAt: z.string(),
})
export type Application = z.infer<typeof ApplicationSchema>

/** A developer's prediction of which attempt they will prefer, placed before reviewing. */
export const BetSchema = z.object({
  id: z.string(),
  schemaVersion: z.number().int(),
  projectId: z.string(),
  runId: z.string(),
  /** Attempt label (A, B...) the developer picked. */
  pick: z.string(),
  createdAt: z.string(),
})
export type Bet = z.infer<typeof BetSchema>

export const recordSchemas = {
  run: SidebetRunSchema,
  attempt: SidebetAttemptSchema,
  snapshot: ContextSnapshotSchema,
  policy: PolicyRecordSchema,
  toolEvent: ToolEventSchema,
  usage: UsageMetricsSchema,
  artifact: ArtifactSchema,
  testResult: TestResultSchema,
  evaluation: EvaluationSchema,
  review: HumanReviewSchema,
  application: ApplicationSchema,
  bet: BetSchema,
} as const

export interface RecordMap {
  run: SidebetRun
  attempt: SidebetAttempt
  snapshot: ContextSnapshot
  policy: PolicyRecord
  toolEvent: ToolEvent
  usage: UsageMetrics
  artifact: Artifact
  testResult: TestResult
  evaluation: Evaluation
  review: HumanReview
  application: Application
  bet: Bet
}
export type RecordKind = keyof RecordMap
