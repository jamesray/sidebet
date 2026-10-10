import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ProjectContext } from '@sidebet/core'
import { computeOdds, loadRunDetail, resolveRun, SidebetError, type Storage } from '@sidebet/core'
import { type CliContext, openApp } from '../app.js'
import { parse } from '../args.js'
import { VERSION } from '../help.js'
import { header } from '../style/banner.js'

const PAGE = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'web', 'index.html')

interface Api {
  project: ProjectContext
  storage: Storage
}

const json = (res: ServerResponse, status: number, body: unknown): void => {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify(body))
}

/** Run list without diff/log contents, which can be megabytes per attempt. */
const summarize = (storage: Storage, runId: string) => {
  const d = loadRunDetail(storage, runId)
  return {
    ...d,
    attempts: d.attempts.map((a) => ({
      ...a,
      diff: a.diff ? { ...a.diff, content: undefined } : undefined,
      logs: a.logs.map((l) => ({ ...l, content: undefined })),
      toolEvents: a.toolEvents.length,
    })),
  }
}

export const handleApi = (api: Api, url: URL, res: ServerResponse): boolean => {
  const { storage, project } = api
  const path = url.pathname
  try {
    if (path === '/api/project') {
      json(res, 200, {
        id: project.projectId,
        name: project.name,
        root: project.root,
        version: VERSION,
      })
      return true
    }
    if (path === '/api/runs') {
      const limit = Math.min(500, Number(url.searchParams.get('limit') ?? 100))
      const runs = storage.records.list('run', {
        projectId: project.projectId,
        order: 'desc',
        limit,
      })
      json(
        res,
        200,
        runs.map((r) => summarize(storage, r.id)),
      )
      return true
    }
    const run = /^\/api\/runs\/([^/]+)$/.exec(path)
    if (run?.[1]) {
      const id = resolveRun(storage, decodeURIComponent(run[1]))
      const detail = loadRunDetail(storage, id)
      const snapshot = storage.records.get('snapshot', detail.run.contextSnapshotId)
      const policy = storage.records.get('policy', detail.run.policyVersion)
      json(res, 200, { ...detail, snapshot, policy })
      return true
    }
    if (path === '/api/odds') {
      json(res, 200, computeOdds(storage, project.projectId))
      return true
    }
    if (path === '/api/memory') {
      json(res, 200, storage.memory.list({ projectId: project.projectId }))
      return true
    }
    if (path.startsWith('/api/')) {
      json(res, 404, { error: 'not found' })
      return true
    }
  } catch (err) {
    json(res, err instanceof SidebetError ? 404 : 500, {
      error: err instanceof Error ? err.message : String(err),
    })
    return true
  }
  return false
}

export const createUiServer = (api: Api, page: string) =>
  createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405).end()
      return
    }
    if (handleApi(api, url, res)) return
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    res.end(page)
  })

const openBrowser = (url: string): void => {
  const cmd =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open'
  try {
    spawn(cmd, [url], {
      stdio: 'ignore',
      detached: true,
      shell: process.platform === 'win32',
    }).unref()
  } catch {
    // the URL is printed anyway
  }
}

/** Local, read-only web view of this project's runs, odds and memory. Binds to 127.0.0.1 only. */
export const uiCommand = async (ctx: CliContext, args: string[]): Promise<number> => {
  const { values } = parse(args, { port: { type: 'string' }, 'no-open': { type: 'boolean' } })
  const { ui } = ctx
  if (!existsSync(PAGE))
    throw new SidebetError(`UI page missing at ${PAGE}`, 'Rebuild the CLI (pnpm build).')
  const page = await readFile(PAGE, 'utf8')
  const app = await openApp(ctx)
  const server = createUiServer({ project: app.project, storage: app.storage }, page)
  const port = Number(values.port ?? 4747)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => resolve())
  }).catch((err: NodeJS.ErrnoException) => {
    throw new SidebetError(
      err.code === 'EADDRINUSE'
        ? `Port ${port} is already in use.`
        : `Could not start the UI server: ${err.message}`,
      'Pass --port <n> to use another port.',
    )
  })
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`
  for (const l of header(ui.p, VERSION, {
    context: `ui · ${app.project.name}`,
    detail: url,
    hint: 'ctrl+c to stop',
  }))
    ui.err(l)
  if (!values['no-open']) openBrowser(url)
  await new Promise<void>((resolve) => {
    ctx.signal.addEventListener('abort', () => resolve(), { once: true })
  })
  server.close()
  app.close()
  return 0
}
