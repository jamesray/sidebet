import { mkdir } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import {
  type AgentRuntime,
  applyAttempt,
  assembleContext,
  ConfigSchema,
  computeOdds,
  currentBranch,
  describeEnforcement,
  diffPatch,
  discoverProject,
  type ExecutionPlan,
  evaluateModel,
  evaluateModels,
  evaluateToolCall,
  findAttempt,
  globalConfigPath,
  headCommit,
  loadRunDetail,
  lookupModel,
  type MemoryEntry,
  modelRef,
  newId,
  nowIso,
  type ProjectContext,
  planExecution,
  planRerun,
  previewApply,
  projectConfigPath,
  type RuntimeInfo,
  readJsonFile,
  recordReview,
  resolveProject,
  resolveRun,
  SCHEMA_VERSION,
  SidebetError,
  type Storage,
  statusLines,
  suggestMemories,
  TaskCategory,
  worktreeAdd,
  worktreePathFor,
  writeProjectConfig,
} from '@sidebet/core'
import { cleanWorktrees } from '../commands/clean.js'
import { collectChecks } from '../commands/doctor.js'
import { initialConfig } from '../commands/init.js'
import { CHIP_NAMES } from '../style/chip.js'
import type { JobRunner } from './jobs.js'

export interface ApiContext {
  project: ProjectContext
  storage: Storage
  env: NodeJS.ProcessEnv
  readonly: boolean
  version: string
  /** Memoized by the server for Pi; tests swap runtimes, so detection is cached per instance below. */
  loadRuntime: () => Promise<AgentRuntime>
  jobs: JobRunner
}

export interface ApiRequest {
  method: string
  url: URL
  body: unknown
}

export interface ApiResponse {
  status: number
  body: unknown
}

type Params = Record<string, string>
type Handler = (api: ApiContext, req: ApiRequest, params: Params) => Promise<ApiResponse>

const ok = (body: unknown, status = 200): ApiResponse => ({ status, body })

// ---------- body helpers (bodies come from our own page, but every field is still checked) ----------

const obj = (v: unknown): Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {}

const str = (v: unknown, name: string): string | undefined => {
  if (v === undefined || v === null || v === '') return undefined
  if (typeof v !== 'string') throw new SidebetError(`${name} must be a string.`)
  return v
}

const bool = (v: unknown, name: string): boolean | undefined => {
  if (v === undefined || v === null) return undefined
  if (typeof v !== 'boolean') throw new SidebetError(`${name} must be true or false.`)
  return v
}

const num = (v: unknown, name: string): number | undefined => {
  if (v === undefined || v === null || v === '') return undefined
  const n = typeof v === 'number' ? v : Number(v)
  if (!Number.isFinite(n) || n <= 0) throw new SidebetError(`${name} must be a positive number.`)
  return n
}

const strList = (v: unknown, name: string): string[] | undefined => {
  if (v === undefined || v === null || v === '') return undefined
  const list = Array.isArray(v) ? v : typeof v === 'string' ? v.split(',') : undefined
  if (!list || list.some((x) => typeof x !== 'string'))
    throw new SidebetError(`${name} must be a list of strings.`)
  const out = (list as string[]).map((s) => s.trim()).filter(Boolean)
  return out.length ? out : undefined
}

// ---------- runtime (detection is cached briefly per instance: Pi reads its own config and credentials) ----------

const RUNTIME_TTL_MS = 60_000
const detected = new WeakMap<AgentRuntime, { at: number; info: Promise<RuntimeInfo> }>()

const getRuntime = async (
  api: ApiContext,
  refresh = false,
): Promise<{ runtime: AgentRuntime; info: RuntimeInfo }> => {
  let runtime: AgentRuntime
  try {
    runtime = await api.loadRuntime()
  } catch (err) {
    throw new SidebetError(
      `The agent runtime failed to load: ${err instanceof Error ? err.message : String(err)}`,
      'Run `sidebet doctor`.',
    )
  }
  const hit = detected.get(runtime)
  if (!refresh && hit && Date.now() - hit.at < RUNTIME_TTL_MS)
    return { runtime, info: await hit.info }
  const info = runtime.detect()
  detected.set(runtime, { at: Date.now(), info })
  info.catch(() => detected.delete(runtime))
  return { runtime, info: await info }
}

