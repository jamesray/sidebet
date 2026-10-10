import { columns, padEnd as padVisible, termWidth } from './style/draw.js'
import { createPalette, type Palette } from './style/palette.js'

export interface Ui {
  color: boolean
  json: boolean
  verbose: boolean
  p: Palette
  width: number
  bold(s: string): string
  dim(s: string): string
  red(s: string): string
  green(s: string): string
  yellow(s: string): string
  cyan(s: string): string
  accent(s: string): string
  muted(s: string): string
  out(line?: string): void
  err(line?: string): void
  debug(message: string, fields?: Record<string, unknown>): void
}

export const createUi = (opts: {
  color?: boolean
  json: boolean
  verbose: boolean
  env?: NodeJS.ProcessEnv
}): Ui => {
  const env = opts.env ?? process.env
  const p = createPalette({ env, color: opts.color === false ? false : undefined })
  return {
    color: p.enabled,
    json: opts.json,
    verbose: opts.verbose,
    p,
    width: termWidth(),
    bold: p.bold,
    dim: p.dim,
    red: p.fg('error'),
    green: p.fg('success'),
    yellow: p.fg('warning'),
    cyan: p.fg('info'),
    accent: p.fg('accent'),
    muted: p.fg('muted'),
    out: (line = '') => {
      process.stdout.write(`${line}\n`)
    },
    err: (line = '') => {
      process.stderr.write(`${line}\n`)
    },
    debug: (message, fields) => {
      if (!opts.verbose) return
      process.stderr.write(
        `${JSON.stringify({ level: 'debug', time: new Date().toISOString(), message, ...fields })}\n`,
      )
    },
  }
}

export const formatDuration = (ms?: number): string => {
  if (ms === undefined) return '-'
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  return `${m}m ${s % 60}s`
}

export const formatTokens = (n?: number): string =>
  n === undefined ? '-' : n.toLocaleString('en-US')

export const compactTokens = (n: number): string =>
  n < 1000 ? String(n) : n < 100_000 ? `${(n / 1000).toFixed(1)}k` : `${Math.round(n / 1000)}k`

export const formatCost = (usd?: number): string => {
  if (usd === undefined) return '-'
  return usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`
}

export const truncate = (s: string, max: number): string => {
  const one = s.replace(/\s+/g, ' ').trim()
  return one.length <= max ? one : `${one.slice(0, max - 1)}…`
}

export const pad = padVisible

export const table = (rows: string[][], gap = 2): string[] => columns(rows, gap)

export const plural = (n: number, one: string, many = `${one}s`): string =>
  `${n} ${n === 1 ? one : many}`

export const ago = (iso: string, now = Date.now()): string => {
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000))
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

export const colorDiff = (ui: Ui, patch: string): string =>
  !ui.color
    ? patch
    : patch
        .split('\n')
        .map((l) =>
          l.startsWith('+++') || l.startsWith('---') || l.startsWith('diff ')
            ? ui.bold(l)
            : l.startsWith('+')
              ? ui.green(l)
              : l.startsWith('-')
                ? ui.red(l)
                : l.startsWith('@@')
                  ? ui.cyan(l)
                  : l,
        )
        .join('\n')
