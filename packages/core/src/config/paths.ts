import { homedir } from 'node:os'
import { join } from 'node:path'

export const sidebetHome = (env: NodeJS.ProcessEnv = process.env): string =>
  env.SIDEBET_HOME ?? join(homedir(), '.sidebet')

export const dbPath = (env: NodeJS.ProcessEnv = process.env): string =>
  join(sidebetHome(env), 'sidebet.db')

export const worktreesDir = (projectId: string, env: NodeJS.ProcessEnv = process.env): string =>
  join(sidebetHome(env), 'worktrees', projectId)

export const globalConfigPath = (env: NodeJS.ProcessEnv = process.env): string =>
  join(sidebetHome(env), 'config.json')

export const globalRulesDir = (env: NodeJS.ProcessEnv = process.env): string =>
  join(sidebetHome(env), 'rules')

export const projectConfigPath = (root: string): string => join(root, '.sidebet', 'config.json')
export const projectRulesDir = (root: string): string => join(root, '.sidebet', 'rules')