// ---------- shared views ----------

/** Run list without diff/log contents, which can be megabytes per attempt. */
const summarize = (storage: Storage, runId: string) => {
  const d = loadRunDetail(storage, runId)
  return {
    ...d,
    attempts: d.attempts.map((a) => ({
      ...a,
      diff: a.diff ? { ...a.diff, content: undefined } : undefined,
      logs: a.logs.map((l) => ({ ...l, content: undefined })),
      toolEvents: a.toolEvents.length,
    })),
  }
}

/** A plan for display: the exact prompt stays, per-item content (already in the prompt) is dropped. */
const planView = (plan: ExecutionPlan) => ({
  ...plan,
  contextPrompt: undefined,
  snapshot: {
    ...plan.snapshot,
    items: plan.snapshot.items.map(({ content: _c, ...rest }) => rest),
  },
})

const settingsView = async (api: ApiContext) => {
  const path = projectConfigPath(api.project.root)
  const globalPath = globalConfigPath(api.env)
  return {
    path,
    globalPath,
    initialized: api.project.initialized,
    raw: (await readJsonFile(path)) ?? null,
    global: (await readJsonFile(globalPath)) ?? null,
    effective: api.project.config,
    sources: api.project.sources,
    chips: CHIP_NAMES,
    projectId: api.project.projectId,
    name: api.project.name,
    root: api.project.root,
  }
}

const reload = async (api: ApiContext): Promise<void> => {
  api.project = await resolveProject(api.project.root, api.env)
}

interface PlanBody {
  kind: 'run' | 'compare'
  task: string
  models?: string[]
  readonly?: boolean
  runTests?: boolean
  timeoutSec?: number
  concurrency?: number
  taskFiles?: string[]
  keepWorktrees?: boolean
}

const parsePlanBody = (raw: unknown): PlanBody => {
  const b = obj(raw)
  const task = str(b.task, 'task')?.trim()
  if (!task) throw new SidebetError('A task is required.', 'Describe what the agent should do.')
  const models = strList(b.models, 'models')
  const rawKind = str(b.kind, 'kind') ?? 'compare'
  if (rawKind !== 'run' && rawKind !== 'compare')
    throw new SidebetError('kind must be "run" or "compare".')
  // Same rule as the CLI: naming two or more models for a run means dual output, i.e. a compare.
  const kind: PlanBody['kind'] =
    rawKind === 'run' && models && models.length > 1 ? 'compare' : rawKind
  return {
    kind,
    task,
    models,
    readonly: bool(b.readonly, 'readonly'),
    runTests: bool(b.runTests, 'runTests'),
    timeoutSec: num(b.timeoutSec, 'timeoutSec'),
    concurrency: num(b.concurrency, 'concurrency'),
    taskFiles: strList(b.taskFiles, 'taskFiles'),
    keepWorktrees: bool(b.keepWorktrees, 'keepWorktrees'),
  }
}

const buildPlan = async (api: ApiContext, b: PlanBody) => {
  const { runtime, info } = await getRuntime(api)
  const plan = await planExecution({
    project: api.project,
    runtimeInfo: info,
    storage: api.storage,
    kind: b.kind,
    task: b.task,
    models: b.models,
    readonly: b.readonly,
    taskFiles: b.taskFiles,
    runTests: b.runTests,
    timeoutSec: b.timeoutSec,
    concurrency: b.concurrency,
    env: api.env,
  })
  return { plan, info, runtime }
}

const projectFor = (api: ApiContext, keepWorktrees?: boolean): ProjectContext =>
  keepWorktrees
    ? {
        ...api.project,
        config: {
          ...api.project.config,
          compare: { ...api.project.config.compare, keepWorktrees: true },
        },
      }
    : api.project

const requireIdle = (api: ApiContext): void => {
  const active = api.jobs.active
  if (active)
    throw new SidebetError(
      `Job ${active.id} is still running.`,
      'Wait for it to finish, or cancel it first. One job runs at a time in this repository.',
    )
}

