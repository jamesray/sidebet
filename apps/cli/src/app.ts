import type { Storage } from '@sidebet/core'
import {
  type AgentRuntime,
  dbPath,
  type ProjectContext,
  type RuntimeInfo,
  resolveProject,
  SidebetError,
} from '@sidebet/core'
import type { Ui } from './ui.js'

export interface CliContext {
  cwd: string
  env: NodeJS.ProcessEnv
  ui: Ui
  signal: AbortSignal
  interactive: boolean
}

export const loadRuntime = async (env: NodeJS.ProcessEnv): Promise<AgentRuntime> => {
  if (env.SIDEBET_RUNTIME === 'fake') {
    // Offline runtime for demos and end-to-end tests. Makes no model calls.
    const { FakeRuntime } = await import('@sidebet/core/testing')
    const scriptPath = env.SIDEBET_FAKE_SCRIPT
    let options = {}
    if (scriptPath) {
      const { readFile } = await import('node:fs/promises')
      options = JSON.parse(await readFile(scriptPath, 'utf8')) as object
    }
    return new FakeRuntime(options)
  }
  const { createPiRuntime } = await import('@sidebet/runtime-pi')
  return createPiRuntime()
}

export const openStorageFor = async (env: NodeJS.ProcessEnv): Promise<Storage> => {
  const { openStorage } = await import('@sidebet/storage-local')
  return openStorage({ path: dbPath(env) })
}

export interface App {
  project: ProjectContext
  storage: Storage
  close(): void
}

export const openApp = async (ctx: CliContext): Promise<App> => {
  const project = await resolveProject(ctx.cwd, ctx.env)
  ctx.ui.debug('project resolved', {
    root: project.root,
    projectId: project.projectId,
    initialized: project.initialized,
  })
  const storage = await openStorageFor(ctx.env)
  return { project, storage, close: () => storage.close() }
}

export const openRuntime = async (
  ctx: CliContext,
): Promise<{ runtime: AgentRuntime; info: RuntimeInfo }> => {
  const runtime = await loadRuntime(ctx.env)
  const info = await runtime.detect()
  ctx.ui.debug('runtime detected', {
    runtime: info.id,
    version: info.version,
    models: info.models.length,
  })
  if (!info.available) {
    throw new SidebetError(
      `Runtime ${info.id} is unavailable.`,
      info.problems.join('; ') || 'Run `sidebet doctor`.',
    )
  }
  return { runtime, info }
}
