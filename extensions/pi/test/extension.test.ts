import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DefaultResourceLoader, SettingsManager } from '@earendil-works/pi-coding-agent'
import { describe, expect, it } from 'vitest'
import sidebetExtension, { splitArgs } from '../index.js'

type Handler = (args: string, ctx: unknown) => Promise<void>

const fakePi = (
  exec: (
    cmd: string,
    args: string[],
  ) => { stdout: string; stderr: string; code: number; killed: boolean },
) => {
  const commands = new Map<string, { handler: Handler }>()
  const messages: Array<{ content: string }> = []
  const events = new Map<string, (e: unknown, ctx: unknown) => Promise<unknown>>()
  const pi = {
    registerCommand: (name: string, o: { handler: Handler }) => commands.set(name, o),
    sendMessage: (m: { content: string }) => messages.push(m),
    exec: async (cmd: string, args: string[]) => exec(cmd, args),
    on: (name: string, h: (e: unknown, ctx: unknown) => Promise<unknown>) => events.set(name, h),
  }
  return { pi, commands, messages, events }
}

describe('Pi extension', () => {
  it('is discovered by the real Pi resource loader and registers its commands', async () => {
    const agentDir = await mkdtemp(join(tmpdir(), 'pi-agent-'))
    const cwd = await mkdtemp(join(tmpdir(), 'pi-cwd-'))
    const path = fileURLToPath(new URL('../index.ts', import.meta.url))
    const loader = new DefaultResourceLoader({
      cwd,
      agentDir,
      settingsManager: SettingsManager.inMemory(),
      additionalExtensionPaths: [path],
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    })
    await loader.reload()
    const result = loader.getExtensions()
    expect(result.errors).toEqual([])
    const ext = result.extensions.find((e) => e.path.endsWith('extensions/pi/index.ts'))
    expect(ext).toBeDefined()
    expect([...(ext?.commands.keys() ?? [])].sort()).toEqual([
      'sidebet',
      'sidebet-compare',
      'sidebet-context',
      'sidebet-memory',
      'sidebet-odds',
      'sidebet-review',
    ])
    expect(ext?.handlers.has('before_agent_start')).toBe(true)
    expect(ext?.handlers.has('session_start')).toBe(true)
  })

  it('forwards commands to the sidebet CLI and shows the output', async () => {
    const calls: string[][] = []
    const { pi, commands, messages } = fakePi((_c, args) => {
      calls.push(args)
      return { stdout: 'ok-output', stderr: '', code: 0, killed: false }
    })
    sidebetExtension(pi as never)
    const ctx = { cwd: '/x', ui: { notify: () => {} } }
    await commands.get('sidebet-memory')?.handler('add "use camelCase"', ctx)
    await commands.get('sidebet-context')?.handler('refactor auth', ctx)
    await commands.get('sidebet')?.handler('', ctx)
    expect(calls[0]).toEqual(['memory', 'add', 'use camelCase', '--no-color'])
    expect(calls[1]).toEqual(['context', '--task', 'refactor auth', '--no-color'])
    expect(calls[2]).toEqual(['doctor', '--no-color'])
    expect(messages.map((m) => m.content)).toEqual(['ok-output', 'ok-output', 'ok-output'])
  })

  it('injects Sidebet context into plain Pi sessions, but not inside sidebet-managed sessions', async () => {
    const { pi, events } = fakePi(() => ({
      stdout: JSON.stringify({ rendered: '# Sidebet context\n- rule' }),
      stderr: '',
      code: 0,
      killed: false,
    }))
    sidebetExtension(pi as never)
    const hook = events.get('before_agent_start')
    const r = (await hook?.({ prompt: 'do it', systemPrompt: 'BASE' }, { cwd: '/x' })) as {
      systemPrompt: string
    }
    expect(r.systemPrompt).toBe('BASE\n\n# Sidebet context\n- rule')
    process.env.SIDEBET_SESSION = '1'
    try {
      expect(await hook?.({ prompt: 'do it', systemPrompt: 'BASE' }, { cwd: '/x' })).toBeUndefined()
    } finally {
      process.env.SIDEBET_SESSION = undefined as never
      delete process.env.SIDEBET_SESSION
    }
  })

  it('never breaks a session when sidebet is missing', async () => {
    const { pi, events } = fakePi(() => {
      throw new Error('ENOENT')
    })
    sidebetExtension(pi as never)
    expect(
      await events.get('before_agent_start')?.({ prompt: 'x', systemPrompt: 'B' }, { cwd: '/x' }),
    ).toBeUndefined()
  })

  it('splits quoted arguments', () => {
    expect(splitArgs(`--models a,b "fix the bug" 'x y'`)).toEqual([
      '--models',
      'a,b',
      'fix the bug',
      'x y',
    ])
  })
})