// ---------- handlers ----------

const project: Handler = async (api) => {
  const { project } = api
  const [branch, head, dirty] = await Promise.all([
    currentBranch(project.root).catch(() => undefined),
    headCommit(project.root).catch(() => undefined),
    statusLines(project.root).catch(() => []),
  ])
  return ok({
    id: project.projectId,
    name: project.name,
    root: project.root,
    version: api.version,
    initialized: project.initialized,
    readonly: api.readonly,
    sources: project.sources,
    branch,
    head: head?.slice(0, 10),
    dirty: dirty.length,
    chip: project.config.ui.chip,
    activeJob: api.jobs.active?.id ?? null,
  })
}

const runs: Handler = async (api, req) => {
  const limit = Math.min(500, Number(req.url.searchParams.get('limit') ?? 100))
  const status = req.url.searchParams.get('status')
  let list = api.storage.records.list('run', { projectId: api.project.projectId, order: 'desc' })
  if (status) list = list.filter((r) => r.status === status)
  return ok(list.slice(0, limit).map((r) => summarize(api.storage, r.id)))
}

const run: Handler = async (api, _req, p) => {
  const id = resolveRun(api.storage, decodeURIComponent(p.id ?? ''))
  const detail = loadRunDetail(api.storage, id)
  const snapshot = api.storage.records.get('snapshot', detail.run.contextSnapshotId)
  const policy = api.storage.records.get('policy', detail.run.policyVersion)
  const job = api.jobs.list().find((j) => j.runId === id)
  return ok({ ...detail, snapshot, policy, jobId: job?.id })
}

const runCompare: Handler = async (api, _req, p) => {
  const detail = loadRunDetail(api.storage, resolveRun(api.storage, p.id ?? ''))
  const [a, b] = detail.attempts
  if (!a || !b) throw new SidebetError('Need two attempts to compare.')
  if (!a.attempt.resultCommit || !b.attempt.resultCommit)
    throw new SidebetError('Cannot compare: one attempt has no stored result commit.')
  const patch = await diffPatch(api.project.root, a.attempt.resultCommit, b.attempt.resultCommit)
  return ok({ from: a.attempt.label, to: b.attempt.label, patch })
}

const bet: Handler = async (api, req, p) => {
  const b = obj(req.body)
  const pick = str(b.pick, 'pick')?.toUpperCase()
  if (!pick) throw new SidebetError('bet needs an attempt label.', 'Example: { "pick": "A" }')
  const runId = resolveRun(api.storage, p.id ?? '')
  const detail = loadRunDetail(api.storage, runId)
  if (detail.run.kind !== 'compare') throw new SidebetError('Bets are placed on compare runs only.')
  if (detail.reviews.some((r) => r.preferredAttemptId))
    throw new SidebetError(
      `${runId} already has a recorded preference; a bet must come before the review.`,
    )
  const attempt = findAttempt(detail, pick)
  const record = {
    id: newId('bet'),
    schemaVersion: SCHEMA_VERSION,
    projectId: api.project.projectId,
    runId,
    pick: attempt.attempt.label,
    createdAt: nowIso(),
  }
  api.storage.records.put('bet', record)
  return ok(record, 201)
}

const review: Handler = async (api, req, p) => {
  const b = obj(req.body)
  const runId = resolveRun(api.storage, p.id ?? '')
  const detail = loadRunDetail(api.storage, runId)
  const accepted = bool(b.accepted, 'accepted')
  if (accepted === undefined) throw new SidebetError('accepted (true or false) is required.')
  const record = recordReview(api.storage, detail, {
    runId,
    preferred: str(b.preferred, 'preferred'),
    accepted,
    reason: str(b.reason, 'reason'),
    notes: str(b.notes, 'notes'),
  })
  return ok(record, 201)
}

