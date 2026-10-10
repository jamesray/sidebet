import type { ProjectContext } from '../config/load.js'
import type { TaskCategory } from '../domain/schemas.js'
import { evaluateModel } from '../policy/evaluate.js'
import { type ModelInfo, modelRef, type RuntimeInfo } from '../runtime.js'
import { SidebetError } from '../util/exec.js'

export interface Rejection {
  ref: string
  reason: string
}

export interface Selection {
  models: ModelInfo[]
  rejected: Rejection[]
  /** How each choice was made, for --dry-run and `policy check`. */
  basis: string
}

export const categorizeTask = (task: string): TaskCategory => {
  const t = task.toLowerCase()
  if (/\b(explain|what|why|how does|describe|summari[sz]e|walk me through|where is)\b/.test(t))
    return 'question'
  if (/\b(fix|bug|broken|failing|crash|error|regression|issue)\b/.test(t)) return 'bugfix'
  if (/\b(refactor|restructure|clean ?up|simplify|rename|extract|migrate)\b/.test(t))
    return 'refactor'
  if (/\b(tests?|coverage|spec)\b/.test(t)) return 'test'
  if (/\b(docs?|documentation|readme|changelog|comment)\b/.test(t)) return 'docs'
  if (/\b(add|implement|create|build|support|introduce|new)\b/.test(t)) return 'feature'
  return 'other'
}

export type ModelLookup = { model: ModelInfo } | { error: string }

/** Accepts "provider/id", an exact id, or a unique substring. */
export const lookupModel = (
  rawSpec: string,
  models: ModelInfo[],
  aliases: Record<string, string> = {},
): ModelLookup => {
  const spec = aliases[rawSpec] ?? rawSpec
  const exact = models.find((m) => modelRef(m) === spec)
  if (exact) return { model: exact }
  const byId = models.filter((m) => m.id === spec)
  if (byId.length === 1 && byId[0]) return { model: byId[0] }
  if (byId.length > 1) {
    return {
      error: `"${spec}" is ambiguous: ${byId.map(modelRef).join(', ')}. Use provider/model.`,
    }
  }
  const partial = models.filter((m) => modelRef(m).toLowerCase().includes(spec.toLowerCase()))
  if (partial.length === 1 && partial[0]) return { model: partial[0] }
  if (partial.length > 1) {
    return {
      error: `"${spec}" matches several models: ${partial.slice(0, 6).map(modelRef).join(', ')}. Be more specific.`,
    }
  }
  return { error: `model "${spec}" is not available (no credentials, or unknown to the runtime)` }
}

const availabilityError = (runtime: RuntimeInfo): SidebetError =>
  new SidebetError(
    `${runtime.id} reports no models with credentials.`,
    'Authenticate in Pi first (run `pi` then /login, or set a provider API key such as ANTHROPIC_API_KEY), then `sidebet doctor`.',
  )

const partition = (
  project: ProjectContext,
  candidates: ModelInfo[],
): { allowed: ModelInfo[]; rejected: Rejection[] } => {
  const allowed: ModelInfo[] = []
  const rejected: Rejection[] = []
  for (const m of candidates) {
    const d = evaluateModel(project.policy, m)
    if (d.allowed) allowed.push(m)
    else rejected.push({ ref: modelRef(m), reason: d.reason })
  }
  return { allowed, rejected }
}

const explainNone = (rejected: Rejection[]): string =>
  rejected.length === 0
    ? 'No eligible model.'
    : `No eligible model. Rejected by policy:\n${rejected.map((r) => `  ${r.ref}: ${r.reason}`).join('\n')}`

export const selectModelForRun = (
  project: ProjectContext,
  runtime: RuntimeInfo,
  requested?: string,
): Selection => {
  if (runtime.models.length === 0) throw availabilityError(runtime)
  const spec = requested ?? project.config.models.default
  if (spec) {
    const found = lookupModel(spec, runtime.models, project.config.models.aliases)
    if ('error' in found) {
      throw new SidebetError(
        found.error,
        `Available: ${runtime.models.slice(0, 8).map(modelRef).join(', ')}`,
      )
    }
    const d = evaluateModel(project.policy, found.model)
    if (!d.allowed)
      throw new SidebetError(
        `${modelRef(found.model)} is denied by policy: ${d.reason}`,
        'Run `sidebet policy check` to see eligible models.',
      )
    return {
      models: [found.model],
      rejected: [],
      basis: requested ? '--model flag' : 'models.default in .sidebet/config.json',
    }
  }
  const { allowed, rejected } = partition(project, runtime.models)
  if (allowed.length === 0) throw new SidebetError(explainNone(rejected))
  const def = runtime.defaultModel
    ? allowed.find((m) => modelRef(m) === runtime.defaultModel)
    : undefined
  return {
    models: [def ?? (allowed[0] as ModelInfo)],
    rejected,
    basis: def ? `${runtime.id} default model` : 'first eligible model',
  }
}

export const selectModelsForCompare = (
  project: ProjectContext,
  runtime: RuntimeInfo,
  requested?: string[],
): Selection => {
  if (runtime.models.length === 0) throw availabilityError(runtime)
  const specs = requested ?? project.config.models.compare
  if (specs) {
    const models: ModelInfo[] = []
    const errors: string[] = []
    for (const spec of specs) {
      const found = lookupModel(spec, runtime.models, project.config.models.aliases)
      if ('error' in found) {
        errors.push(found.error)
        continue
      }
      const d = evaluateModel(project.policy, found.model)
      if (!d.allowed) errors.push(`${modelRef(found.model)} is denied by policy: ${d.reason}`)
      else if (models.some((m) => modelRef(m) === modelRef(found.model)))
        errors.push(`${modelRef(found.model)} listed twice`)
      else models.push(found.model)
    }
    if (errors.length > 0) {
      throw new SidebetError(
        errors.join('\n'),
        `Available: ${runtime.models.slice(0, 8).map(modelRef).join(', ')}`,
      )
    }
    if (models.length < 2)
      throw new SidebetError('compare needs at least two different models.', 'Use --models a,b')
    return {
      models,
      rejected: [],
      basis: requested ? '--models flag' : 'models.compare in .sidebet/config.json',
    }
  }
  const { allowed, rejected } = partition(project, runtime.models)
  if (allowed.length < 2) {
    throw new SidebetError(
      `compare needs two eligible models but only ${allowed.length} ${allowed.length === 1 ? 'is' : 'are'} available.\n${
        rejected.length > 0 ? explainNone(rejected) : ''
      }`.trim(),
      'Add credentials for another provider in Pi, or name models explicitly with --models.',
    )
  }
  const first =
    (runtime.defaultModel
      ? allowed.find((m) => modelRef(m) === runtime.defaultModel)
      : undefined) ?? (allowed[0] as ModelInfo)
  const other =
    allowed.find((m) => m.provider !== first.provider) ??
    (allowed.find((m) => m !== first) as ModelInfo)
  return {
    models: [first, other],
    rejected,
    basis: `default: ${runtime.id} default model plus the first eligible model from ${other.provider === first.provider ? 'the same' : 'another'} provider`,
  }
}
