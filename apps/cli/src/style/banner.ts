import type { Palette } from './palette.js'

export const TAGLINE = 'Same context. Different models. Better decisions.'

/**
 * The chip: a two-row half-block poker chip, red ring with pale notches and a gold centre.
 * Built from block elements so it stays crisp in every terminal font.
 */
export const chip = (p: Palette): [string, string] => {
  const { ring, notch, core } = p.chip
  return [
    `${notch('▗')}${ring('▟')}${core('▀')}${ring('▙')}${notch('▖')}`,
    `${notch('▝')}${ring('▜')}${core('▄')}${ring('▛')}${notch('▘')}`,
  ]
}

export interface HeaderMeta {
  /** Right side of line one, e.g. "credits-api · main". */
  context?: string
  /** Line two, e.g. "3 rules · 2 memories · 87 models". */
  detail?: string
  /** Dim hint at the end of line two. */
  hint?: string
}

/**
 * Compact header printed at the top of interactive output, in the spirit of Pi's startup header:
 * the chip, the wordmark and version, then one line of context. Two lines, never more.
 */
export const header = (p: Palette, version: string, meta: HeaderMeta = {}): string[] => {
  const [c1, c2] = chip(p)
  const name = `${p.bold(p.fg('accent')('sidebet'))} ${p.dim(`v${version}`)}`
  const context = meta.context ? `  ${p.fg('muted')(meta.context)}` : ''
  const detail = p.fg('muted')(meta.detail ?? TAGLINE)
  const hint = meta.hint ? `  ${p.dim(meta.hint)}` : ''
  return [`${c1}  ${name}${context}`, `${c2}  ${detail}${hint}`]
}

/** Inline wordmark for dashboards and footers. */
export const wordmark = (p: Palette): string =>
  `${p.chip.ring('◉')} ${p.bold(p.fg('accent')('sidebet'))}`

/** Prediction record: a filled chip for a call that matched the recorded preference, hollow for a miss. */
export const CHIP = { hit: '◉', miss: '◎' }

export const chipStack = (p: Palette, outcomes: Array<'hit' | 'miss'>, max = 12): string =>
  outcomes
    .slice(-max)
    .map((o) => (o === 'hit' ? p.fg('gold')(CHIP.hit) : p.dim(CHIP.miss)))
    .join('')