const applyPreview: Handler = async (api, req, p) => {
  const detail = loadRunDetail(api.storage, resolveRun(api.storage, p.id ?? ''))
  const preview = await previewApply(api.project, detail, p.label ?? '', {
    allowIncomplete: req.url.searchParams.get('allowIncomplete') === '1',
  })
  const { patch, ...rest } = preview
  return ok({ ...rest, patchBytes: patch.length })
}

const apply: Handler = async (api, req, p) => {
  const b = obj(req.body)
  const label = str(b.label, 'label')
  if (!label) throw new SidebetError('label is required.', 'Which attempt to apply, e.g. "A".')
  const detail = loadRunDetail(api.storage, resolveRun(api.storage, p.id ?? ''))
  const preview = await previewApply(api.project, detail, label, {
    allowIncomplete: bool(b.allowIncomplete, 'allowIncomplete'),
  })
  if (!preview.applies) {
    return {
      status: 409,
      body: {
        error: `Attempt ${preview.label} does not apply cleanly to your working tree.`,
        hint: 'Nothing was changed. Commit or stash conflicting edits and retry.',
        conflict: preview.conflict,
      },
    }
  }
  const application = await applyAttempt(api.project, api.storage, preview)
  return ok({ application, locallyModified: preview.locallyModified }, 201)
}

const checkout: Handler = async (api, req, p) => {
  const b = obj(req.body)
  const label = str(b.label, 'label')
  if (!label) throw new SidebetError('label is required.')
  const detail = loadRunDetail(api.storage, resolveRun(api.storage, p.id ?? ''))
  const a = findAttempt(detail, label)
  if (!a.attempt.resultCommit)
    throw new SidebetError('This attempt has no stored result commit to check out.')
  const path = worktreePathFor(api.project, detail.run.id, `${a.attempt.label}-review`)
  await mkdir(dirname(path), { recursive: true })
  await worktreeAdd(api.project.root, path, a.attempt.resultCommit)
  return ok({ path, label: a.attempt.label }, 201)
}

const rerun: Handler = async (api, req, p) => {
  const b = obj(req.body)
  const context = str(b.context, 'context') ?? 'original'
  if (context !== 'original' && context !== 'current')
    throw new SidebetError('context must be "original" or "current".')
  const dryRun = bool(b.dryRun, 'dryRun')
  if (!dryRun) requireIdle(api)
  const original = loadRunDetail(api.storage, resolveRun(api.storage, p.id ?? ''))
  const { runtime, info } = await getRuntime(api)
  const rp = await planRerun(api.storage, api.project, info, original, {
    context,
    models: strList(b.models, 'models'),
    readonly: bool(b.readonly, 'readonly'),
  })
  if (dryRun) return ok({ plan: planView(rp.plan), notes: rp.notes, parentRunId: rp.parentRunId })
  const job = api.jobs.start(
    { storage: api.storage, runtime, runtimeInfo: info, project: api.project },
    rp.plan,
    { parentRunId: rp.parentRunId },
  )
  return ok({ job, notes: rp.notes }, 202)
}

const memorySuggestions: Handler = async (api, _req, p) => {
  const detail = loadRunDetail(api.storage, resolveRun(api.storage, p.id ?? ''))
  const summaries = detail.attempts.map((a) => a.attempt.summary ?? '').filter(Boolean)
  return ok({
    runId: detail.run.id,
    candidates: suggestMemories(summaries.join('\n'), api.storage.memory, api.project.projectId),
  })
}

const plan: Handler = async (api, req) => {
  const b = parsePlanBody(req.body)
  const { plan, info } = await buildPlan(api, b)
  return ok({
    plan: planView(plan),
    runtime: { id: info.id, version: info.version, defaultModel: info.defaultModel },
  })
}

const startJob: Handler = async (api, req) => {
  const b = parsePlanBody(req.body)
  requireIdle(api)
  const { plan, info, runtime } = await buildPlan(api, b)
  const job = api.jobs.start(
    { storage: api.storage, runtime, runtimeInfo: info, project: projectFor(api, b.keepWorktrees) },
    plan,
  )
  return ok({ job }, 202)
}

const jobs: Handler = async (api) => ok(api.jobs.list())

