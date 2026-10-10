import { truncateToWidth, visibleWidth } from '@earendil-works/pi-tui'
import type { Palette, Styler } from './palette.js'

export const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
export const spinnerFrame = (tick: number): string => SPINNER[tick % SPINNER.length] ?? '⠋'

export const stripAnsi = (s: string): string => s.replace(/\u001b\[[0-9;]*m/g, '')

export const padEnd = (s: string, width: number): string => {
  const w = visibleWidth(s)
  return w >= width ? s : s + ' '.repeat(width - w)
}

export const padStart = (s: string, width: number): string => {
  const w = visibleWidth(s)
  return w >= width ? s : ' '.repeat(width - w) + s
}

export const fit = (s: string, width: number): string =>
  padEnd(truncateToWidth(s, width, '…'), width)

export interface PanelOptions {
  title?: string
  width: number
  /** Border colour. */
  border?: Styler
  /** Title colour. */
  titleStyle?: Styler
  /** Right-aligned text on the top border. */
  badge?: string
  padding?: number
}

/**
 * Rounded panel. Every emitted line is exactly `width` columns, so panels stack and align.
 * Content wider than the panel is truncated with an ellipsis rather than wrapped, keeping
 * tables inside panels readable.
 */
export const panel = (lines: string[], o: PanelOptions): string[] => {
  const width = Math.max(12, o.width)
  const b = o.border ?? ((s: string) => s)
  const pad = o.padding ?? 1
  const inner = width - 2 - pad * 2
  const title = o.title ? ` ${(o.titleStyle ?? ((s: string) => s))(o.title)} ` : ''
  const badge = o.badge ? ` ${o.badge} ` : ''
  const titleW = visibleWidth(title)
  const badgeW = visibleWidth(badge)
  const fill = Math.max(0, width - 2 - titleW - badgeW)
  const top = `${b('╭')}${title ? `${b('─')}${title}` : ''}${b('─'.repeat(Math.max(0, fill - (title ? 1 : 0))))}${badge}${b('╮')}`
  const body = lines.map(
    (l) => `${b('│')}${' '.repeat(pad)}${fit(l, inner)}${' '.repeat(pad)}${b('│')}`,
  )
  const bottom = `${b('╰')}${b('─'.repeat(width - 2))}${b('╯')}`
  return [truncateToWidth(top, width, '…'), ...body, bottom]
}

/** Horizontal meter. Uses eighth-blocks for a smooth edge. */
export const bar = (
  value: number,
  max: number,
  width: number,
  p?: { on?: Styler; off?: Styler },
): string => {
  const on = p?.on ?? ((s: string) => s)
  const off = p?.off ?? ((s: string) => s)
  if (width <= 0) return ''
  const ratio = max <= 0 ? 0 : Math.max(0, Math.min(1, value / max))
  const cells = ratio * width
  const full = Math.floor(cells)
  const frac = cells - full
  const eighths = ' ▏▎▍▌▋▊▉'
  const partial = full < width ? (eighths[Math.round(frac * 8)] ?? '').trim() : ''
  const rest = Math.max(0, width - full - (partial ? 1 : 0))
  return on('█'.repeat(full) + partial) + off('░'.repeat(rest))
}

/** Compact trend line for a series, e.g. tokens per turn. */
export const sparkline = (values: number[], width = values.length): string => {
  const ticks = '▁▂▃▄▅▆▇█'
  if (values.length === 0) return ''
  const sample = values.length > width ? values.slice(-width) : values
  const max = Math.max(...sample, 1)
  return sample.map((v) => ticks[Math.min(7, Math.round((v / max) * 7))] ?? '▁').join('')
}

/** Two-column key/value lines with aligned values. */
export const kv = (rows: Array<[string, string]>, p: Palette, gap = 2): string[] => {
  const w = Math.max(0, ...rows.map(([k]) => visibleWidth(k)))
  return rows.map(
    ([k, v]) =>
      `${padEnd(p.dim(k), w + (p.enabled ? visibleWidth(p.dim(k)) - visibleWidth(k) : 0))}${' '.repeat(gap)}${v}`,
  )
}

/** Aligned columns. Widths are measured visibly so ANSI never misaligns a table. */
export const columns = (
  rows: string[][],
  gap = 2,
  align: Array<'left' | 'right'> = [],
): string[] => {
  const widths: number[] = []
  for (const r of rows) {
    for (const [i, c] of r.entries()) widths[i] = Math.max(widths[i] ?? 0, visibleWidth(c))
  }
  return rows.map((r) =>
    r
      .map((c, i) => {
        if (i === r.length - 1 && align[i] !== 'right') return c
        return align[i] === 'right' ? padStart(c, widths[i] ?? 0) : padEnd(c, widths[i] ?? 0)
      })
      .join(' '.repeat(gap))
      .trimEnd(),
  )
}

export const hr = (width: number, s?: Styler): string =>
  (s ?? ((x: string) => x))('─'.repeat(Math.max(0, width)))

export const termWidth = (fallback = 100): number => {
  const w = process.stdout.columns ?? process.stderr.columns
  return w && w > 20 ? Math.min(w, 140) : fallback
}
