import { type ModelInfo, modelRef } from '../runtime.js'
import { matchesGlob, matchesModelPattern } from '../util/glob.js'
import type { Policy } from './schema.js'

export interface Decision {
  allowed: boolean
  reason: string
  /** Allowed only after a human approves. */
  needsApproval?: boolean
}

const allow = (reason: string): Decision => ({ allowed: true, reason })
const deny = (reason: string): Decision => ({ allowed: false, reason })

/** Gitignore-style: patterns are evaluated in order, "!pattern" re-allows, the last match wins. */
export const isProtectedPath = (policy: Policy, relPath: string): boolean => {
  let hit = false
  for (const p of policy.protectedPaths) {
    if (p.startsWith('!')) {
      if (matchesGlob(relPath, p.slice(1))) hit = false
    } else if (matchesGlob(relPath, p)) {
      hit = true
    }
  }
  return hit
}

export const evaluateModel = (
  policy: Policy,
  model: { provider: string; id: string },
): Decision => {
  const ref = modelRef(model)
  if (policy.allowedProviders && !policy.allowedProviders.includes(model.provider)) {
    return deny(
      `provider "${model.provider}" is not in policy.allowedProviders (${policy.allowedProviders.join(', ')})`,
    )
  }
  const denied = policy.deniedModels.find((p) => matchesModelPattern(ref, p))
  if (denied) return deny(`${ref} matches policy.deniedModels pattern "${denied}"`)
  if (policy.allowedModels && !policy.allowedModels.some((p) => matchesModelPattern(ref, p))) {
    return deny(`${ref} matches none of policy.allowedModels (${policy.allowedModels.join(', ')})`)
  }
  return allow('permitted by policy')
}

export interface ToolCall {
  tool: string
  input: Record<string, unknown>
}

export const READ_ONLY_TOOLS = ['read', 'grep', 'find', 'ls'] as const
const PATH_TOOLS = new Set(['read', 'write', 'edit', 'grep', 'find', 'ls'])
const MUTATING_TOOLS = new Set(['write', 'edit', 'bash'])

/** Tools a runtime may expose for this policy and mode. */
export const allowedToolNames = (
  policy: Policy,
  readonly: boolean,
  available: string[],
): string[] => {
  let names = available
  if (readonly || policy.readonly) names = names.filter((n) => !MUTATING_TOOLS.has(n))
  if (policy.tools.allow) names = names.filter((n) => policy.tools.allow?.includes(n))
  names = names.filter((n) => !policy.tools.deny.includes(n))
  if (policy.strict && policy.protectedPaths.length > 0) names = names.filter((n) => n !== 'bash')
  return names
}

const stringArg = (input: Record<string, unknown>, ...keys: string[]): string | undefined => {
  for (const k of keys) {
    const v = input[k]
    if (typeof v === 'string') return v
  }
  return undefined
}

export const summarizeToolCall = (call: ToolCall): string => {
  if (call.tool === 'bash') return stringArg(call.input, 'command') ?? ''
  return stringArg(call.input, 'path', 'file_path', 'pattern') ?? ''
}

/**
 * Per-call enforcement, run inside the runtime's tool hook. This is real enforcement:
 * a denied call never executes. It is not a prompt instruction.
 */