const job: Handler = async (api, _req, p) => {
  const state = api.jobs.get(p.id ?? '')
  if (!state) throw new SidebetError(`Job ${p.id} not found.`)
  return ok(state)
}

const cancelJob: Handler = async (api, _req, p) => ok(api.jobs.cancel(p.id ?? ''))

const decideApproval: Handler = async (api, req, p) => {
  const allow = bool(obj(req.body).allow, 'allow')
  if (allow === undefined) throw new SidebetError('allow (true or false) is required.')
  return ok(api.jobs.decide(p.id ?? '', p.aid ?? '', allow))
}

const odds: Handler = async (api, req) => {
  const raw = req.url.searchParams.get('category')
  const cat = raw ? TaskCategory.safeParse(raw) : undefined
  if (cat && !cat.success)
    throw new SidebetError(
      `Unknown category "${raw}".`,
      `Choose one of: ${TaskCategory.options.join(', ')}`,
    )
  return ok(computeOdds(api.storage, api.project.projectId, { category: cat?.data }))
}

const memoryList: Handler = async (api, req) => {
  const q = req.url.searchParams.get('q')?.trim()
  const scope = req.url.searchParams.get('scope')
  const pid = api.project.projectId
  if (q) {
    let hits: Array<MemoryEntry & { rank?: number }>
    try {
      hits = api.storage.memory
        .search(q, { projectId: pid, limit: Number(req.url.searchParams.get('limit') ?? 50) })
        .map((h) => ({ ...h.entry, rank: h.rank }))
    } catch {
      const needle = q.toLowerCase()
      hits = api.storage.memory
        .list({ projectId: pid })
        .filter(
          (m) =>
            m.text.toLowerCase().includes(needle) ||
            m.tags.join(' ').toLowerCase().includes(needle),
        )
    }
    return ok(hits)
  }
  return ok(
    api.storage.memory.list({
      projectId: pid,
      scope: scope === 'global' || scope === 'project' ? scope : undefined,
    }),
  )
}

const memoryAdd: Handler = async (api, req) => {
  const b = obj(req.body)
  const text = str(b.text, 'text')?.trim()
  if (!text) throw new SidebetError('memory text is required.')
  const global = bool(b.global, 'global') ?? false
  const source = str(b.source, 'source') ?? 'human'
  if (source !== 'human' && source !== 'suggestion')
    throw new SidebetError('source must be "human" or "suggestion".')
  const entry: MemoryEntry = {
    id: newId('mem'),
    schemaVersion: SCHEMA_VERSION,
    scope: global ? 'global' : 'project',
    projectId: global ? undefined : api.project.projectId,
    text,
    tags: strList(b.tags, 'tags') ?? [],
    source,
    createdAt: nowIso(),
  }
  api.storage.memory.add(entry)
  return ok(entry, 201)
}

const memoryRemove: Handler = async (api, _req, p) => {
  const id = api.storage.memory.resolveId(p.id ?? '')
  if (!id) throw new SidebetError(`No memory "${p.id}" not found.`)
  api.storage.memory.remove(id)
  return ok({ removed: id })
}

const models: Handler = async (api, req) => {
  const aliases = api.project.config.models.aliases
  const byRef = new Map(Object.entries(aliases).map(([a, r]) => [r, a]))
  let info: RuntimeInfo
  try {
    info = (await getRuntime(api, req.url.searchParams.get('refresh') === '1')).info
  } catch (err) {
    return ok({
      runtime: {
        id: api.project.config.runtime,
        available: false,
        problems: [err instanceof Error ? err.message : String(err)],
        notes: [],
      },
      models: [],
      aliases,
      compare: api.project.config.models.compare ?? [],
      default: api.project.config.models.default,
    })
  }
  return ok({
    runtime: {
      id: info.id,
      version: info.version,
      available: info.available,
      defaultModel: info.defaultModel,
      configDir: info.configDir,
      problems: info.problems,
      notes: info.notes,
    },
    models: info.models.map((m) => {
      const d = evaluateModel(api.project.policy, m)
      return {
        ref: modelRef(m),
        provider: m.provider,
        id: m.id,
        name: m.name,
        contextWindow: m.contextWindow,
        alias: byRef.get(modelRef(m)),
        eligible: d.allowed,
        reason: d.allowed ? undefined : d.reason,
        isDefault: info.defaultModel === modelRef(m),
      }
    }),
    aliases,
    compare: api.project.config.models.compare ?? [],
    default: api.project.config.models.default,
  })
}

