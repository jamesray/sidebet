import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
  InMemoryCredentialStore,
} from '@earendil-works/pi-ai'
import { ModelRegistry, ModelRuntime } from '@earendil-works/pi-coding-agent'
import { type AttemptRequest, mergePolicies, type RuntimeEvent } from '@sidebet/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PiRuntime } from '../src/index.js'

let dir: string
let agentDir: string
let faux: ReturnType<typeof fauxProvider>

const makeRuntime = async (): Promise<PiRuntime> => {
  // Isolated credential and model store: nothing from ~/.pi/agent is read, no network.
  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    allowModelNetwork: false,
  })
  new ModelRegistry(modelRuntime).registerProvider(faux.provider)
  await modelRuntime.setRuntimeApiKey('faux', 'test-key')
  return new PiRuntime({ agentDir, modelRuntime })
}

const request = (
  over: Partial<AttemptRequest> = {},
): { req: AttemptRequest; events: RuntimeEvent[] } => {
  const events: RuntimeEvent[] = []
  const req: AttemptRequest = {
    cwd: dir,
    task: 'do the thing',
    model: { provider: 'faux', id: 'faux-1' },
    contextPrompt: '# Sidebet context\n\n- use camelCase',
    nativeContextFiles: true,
    policy: mergePolicies().policy,
    readonly: false,
    persistSession: false,
    signal: new AbortController().signal,
    timeoutMs: 20_000,
    onEvent: (e) => events.push(e),
    ...over,
  }
  return { req, events }
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'sidebet-pi-'))
  agentDir = await mkdtemp(join(tmpdir(), 'sidebet-piagent-'))
  faux = fauxProvider({ provider: 'faux', models: [{ id: 'faux-1' }] })
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
  await rm(agentDir, { recursive: true, force: true })
})

describe('PiRuntime', () => {
  it('detects models that have credentials', async () => {
    const info = await (await makeRuntime()).detect(dir)
    expect(info.available).toBe(true)
    expect(info.models.map((m) => `${m.provider}/${m.id}`)).toContain('faux/faux-1')
  })

  it('runs a prompt, reports usage and the final summary', async () => {
    faux.setResponses([fauxAssistantMessage([fauxText('All done.')])])
    const { req, events } = request()
    const outcome = await (await makeRuntime()).execute(req)
    expect(outcome.status).toBe('completed')
    expect(outcome.summary).toContain('All done.')
    expect(outcome.usage?.turns).toBe(1)
    expect(events.some((e) => e.type === 'text')).toBe(true)
  })

  it('injects the Sidebet context into the system prompt', async () => {
    let seen = ''
    faux.setResponses([
      (context) => {
        // Pi 1.x carries the system prompt as system messages in the transcript.
        seen = JSON.stringify(context.messages.filter((m) => m.role === 'system'))
        return fauxAssistantMessage([fauxText('ok')])
      },
    ])
    await (await makeRuntime()).execute(request().req)
    expect(seen).toContain('use camelCase')
  })

  it('executes tools and reports them', async () => {
    await writeFile(join(dir, 'a.txt'), 'hello')
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall('read', { path: 'a.txt' })], { stopReason: 'toolUse' }),
      fauxAssistantMessage([fauxText('read it')]),
    ])
    const { req, events } = request()
    const outcome = await (await makeRuntime()).execute(req)
    expect(outcome.status).toBe('completed')
    expect(events.filter((e) => e.type === 'tool-start')).toHaveLength(1)
    expect(events.filter((e) => e.type === 'tool-end')).toHaveLength(1)
  })

  it('blocks protected paths for real (the file is never read)', async () => {
    await writeFile(join(dir, '.env'), 'TOKEN=abc123456789')
    let toolResult = ''
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall('read', { path: '.env' })], { stopReason: 'toolUse' }),
      (context) => {
        toolResult = JSON.stringify(context.messages.at(-1))
        return fauxAssistantMessage([fauxText('could not read')])
      },
    ])
    const { req, events } = request()
    await (await makeRuntime()).execute(req)
    expect(events.some((e) => e.type === 'tool-denied')).toBe(true)
    expect(toolResult).toContain('Blocked by Sidebet policy')
    expect(toolResult).not.toContain('abc123456789')
  })

  it('read-only mode removes write tools and blocks them even if the model asks', async () => {
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall('write', { path: 'x.txt', content: 'nope' })], {
        stopReason: 'toolUse',
      }),
      fauxAssistantMessage([fauxText('done')]),
    ])
    const { req } = request({ readonly: true })
    await (await makeRuntime()).execute(req)
    await expect(readFile(join(dir, 'x.txt'), 'utf8')).rejects.toThrow()
  })

  it('denies approval-required commands when no approver is available', async () => {
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall('bash', { command: 'git push origin main' })], {
        stopReason: 'toolUse',
      }),
      fauxAssistantMessage([fauxText('done')]),
    ])
    const { req, events } = request()
    await (await makeRuntime()).execute(req)
    const denied = events.find((e) => e.type === 'tool-denied')
    expect(denied).toBeDefined()
  })

  it('cancels when the signal aborts', { timeout: 15_000 }, async () => {
    faux.setResponses([() => new Promise(() => {})])
    const ac = new AbortController()
    const { req } = request({ signal: ac.signal })
    const p = (await makeRuntime()).execute(req)
    setTimeout(() => ac.abort(), 300)
    const outcome = await p
    expect(outcome.status).toBe('cancelled')
  })
})
