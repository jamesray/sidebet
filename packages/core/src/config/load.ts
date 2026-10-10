import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, dirname } from 'node:path'
import { repoRoot } from '../git/git.js'
import { mergePolicies, type Policy } from '../policy/schema.js'
import { SidebetError } from '../util/exec.js'
import { hashOf, sha256 } from '../util/hash.js'
import { globalConfigPath, projectConfigPath } from './paths.js'
import { ConfigSchema, type EffectiveConfig, type SidebetConfig } from './schema.js'

export interface ProjectContext {
  root: string
  name: string
  projectId: string
  /** False when the repo has no .sidebet/config.json yet (defaults are used). */
  initialized: boolean
  config: EffectiveConfig
  policy: Policy
  policyWarnings: string[]
  /** Files that contributed to the effective config, in merge order. */
  sources: string[]
  configVersion: string
  policyVersion: string
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/** Project values override global ones; objects merge key by key, arrays replace. */
const deepMerge = (base: unknown, over: unknown): unknown => {
  if (!isObject(base) || !isObject(over)) return over === undefined ? base : over
  const out: Record<string, unknown> = { ...base }
  for (const [k, v] of Object.entries(over)) out[k] = deepMerge(base[k], v)
  return out
}

export const readJsonFile = async (path: string): Promise<unknown | undefined> => {
  if (!existsSync(path)) return undefined
  const text = await readFile(path, 'utf8')
  try {
    return JSON.parse(text)
  } catch (err) {
    throw new SidebetError(
      `${path} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      'Fix the syntax error or delete the file and re-run `sidebet init`.',
    )
  }
}

const parseConfig = (raw: unknown, path: string): SidebetConfig => {
  const parsed = ConfigSchema.safeParse(raw ?? {})
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n')
    throw new SidebetError(
      `Invalid configuration in ${path}:\n${issues}`,
      'See docs/configuration.md',
    )
  }
  return parsed.data
}

export const packageJsonName = async (root: string): Promise<string | undefined> => {
  try {
    const pkg = JSON.parse(await readFile(`${root}/package.json`, 'utf8')) as { name?: unknown }
    return typeof pkg.name === 'string' ? pkg.name.replace(/^@[^/]+\//, '') : undefined
  } catch {
    return undefined
  }
}

export const resolveProject = async (
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ProjectContext> => {
  const root = await repoRoot(cwd)
  if (!root) {
    throw new SidebetError(
      `${cwd} is not inside a Git repository.`,
      'Run Sidebet from a Git repository (git init), then `sidebet init`.',
    )
  }
  const globalPath = globalConfigPath(env)
  const projectPath = projectConfigPath(root)
  const globalRaw = await readJsonFile(globalPath)
  const projectRaw = await readJsonFile(projectPath)
  const sources: string[] = []
  if (globalRaw !== undefined) sources.push(globalPath)
  if (projectRaw !== undefined) sources.push(projectPath)

  // Validate each layer on its own so errors name the right file, then merge raw layers.
  const globalCfg = parseConfig(globalRaw, globalPath)
  const projectCfg = parseConfig(projectRaw, projectPath)
  const merged = parseConfig(deepMerge(globalRaw ?? {}, projectRaw ?? {}), 'merged configuration')
  const { policy: _ignored, ...rest } = merged
  const { policy, warnings } = mergePolicies(globalCfg.policy, projectCfg.policy)

  const name = projectCfg.name ?? (await packageJsonName(root)) ?? basename(root)
  const projectId = projectCfg.projectId ?? `prj_${sha256(root).slice(0, 8)}`
  const config: EffectiveConfig = rest
  return {
    root,
    name,
    projectId,
    initialized: projectRaw !== undefined,
    config,
    policy,
    policyWarnings: warnings,
    sources,
    configVersion: hashOf(config).slice(0, 12),
    policyVersion: `pol_${hashOf(policy).slice(0, 12)}`,
  }
}

export const newProjectId = (): string => `prj_${randomBytes(4).toString('hex')}`

export const writeProjectConfig = async (root: string, config: unknown): Promise<string> => {
  const path = projectConfigPath(root)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, 'utf8')
  return path
}