const context: Handler = async (api, req) => {
  const info = await getRuntime(api)
    .then((r) => r.info)
    .catch(() => undefined)
  const files = req.url.searchParams.getAll('file').filter(Boolean)
  const snapshot = await assembleContext({
    project: api.project,
    task: req.url.searchParams.get('task') ?? '',
    memory: api.storage.memory,
    runtime: info ?? { skillDirs: [], globalContextFiles: [] },
    taskFiles: files.length ? files : undefined,
    env: api.env,
  })
  return ok(snapshot)
}

const policy: Handler = async (api, req) => {
  const { project } = api
  const q = req.url.searchParams
  const info = await getRuntime(api)
    .then((r) => r.info)
    .catch(() => undefined)
  const available = info?.models ?? []
  const checks: Array<{
    subject: string
    allowed: boolean
    needsApproval?: boolean
    reason: string
  }> = []
  const model = q.get('model')
  if (model) {
    const found = lookupModel(model, available, project.config.models.aliases)
    const m =
      'model' in found
        ? found.model
        : { provider: model.split('/')[0] ?? '', id: model.split('/').slice(1).join('/') || model }
    const d = evaluateModel(project.policy, m)
    checks.push({
      subject: modelRef(m),
      allowed: d.allowed,
      reason: 'error' in found ? `${d.reason} (${found.error})` : d.reason,
    })
  }
  const tool = q.get('tool')
  const path = q.get('path')
  const command = q.get('command')
  if (tool || path || command) {
    const t = tool ?? (command ? 'bash' : 'read')
    const input: Record<string, unknown> = command ? { command } : { path }
    const rel = (p: string): string =>
      relative(project.root, isAbsolute(p) ? p : resolve(project.root, p))
    const d = evaluateToolCall(project.policy, q.get('readonly') === '1', { tool: t, input }, rel)
    checks.push({
      subject: `${t} ${command ?? path ?? ''}`.trim(),
      allowed: d.allowed,
      needsApproval: d.needsApproval,
      reason: d.reason,
    })
  }
  return ok({
    policyVersion: project.policyVersion,
    sources: project.sources,
    policy: project.policy,
    warnings: project.policyWarnings,
    models: evaluateModels(project.policy, available).map((v) => ({
      model: modelRef(v.model),
      ...v.decision,
    })),
    runtimeAvailable: Boolean(info?.available),
    enforcement: describeEnforcement(project.policy),
    checks,
  })
}

const doctor: Handler = async (api) =>
  ok({ checks: await collectChecks({ cwd: api.project.root, env: api.env }) })

const settings: Handler = async (api) => ok(await settingsView(api))

/** Drop empty strings, nulls, undefined and empty objects so a form round-trips to a sparse config file. */
const prune = (v: unknown): unknown => {
  if (Array.isArray(v)) return v.map(prune).filter((x) => x !== undefined)
  if (typeof v === 'object' && v !== null) {
    const out: Record<string, unknown> = {}
    for (const [k, val] of Object.entries(v)) {
      const p = prune(val)
      if (p === undefined) continue
      if (typeof p === 'object' && p !== null && !Array.isArray(p) && Object.keys(p).length === 0)
        continue
      out[k] = p
    }
    return out
  }
  if (v === undefined || v === null || v === '') return undefined
  return v
}

const saveSettings: Handler = async (api, req) => {
  if (!api.project.initialized)
    throw new SidebetError(
      'This project has no .sidebet/config.json yet.',
      'Initialize it first (the Settings page offers this).',
    )
  const path = projectConfigPath(api.project.root)
  const existing = obj(await readJsonFile(path))
  const incoming = obj(obj(req.body).config)
  const next = obj(
    prune({ ...incoming, version: 1, projectId: existing.projectId ?? incoming.projectId }),
  )
  const parsed = ConfigSchema.safeParse(next)
  if (!parsed.success) {
    return {
      status: 400,
      body: {
        error: 'Invalid configuration.',
        issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      },
    }
  }
  await writeProjectConfig(api.project.root, next)
  await reload(api)
  return ok(await settingsView(api))
}

