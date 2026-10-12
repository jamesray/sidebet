import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { SidebetError } from '@sidebet/core'
import { type CliContext, openApp } from '../app.js'
import { parse } from '../args.js'
import { VERSION } from '../help.js'
import { createUiServer, WEB_DIR } from '../server/index.js'
import { header } from '../style/banner.js'

export { createUiServer } from '../server/index.js'

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

/**
 * Local web app for this project: runs, review, odds, memory, context, policy, doctor and
 * settings, plus starting runs and compares. Binds to 127.0.0.1 only. `--readonly` keeps it a viewer.
 */
export const uiCommand = async (ctx: CliContext, args: string[]): Promise<number> => {
  const { values } = parse(args, {
    port: { type: 'string' },
    'no-open': { type: 'boolean' },
    readonly: { type: 'boolean' },
  })
  const { ui } = ctx
  for (const f of ['index.html', 'app.js', 'style.css']) {
    if (!existsSync(join(WEB_DIR, f)))
      throw new SidebetError(
        `UI file missing: ${join(WEB_DIR, f)}`,
        'Rebuild the CLI (pnpm build).',
      )
  }
  const app = await openApp(ctx)
  const server = createUiServer(
    { project: app.project, storage: app.storage },
    { env: ctx.env, readonly: values.readonly },
  )
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
    context: `ui · ${app.project.name}${values.readonly ? ' · read-only' : ''}`,
    detail: url,
    hint: 'ctrl+c to stop',
  }))
    ui.err(l)
  if (!values['no-open']) openBrowser(url)
  await new Promise<void>((resolve) => {
    ctx.signal.addEventListener('abort', () => resolve(), { once: true })
  })
  const active = server.api.jobs.active
  if (active) server.api.jobs.cancel(active.id)
  server.close()
  app.close()
  return 0
}
