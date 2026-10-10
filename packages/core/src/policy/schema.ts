import { z } from 'zod'

export const DEFAULT_PROTECTED_PATHS = [
  '.env',
  '.env.*',
  '!.env.example',
  '!.env.sample',
  '**/*.pem',
  '**/*.key',
  '**/id_rsa*',
  '.git/**',
]

/** Operations that need a human yes. Without an interactive approver they are denied. */
export const DEFAULT_APPROVAL_BASH = [
  'rm\\s+(-[a-zA-Z]*r[a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*r)\\b',
  'git\\s+push\\b',
  'git\\s+reset\\s+--hard',
  'git\\s+clean\\b',
  '\\bsudo\\b',
  '(curl|wget)[^|]*\\|\\s*(sudo\\s+)?(ba|z)?sh\\b',
]

/** What a user writes in config files. Every field optional. */
export const RawPolicySchema = z.object({
  allowedProviders: z.array(z.string()).optional(),
  /** Patterns on "provider/model-id", `*` wildcards allowed. */
  allowedModels: z.array(z.string()).optional(),
  deniedModels: z.array(z.string()).optional(),
  protectedPaths: z.array(z.string()).optional(),
  readonly: z.boolean().optional(),
  tools: z
    .object({ allow: z.array(z.string()).optional(), deny: z.array(z.string()).optional() })
    .optional(),
  approvalRequired: z
    .object({ tools: z.array(z.string()).optional(), bash: z.array(z.string()).optional() })
    .optional(),
  /** Regexes for bash commands that are always denied. */
  bashDeny: z.array(z.string()).optional(),
  /**
   * With protected paths set, bash cannot be constrained reliably (a shell can read any file).
   * strict=true removes bash entirely instead of enforcing partially.
   */
  strict: z.boolean().optional(),
})
export type RawPolicy = z.infer<typeof RawPolicySchema>

export interface Policy {
  allowedProviders?: string[]
  allowedModels?: string[]
  deniedModels: string[]
  protectedPaths: string[]
  readonly: boolean
  tools: { allow?: string[]; deny: string[] }
  approvalRequired: { tools: string[]; bash: string[] }
  bashDeny: string[]
  strict: boolean
}

export interface MergedPolicy {
  policy: Policy
  warnings: string[]
}

const union = (...lists: Array<string[] | undefined>): string[] => [
  ...new Set(lists.flatMap((l) => l ?? [])),
]

/**
 * Global policy is a floor. Project policy may only add restrictions:
 *  - deny lists, protected paths, approval lists and bashDeny are unioned
 *  - readonly/strict are OR-ed
 *  - allow lists defined globally cannot be widened or replaced by a project
 */
export const mergePolicies = (
  globalPolicy: RawPolicy = {},
  projectPolicy: RawPolicy = {},
): MergedPolicy => {
  const warnings: string[] = []
  const pickAllow = (name: string, g?: string[], p?: string[]): string[] | undefined => {
    if (g && p)
      warnings.push(
        `project ${name} ignored: the global policy already defines it and cannot be widened`,
      )
    return g ?? p
  }
  const protectedPaths =
    globalPolicy.protectedPaths || projectPolicy.protectedPaths
      ? union(globalPolicy.protectedPaths, projectPolicy.protectedPaths)
      : [...DEFAULT_PROTECTED_PATHS]
  const policy: Policy = {
    allowedProviders: pickAllow(
      'allowedProviders',
      globalPolicy.allowedProviders,
      projectPolicy.allowedProviders,
    ),
    allowedModels: pickAllow(
      'allowedModels',
      globalPolicy.allowedModels,
      projectPolicy.allowedModels,
    ),
    deniedModels: union(globalPolicy.deniedModels, projectPolicy.deniedModels),
    protectedPaths,
    readonly: Boolean(globalPolicy.readonly || projectPolicy.readonly),
    tools: {
      allow: pickAllow('tools.allow', globalPolicy.tools?.allow, projectPolicy.tools?.allow),
      deny: union(globalPolicy.tools?.deny, projectPolicy.tools?.deny),
    },
    approvalRequired: {
      tools: union(globalPolicy.approvalRequired?.tools, projectPolicy.approvalRequired?.tools),
      bash:
        globalPolicy.approvalRequired?.bash || projectPolicy.approvalRequired?.bash
          ? union(globalPolicy.approvalRequired?.bash, projectPolicy.approvalRequired?.bash)
          : [...DEFAULT_APPROVAL_BASH],
    },
    bashDeny: union(globalPolicy.bashDeny, projectPolicy.bashDeny),
    strict: Boolean(globalPolicy.strict || projectPolicy.strict),
  }
  return { policy, warnings }
}