export const evaluateToolCall = (
  policy: Policy,
  readonly: boolean,
  call: ToolCall,
  cwdRelative: (p: string) => string,
): Decision => {
  const tool = call.tool
  if (readonly || policy.readonly) {
    if (MUTATING_TOOLS.has(tool)) return deny(`${tool} is disabled: this run is read-only`)
  }
  if (policy.tools.deny.includes(tool)) return deny(`${tool} is listed in policy.tools.deny`)
  if (policy.tools.allow && !policy.tools.allow.includes(tool)) {
    return deny(`${tool} is not in policy.tools.allow (${policy.tools.allow.join(', ')})`)
  }
  if (tool === 'bash') {
    if (policy.strict && policy.protectedPaths.length > 0) {
      return deny(
        'bash is disabled by policy.strict because protected paths cannot be enforced inside a shell',
      )
    }
    const command = stringArg(call.input, 'command') ?? ''
    for (const pattern of policy.bashDeny) {
      if (new RegExp(pattern).test(command))
        return deny(`command matches policy.bashDeny "${pattern}"`)
    }
    // Best effort only: a shell can always read a protected file indirectly.
    for (const token of command.split(/[\s"'`;|&<>()=]+/).filter((t) => t.length > 1)) {
      if (isProtectedPath(policy, cwdRelative(token))) {
        return deny(
          `command references protected path "${token}" (best-effort check; bash cannot be fully constrained)`,
        )
      }
    }
    for (const pattern of policy.approvalRequired.bash) {
      if (new RegExp(pattern).test(command)) {
        return {
          allowed: true,
          needsApproval: true,
          reason: `command matches approvalRequired.bash "${pattern}"`,
        }
      }
    }
  }
  if (policy.approvalRequired.tools.includes(tool)) {
    return {
      allowed: true,
      needsApproval: true,
      reason: `${tool} is listed in approvalRequired.tools`,
    }
  }
  if (PATH_TOOLS.has(tool)) {
    const p = stringArg(call.input, 'path', 'file_path')
    if (p) {
      const rel = cwdRelative(p)
      if (isProtectedPath(policy, rel))
        return deny(`${rel} matches a protected path in policy.protectedPaths`)
    }
  }
  return allow('permitted by policy')
}

export type Enforcement = 'enforced' | 'partial' | 'unsupported'
export interface EnforcementRow {
  control: string
  status: Enforcement
  how: string
}

/** Honest account of what the policy can and cannot guarantee through the runtime. */
export const describeEnforcement = (policy: Policy): EnforcementRow[] => {
  const rows: EnforcementRow[] = [
    {
      control: 'Allowed providers/models',
      status: 'enforced',
      how: 'Checked before any session starts; disallowed models are never contacted.',
    },
    {
      control: 'Read-only mode',
      status: 'enforced',
      how: 'Write-capable tools (write, edit, bash) are not exposed and a tool_call hook blocks them; the working tree is verified unchanged afterwards.',
    },
    {
      control: 'Tool allow/deny lists',
      status: 'enforced',
      how: 'Tool set is restricted at session creation and re-checked by a tool_call hook. Tools added by Pi extensions are blocked unless allowed.',
    },
    {
      control: 'Approval-required operations',
      status: 'enforced',
      how: 'Matching bash commands/tools pause for a human yes on an interactive terminal; otherwise they are denied (fail closed). Compare runs never prompt, so they are denied.',
    },
    {
      control: 'Protected paths (file tools)',
      status: 'enforced',
      how: 'read/write/edit/grep/find/ls calls on matching paths are blocked, and matching files are never placed in Sidebet context.',
    },
  ]
  if (policy.protectedPaths.length > 0) {
    rows.push({
      control: 'Protected paths (bash)',
      status: policy.strict ? 'enforced' : 'partial',
      how: policy.strict
        ? 'bash is removed entirely (policy.strict) because a shell can read any file.'
        : 'A shell can read protected files (cat, grep, scripts). Set policy.strict=true to remove bash, or use read-only mode.',
    })
  }
  rows.push({
    control: 'Native context files (AGENTS.md)',
    status: 'partial',
    how: 'Pi loads AGENTS.md itself. If it is protected or contains secrets Sidebet disables native loading and injects a redacted copy. AGENTS.md files in parent directories outside the repo are not controlled.',
  })
  rows.push({
    control: 'Pi extensions and skills with their own code',
    status: 'unsupported',
    how: 'Code in installed Pi extensions runs with your permissions and is outside Sidebet policy, except in read-only mode where extensions are not loaded.',
  })
  return rows
}

export interface ModelDecision {
  model: ModelInfo
  decision: Decision
}

export const evaluateModels = (policy: Policy, models: ModelInfo[]): ModelDecision[] =>
  models.map((model) => ({ model, decision: evaluateModel(policy, model) }))
