import { existsSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import type { ProjectContext } from '../config/load.js'
import { globalRulesDir, projectRulesDir } from '../config/paths.js'
import { type ContextItem, type ContextSnapshot, SCHEMA_VERSION } from '../domain/schemas.js'
import { isProtectedPath } from '../policy/evaluate.js'
import type { RuntimeInfo } from '../runtime.js'
import type { MemoryStore } from '../storage.js'
import { hashOf, sha256 } from '../util/hash.js'
import { newId, nowIso } from '../util/ids.js'
import { redactSecrets } from '../util/redact.js'
import { estimateTokens, truncateToTokens } from '../util/tokens.js'
import { discoverSkills } from './skills.js'

export interface AssembleInput {
  project: ProjectContext
  task: string
  memory: MemoryStore
  runtime: Pick<RuntimeInfo, 'skillDirs' | 'globalContextFiles'>
  /** Extra files to include for this task only (--context). */
  taskFiles?: string[]
  env?: NodeJS.ProcessEnv
}

const PRIORITY = {
  agents: 100,
  projectRule: 90,
  globalAgents: 80,
  globalRule: 70,
  taskFile: 60,
  doc: 50,
  skill: 40,
  memory: 30,
}

const STOPWORDS = new Set(
  'the and for with that this from into your you are not but can will all any has have was were then than too out use using make add fix new how what why when where which should would could about'.split(
    ' ',
  ),
)

export const taskKeywords = (task: string): string[] => [
  ...new Set(
    (task.toLowerCase().match(/[a-z0-9_]+/g) ?? []).filter(
      (w) => w.length >= 3 && !STOPWORDS.has(w),
    ),
  ),
]

interface Candidate {
  item: Omit<
    ContextItem,
    'delivery' | 'tokens' | 'contentHash' | 'content' | 'redactions' | 'reason'
  >
  body: string
  /** Delivery if everything is fine. */
  preferred: 'injected' | 'native'
  reason: string
}

const listMarkdown = async (dir: string): Promise<string[]> =>
  existsSync(dir) ? (await readdir(dir)).filter((f) => f.endsWith('.md')).sort() : []

const readIfExists = async (path: string): Promise<string | undefined> =>
  existsSync(path) ? readFile(path, 'utf8') : undefined

export const assembleContext = async (input: AssembleInput): Promise<ContextSnapshot> => {
  const { project, task, memory } = input
  const env = input.env ?? process.env
  const cfg = project.config.context
  const policy = project.policy
  const candidates: Candidate[] = []
  const omitted: ContextItem[] = []

  const omit = (base: Candidate['item'], body: string, reason: string): void => {
    omitted.push({
      ...base,
      delivery: 'omitted',
      tokens: estimateTokens(body),
      contentHash: sha256(body),
      reason,
      redactions: 0,
    })
  }

  const rel = (p: string): string => (p.startsWith(project.root) ? relative(project.root, p) : p)

  // Native context files (AGENTS.md): Pi loads these itself, so Sidebet does not repeat them
  // unless policy forces it to take over delivery.
  let nativeContextFiles = true
  const nativeFiles: Array<{ path: string; scope: 'global' | 'project'; priority: number }> = []
  const projectAgents = join(project.root, 'AGENTS.md')
  if (existsSync(projectAgents))
    nativeFiles.push({ path: projectAgents, scope: 'project', priority: PRIORITY.agents })
  for (const f of input.runtime.globalContextFiles) {
    if (existsSync(f))
      nativeFiles.push({ path: f, scope: 'global', priority: PRIORITY.globalAgents })
  }
  const nativeBodies = new Map<string, string>()
  for (const f of nativeFiles) {
    const body = await readFile(f.path, 'utf8')
    nativeBodies.set(f.path, body)
    const r = rel(f.path)
    if (f.scope === 'project' && isProtectedPath(policy, r)) nativeContextFiles = false
    if (redactSecrets(body).count > 0) nativeContextFiles = false
  }
  for (const f of nativeFiles) {
    const body = nativeBodies.get(f.path) ?? ''
    const r = rel(f.path)
    const base = {
      id: newId('ctx'),
      kind: 'agents' as const,
      source: r,
      scope: f.scope,
      priority: f.priority,
    }
    if (f.scope === 'project' && isProtectedPath(policy, r)) {
      omit(base, body, 'blocked: matches a protected path in policy')
      continue
    }
    candidates.push({
      item: base,
      body,
      preferred: nativeContextFiles ? 'native' : 'injected',
      reason: nativeContextFiles
        ? 'loaded by the runtime itself (not repeated in the prompt)'
        : 'injected by Sidebet because policy or secret scanning prevents native loading',
    })
  }

  // Sidebet rules: global then project.
  const ruleSources: Array<[string, 'global' | 'project', number]> = [
    [globalRulesDir(env), 'global', PRIORITY.globalRule],
    [projectRulesDir(project.root), 'project', PRIORITY.projectRule],
  ]
  for (const [dir, scope, priority] of ruleSources) {
    for (const f of await listMarkdown(dir)) {
      const path = join(dir, f)
      const r = rel(path)
      const body = (await readIfExists(path)) ?? ''
      const base = { id: newId('ctx'), kind: 'rule' as const, source: r, scope, priority }
      if (scope === 'project' && isProtectedPath(policy, r)) {
        omit(base, body, 'blocked: matches a protected path in policy')
        continue
      }
      candidates.push({
        item: base,
        body,
        preferred: 'injected',
        reason: `${scope} rule file`,
      })
    }
  }

  // Repository documentation named in config.
  for (const doc of cfg.docs) {
    const path = join(project.root, doc)
    const body = await readIfExists(path)
    if (body === undefined) continue
    const base = {
      id: newId('ctx'),
      kind: 'doc' as const,
      source: doc,
      scope: 'project' as const,
      priority: PRIORITY.doc,
    }
    if (isProtectedPath(policy, doc)) {
      omit(base, body, 'blocked: matches a protected path in policy')
      continue
    }
    candidates.push({ item: base, body, preferred: 'injected', reason: 'listed in context.docs' })
  }

  // Task-specific files.
  for (const f of input.taskFiles ?? []) {
    const path = join(project.root, f)
    const r = rel(path)
    const body = await readIfExists(path)
    const base = {
      id: newId('ctx'),
      kind: 'task' as const,
      source: r,
      scope: 'task' as const,
      priority: PRIORITY.taskFile,
    }
    if (body === undefined) {
      omit(base, '', 'file not found')
      continue
    }
    if (isProtectedPath(policy, r)) {
      omit(base, body, 'blocked: matches a protected path in policy')
      continue
    }
    candidates.push({ item: base, body, preferred: 'injected', reason: 'passed with --context' })
  }

  // Memory. Relevance = FTS match on the task, or everything when the set is small.
  const inScope = memory.list({ projectId: project.projectId })
  const hitIds = new Map<string, string>()
  if (inScope.length <= cfg.memoryIncludeAllBelow) {
    for (const e of inScope) hitIds.set(e.id, 'included: small memory set')
  } else {
    const q = taskKeywords(task).join(' ')
    if (q) {
      for (const h of memory.search(q, { projectId: project.projectId, limit: cfg.memoryLimit })) {
        hitIds.set(h.entry.id, 'matched task keywords')
      }
    }
    for (const e of inScope)
      if (e.tags.includes('always') && !hitIds.has(e.id)) hitIds.set(e.id, 'tagged "always"')
  }
  const memoryLines: Candidate[] = []
  for (const e of inScope) {
    const reason = hitIds.get(e.id)
    const base = {
      id: newId('ctx'),
      kind: 'memory' as const,
      source: e.id,
      scope: e.scope,
      priority: PRIORITY.memory,
    }
    if (!reason) {
      omit(base, e.text, 'not relevant to this task')
      continue
    }
    memoryLines.push({ item: base, body: e.text, preferred: 'injected', reason })
  }
  candidates.push(...memoryLines)

  // Skills are loaded by the runtime. They are listed for transparency, not injected.
  const skills = await discoverSkills(project.root, input.runtime.skillDirs)
  for (const s of skills) {
    const body = `${s.name}: ${s.description}`
    candidates.push({
      item: {
        id: newId('ctx'),
        kind: 'skill',
        source: s.name,
        scope: s.scope,
        priority: PRIORITY.skill,
      },
      body,
      preferred: 'native',
      reason: `skill at ${rel(s.path)}, loaded on demand by the runtime`,
    })
  }

  // Deterministic order: priority desc, then kind, then source.
  candidates.sort(
    (a, b) =>
      b.item.priority - a.item.priority ||
      a.item.kind.localeCompare(b.item.kind) ||
      a.item.source.localeCompare(b.item.source),
  )

  const items: ContextItem[] = []
  let injectedTokens = 0
  let nativeTokens = 0
  for (const c of candidates) {
    const redacted = redactSecrets(c.body)
    const capped = truncateToTokens(redacted.text, cfg.perItemTokens)
    const tokens = estimateTokens(capped.text)
    const extra = [
      redacted.count > 0 ? `${redacted.count} secret(s) redacted` : '',
      capped.truncated ? 'truncated to per-item limit' : '',
    ].filter(Boolean)
    const reason = [c.reason, ...extra].join('; ')
    const common = {
      ...c.item,
      tokens,
      contentHash: sha256(c.body),
      redactions: redacted.count,
    }
    if (c.preferred === 'native') {
      nativeTokens += tokens
      items.push({ ...common, delivery: 'native', reason, content: capped.text })
      continue
    }
    if (injectedTokens + tokens > cfg.budgetTokens) {
      items.push({
        ...common,
        delivery: 'omitted',
        reason: `over budget: needs ${tokens} tokens, ${Math.max(0, cfg.budgetTokens - injectedTokens)} left of ${cfg.budgetTokens}`,
      })
      continue
    }
    injectedTokens += tokens
    const item: ContextItem = { ...common, delivery: 'injected', content: capped.text, reason }
    items.push(item)
  }
  items.push(...omitted)

  const rendered = renderItems(items.filter((i) => i.delivery === 'injected'))
  const snapshot: ContextSnapshot = {
    id: newId('ctx'),
    schemaVersion: SCHEMA_VERSION,
    projectId: project.projectId,
    task,
    createdAt: nowIso(),
    budgetTokens: cfg.budgetTokens,
    injectedTokens,
    nativeTokens,
    nativeContextFiles,
    items,
    rendered,
    hash: hashOf({
      items: items.map((i) => [i.kind, i.source, i.delivery, i.contentHash]),
      rendered,
    }),
  }
  return snapshot
}

const headingFor = (item: ContextItem): string => {
  switch (item.kind) {
    case 'agents':
      return `Project instructions: ${item.source}`
    case 'rule':
      return `Rule (${item.scope}): ${item.source}`
    case 'doc':
      return `Documentation: ${item.source}`
    case 'task':
      return `Task context: ${item.source}`
    default:
      return item.source
  }
}

/** Render items in the order given (already priority-sorted). Memory is grouped last and marked advisory. */
export const renderItems = (items: ContextItem[]): string => {
  const sections: string[] = []
  for (const item of items) {
    if (item.kind === 'memory' || item.kind === 'skill') continue
    sections.push(`## ${headingFor(item)}\n\n${item.content ?? ''}`.trimEnd())
  }
  const memories = items.filter((i) => i.kind === 'memory')
  if (memories.length > 0) {
    sections.push(
      `## Memory (advisory notes from the developer; rules above take precedence)\n\n${memories
        .map((m) => `- ${(m.content ?? '').replace(/\n+/g, ' ')}`)
        .join('\n')}`,
    )
  }
  if (sections.length === 0) return ''
  return [
    '# Sidebet context',
    'Sources are ordered from highest to lowest precedence. If they conflict, follow the earlier source.',
    '',
    ...sections,
  ].join('\n\n')
}

/**
 * Prompt for replaying a stored snapshot exactly: native AGENTS.md content is injected from the
 * snapshot (the runtime's own context-file loading must be switched off) so a changed file on disk
 * cannot silently alter the replay.
 */
export const renderForReplay = (snapshot: ContextSnapshot): string =>
  renderItems(
    snapshot.items.filter(
      (i) => i.delivery === 'injected' || (i.kind === 'agents' && i.delivery === 'native'),
    ),
  )

export interface ContextSummary {
  rules: string[]
  docs: string[]
  taskFiles: string[]
  native: string[]
  memoryIncluded: number
  memoryOmitted: number
  skills: string[]
  omitted: Array<{ source: string; reason: string }>
  estimatedTokens: number
}

export const summarizeContext = (s: ContextSnapshot): ContextSummary => {
  const inj = (kind: ContextItem['kind']): string[] =>
    s.items.filter((i) => i.kind === kind && i.delivery === 'injected').map((i) => i.source)
  return {
    rules: inj('rule'),
    docs: inj('doc'),
    taskFiles: inj('task'),
    native: s.items
      .filter((i) => i.kind === 'agents' && i.delivery !== 'omitted')
      .map((i) => i.source),
    memoryIncluded: inj('memory').length,
    memoryOmitted: s.items.filter((i) => i.kind === 'memory' && i.delivery === 'omitted').length,
    skills: s.items.filter((i) => i.kind === 'skill').map((i) => i.source),
    omitted: s.items
      .filter((i) => i.delivery === 'omitted' && i.kind !== 'memory')
      .map((i) => ({ source: i.source, reason: i.reason })),
    estimatedTokens: s.injectedTokens + s.nativeTokens,
  }
}
