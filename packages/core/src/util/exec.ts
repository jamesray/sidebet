import { type ChildProcess, spawn } from 'node:child_process'

export interface ExecOptions {
  cwd?: string
  env?: NodeJS.ProcessEnv
  input?: string
  signal?: AbortSignal
  timeoutMs?: number
  /** Run in its own process group so the whole tree can be killed. */
  detached?: boolean
  /** Maximum bytes of stdout/stderr retained. */
  maxBuffer?: number
}

export interface ExecResult {
  code: number | null
  stdout: string
  stderr: string
  timedOut: boolean
  aborted: boolean
}

export const killTree = (child: ChildProcess, signal: NodeJS.Signals = 'SIGTERM'): void => {
  if (child.pid === undefined) return
  try {
    process.kill(-child.pid, signal)
  } catch {
    try {
      child.kill(signal)
    } catch {
      // already gone
    }
  }
}

export const exec = (
  command: string,
  args: string[],
  options: ExecOptions = {},
): Promise<ExecResult> =>
  new Promise((resolve, reject) => {
    const max = options.maxBuffer ?? 64 * 1024 * 1024
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: options.detached ?? false,
    })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let aborted = false
    const kill = (): void => {
      if (options.detached) killTree(child)
      else child.kill('SIGTERM')
      setTimeout(() => {
        if (options.detached) killTree(child, 'SIGKILL')
        else child.kill('SIGKILL')
      }, 2000).unref()
    }
    const timer = options.timeoutMs
      ? setTimeout(() => {
          timedOut = true
          kill()
        }, options.timeoutMs)
      : undefined
    const onAbort = (): void => {
      aborted = true
      kill()
    }
    if (options.signal?.aborted) onAbort()
    options.signal?.addEventListener('abort', onAbort, { once: true })
    child.stdout.on('data', (d: Buffer) => {
      if (stdout.length < max) stdout += d.toString('utf8')
    })
    child.stderr.on('data', (d: Buffer) => {
      if (stderr.length < max) stderr += d.toString('utf8')
    })
    child.on('error', (err) => {
      if (timer) clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
      reject(err)
    })
    child.on('close', (code) => {
      if (timer) clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
      resolve({ code, stdout, stderr, timedOut, aborted })
    })
    child.stdin.on('error', () => {})
    child.stdin.end(options.input ?? '')
  })

export class SidebetError extends Error {
  readonly hint?: string
  constructor(message: string, hint?: string) {
    super(message)
    this.name = 'SidebetError'
    this.hint = hint
  }
}
