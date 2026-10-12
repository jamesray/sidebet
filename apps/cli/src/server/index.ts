import { randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AgentRuntime, ProjectContext, Storage } from '@sidebet/core'
import { loadRuntime } from '../app.js'
import { VERSION } from '../help.js'
import { renderChipSvg, resolveChip } from '../style/chip.js'
import { JobRunner } from './jobs.js'
import { type ApiContext, handleApi } from './routes.js'

export { JobRunner } from './jobs.js'
export type { ApiContext } from './routes.js'

/** The static page and its two assets ship with the CLI package; nothing is built. */
export const WEB_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'web')

const ASSETS: Record<string, string> = {
  '/': 'index.html',
  '/index.html': 'index.html',
  '/app.js': 'app.js',
  '/style.css': 'style.css',
}
const TYPES: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
}
const MAX_BODY = 1024 * 1024

/** Load once and share; a failed load is retried on the next call. */
const once = <T>(fn: () => Promise<T>): (() => Promise<T>) => {
  let pending: Promise<T> | undefined
  return () => {
    if (!pending) {
      pending = fn()
      pending.catch(() => {
        pending = undefined
      })
    }
    return pending
  }
}
const MUTATING = new Set(['POST', 'PUT', 'DELETE', 'PATCH'])
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]'])

export interface UiServerOptions {
  /** Directory holding index.html, app.js and style.css. */
  webDir?: string
  /** Serve reads only: every POST/PUT/DELETE answers 405. */
  readonly?: boolean
  env?: NodeJS.ProcessEnv
  version?: string
  /** Replaced in tests with a FakeRuntime; the CLI uses Pi (or SIDEBET_RUNTIME=fake). */
  loadRuntime?: () => Promise<AgentRuntime>
}

export interface UiServer extends Server {
  /** Per-process secret the page sends back in `x-sidebet-token` on every mutation. */
  token: string
  api: ApiContext
}

const send = (res: ServerResponse, status: number, type: string, body: string | Buffer): void => {
  res.writeHead(status, {
    'content-type': type,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'content-security-policy':
      "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  })
  res.end(body)
}

const json = (res: ServerResponse, status: number, body: unknown): void =>
  send(res, status, 'application/json; charset=utf-8', JSON.stringify(body))

const hostOf = (value: string | undefined): string | undefined => {
  if (!value) return undefined
  // "127.0.0.1:4747", "localhost:4747", "[::1]:4747"
  const m = /^(\[[^\]]+\]|[^:]+)(?::\d+)?$/.exec(value.trim())
  return m?.[1]?.toLowerCase()
}

const readBody = (req: IncomingMessage): Promise<unknown> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > MAX_BODY) {
        reject(new Error('Request body is too large (1 MB limit).'))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      if (!text.trim()) return resolve(undefined)
      try {
        resolve(JSON.parse(text))
      } catch {
        reject(new Error('Request body is not valid JSON.'))
      }
    })
    req.on('error', reject)
  })

/**
 * Local web app for one project. Binds to 127.0.0.1 only (the caller passes the address to
 * `listen`). Reads are open to the page; mutations need the page's token, which also forces a
 * CORS preflight that is never answered, so other sites cannot drive the API from a browser.
 */
export const createUiServer = (
  app: { project: ProjectContext; storage: Storage },
  options: UiServerOptions = {},
): UiServer => {
  const env = options.env ?? process.env
  const webDir = options.webDir ?? WEB_DIR
  const token = randomBytes(16).toString('hex')
  const api: ApiContext = {
    project: app.project,
    storage: app.storage,
    env,
    readonly: Boolean(options.readonly),
    version: options.version ?? VERSION,
    loadRuntime: options.loadRuntime ?? once(() => loadRuntime(env)),
    jobs: new JobRunner(),
  }

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const method = req.method ?? 'GET'
    const url = new URL(req.url ?? '/', 'http://localhost')
    // DNS-rebinding defence: a page on evil.example resolving to 127.0.0.1 still sends its own Host.
    const host = hostOf(req.headers.host)
    if (!host || !LOCAL_HOSTS.has(host)) return json(res, 403, { error: 'forbidden host' })
    // Preflights are never answered with CORS headers, so cross-origin scripts cannot proceed.
    if (method === 'OPTIONS') {
      res.writeHead(204).end()
      return
    }
    const origin = req.headers.origin
    if (origin && hostOf(origin.replace(/^https?:\/\//, '')) !== host)
      return json(res, 403, { error: 'cross-origin requests are not allowed' })

    if (url.pathname.startsWith('/api/')) {
      let body: unknown
      if (MUTATING.has(method)) {
        if (api.readonly)
          return json(res, 405, {
            error: 'This UI was started read-only (sidebet ui --readonly).',
            hint: 'Restart without --readonly to start runs, review, or edit settings here.',
          })
        if (req.headers['x-sidebet-token'] !== token)
          return json(res, 403, { error: 'missing or invalid x-sidebet-token' })
        try {
          body = await readBody(req)
        } catch (err) {
          return json(res, 400, { error: err instanceof Error ? err.message : String(err) })
        }
      } else if (method !== 'GET' && method !== 'HEAD') {
        return json(res, 405, { error: `${method} is not supported.` })
      }
      const out = await handleApi(api, { method, url, body })
      return json(res, out.status, out.body)
    }

    if (method !== 'GET' && method !== 'HEAD') {
      res.writeHead(405).end()
      return
    }
    if (url.pathname === '/chip.svg') {
      const palette = resolveChip(
        url.searchParams.get('variant') ?? env.SIDEBET_CHIP ?? api.project.config.ui.chip,
      )
      return send(res, 200, 'image/svg+xml; charset=utf-8', renderChipSvg(palette, { scale: 4 }))
    }
    const asset = ASSETS[url.pathname]
    if (!asset) return send(res, 404, 'text/plain; charset=utf-8', 'not found')
    let text = await readFile(join(webDir, asset), 'utf8')
    if (asset === 'index.html') text = text.replace('__SIDEBET_TOKEN__', token)
    const ext = asset.slice(asset.lastIndexOf('.') + 1)
    return send(res, 200, TYPES[ext] ?? 'application/octet-stream', text)
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      if (!res.headersSent)
        json(res, 500, { error: err instanceof Error ? err.message : String(err) })
      else res.end()
    })
  }) as UiServer
  server.token = token
  server.api = api
  return server
}