const init: Handler = async (api) => {
  if (api.project.initialized)
    return { status: 409, body: { error: 'This project is already initialized.' } }
  const info = await getRuntime(api)
    .then((r) => r.info)
    .catch(() => undefined)
  const found = await discoverProject(api.project.root, info)
  await writeProjectConfig(api.project.root, initialConfig(found))
  await reload(api)
  return ok({ ...(await settingsView(api)), discovered: found }, 201)
}

const clean: Handler = async (api) => ok({ removed: await cleanWorktrees(api.project, api.env) })

// ---------- router ----------

interface Route {
  method: string
  pattern: RegExp
  keys: string[]
  handler: Handler
}

const route = (method: string, path: string, handler: Handler): Route => {
  const keys: string[] = []
  const pattern = new RegExp(
    `^${path.replace(/:([a-zA-Z]+)/g, (_m, k: string) => {
      keys.push(k)
      return '([^/]+)'
    })}$`,
  )
  return { method, pattern, keys, handler }
}

const ROUTES: Route[] = [
  route('GET', '/api/project', project),
  route('GET', '/api/runs', runs),
  route('GET', '/api/runs/:id', run),
  route('GET', '/api/runs/:id/compare', runCompare),
  route('GET', '/api/runs/:id/apply/:label', applyPreview),
  route('GET', '/api/runs/:id/memory-suggestions', memorySuggestions),
  route('POST', '/api/runs/:id/bet', bet),
  route('POST', '/api/runs/:id/review', review),
  route('POST', '/api/runs/:id/apply', apply),
  route('POST', '/api/runs/:id/checkout', checkout),
  route('POST', '/api/runs/:id/rerun', rerun),
  route('POST', '/api/plan', plan),
  route('GET', '/api/jobs', jobs),
  route('POST', '/api/jobs', startJob),
  route('GET', '/api/jobs/:id', job),
  route('POST', '/api/jobs/:id/cancel', cancelJob),
  route('POST', '/api/jobs/:id/approvals/:aid', decideApproval),
  route('GET', '/api/odds', odds),
  route('GET', '/api/memory', memoryList),
  route('POST', '/api/memory', memoryAdd),
  route('DELETE', '/api/memory/:id', memoryRemove),
  route('GET', '/api/models', models),
  route('GET', '/api/context', context),
  route('GET', '/api/policy', policy),
  route('GET', '/api/doctor', doctor),
  route('GET', '/api/settings', settings),
  route('PUT', '/api/settings', saveSettings),
  route('POST', '/api/init', init),
  route('POST', '/api/clean', clean),
]

/** Every `/api/*` request. Reads need no token; the HTTP layer gates mutations before calling this. */
export const handleApi = async (api: ApiContext, req: ApiRequest): Promise<ApiResponse> => {
  const method = req.method === 'HEAD' ? 'GET' : req.method
  const path = req.url.pathname
  let matchedPath = false
  for (const r of ROUTES) {
    const m = r.pattern.exec(path)
    if (!m) continue
    matchedPath = true
    if (r.method !== method) continue
    const params: Params = {}
    r.keys.forEach((k, i) => {
      params[k] = decodeURIComponent(m[i + 1] ?? '')
    })
    try {
      return await r.handler(api, req, params)
    } catch (err) {
      if (err instanceof SidebetError) {
        return {
          status: /not found/i.test(err.message) ? 404 : 400,
          body: { error: err.message, hint: err.hint },
        }
      }
      return { status: 500, body: { error: err instanceof Error ? err.message : String(err) } }
    }
  }
  return matchedPath
    ? { status: 405, body: { error: `${req.method} is not supported for ${path}.` } }
    : { status: 404, body: { error: 'not found' } }
}
