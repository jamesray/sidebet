import {
  type Color,
  getTerminalColorMode,
  oklchColor,
  styleText,
  type TerminalColorMode,
  type TextAttributes,
} from '@earendil-works/pi-tui'

export type Token =
  | 'accent'
  | 'text'
  | 'muted'
  | 'dim'
  | 'success'
  | 'error'
  | 'warning'
  | 'info'
  | 'border'
  | 'gold'
  | 'laneA'
  | 'laneB'
  | 'laneC'
  | 'laneD'

export interface StyleOptions extends TextAttributes {
  fg?: Token
  bg?: Token
}

export type Styler = (text: string) => string

export interface Palette {
  enabled: boolean
  mode: TerminalColorMode | 'none'
  appearance: 'dark' | 'light'
  style(text: string, options: StyleOptions): string
  fg(token: Token): Styler
  bold: Styler
  dim: Styler
  italic: Styler
  /** Colour for attempt lane n (A, B, C, D, then wraps). */
  lane(index: number): Styler
}

/** OKLCH keeps perceived lightness even, so A/B lanes read as equals rather than one shouting. */
const DARK: Record<Token, Color> = {
  accent: oklchColor(0.78, 0.16, 300), // violet
  text: oklchColor(0.93, 0.01, 90),
  muted: oklchColor(0.7, 0.02, 90),
  dim: oklchColor(0.55, 0.02, 90),
  success: oklchColor(0.8, 0.17, 150),
  error: oklchColor(0.72, 0.19, 25),
  warning: oklchColor(0.84, 0.16, 85),
  info: oklchColor(0.78, 0.13, 230),
  border: oklchColor(0.5, 0.04, 300),
  gold: oklchColor(0.86, 0.15, 90),
  laneA: oklchColor(0.8, 0.14, 215), // cyan
  laneB: oklchColor(0.8, 0.17, 340), // pink
  laneC: oklchColor(0.84, 0.15, 95), // amber
  laneD: oklchColor(0.8, 0.15, 160), // mint
}

const LIGHT: Record<Token, Color> = {
  accent: oklchColor(0.5, 0.2, 300),
  text: oklchColor(0.25, 0.01, 90),
  muted: oklchColor(0.45, 0.02, 90),
  dim: oklchColor(0.6, 0.02, 90),
  success: oklchColor(0.5, 0.16, 150),
  error: oklchColor(0.52, 0.2, 25),
  warning: oklchColor(0.6, 0.15, 75),
  info: oklchColor(0.5, 0.15, 240),
  border: oklchColor(0.7, 0.04, 300),
  gold: oklchColor(0.6, 0.15, 85),
  laneA: oklchColor(0.52, 0.14, 220),
  laneB: oklchColor(0.52, 0.2, 345),
  laneC: oklchColor(0.56, 0.15, 75),
  laneD: oklchColor(0.52, 0.15, 160),
}

const LANES: Token[] = ['laneA', 'laneB', 'laneC', 'laneD']

export interface PaletteOptions {
  env?: NodeJS.ProcessEnv
  /** Force colours on or off. Default: on for a TTY unless NO_COLOR / TERM=dumb. */
  color?: boolean
  isTTY?: boolean
}

/** Light terminals announce themselves through COLORFGBG ("fg;bg", bg >= 7 is light) or SIDEBET_THEME. */
export const detectAppearance = (env: NodeJS.ProcessEnv): 'dark' | 'light' => {
  const forced = env.SIDEBET_THEME?.toLowerCase()
  if (forced === 'light' || forced === 'dark') return forced
  const fgbg = env.COLORFGBG?.split(';')
  const bg = fgbg ? Number(fgbg[fgbg.length - 1]) : Number.NaN
  if (!Number.isNaN(bg) && bg >= 7 && bg !== 8) return 'light'
  return 'dark'
}

export const createPalette = (options: PaletteOptions = {}): Palette => {
  const env = options.env ?? process.env
  const isTTY = options.isTTY ?? Boolean(process.stdout.isTTY || process.stderr.isTTY)
  const enabled =
    options.color ??
    (isTTY && env.NO_COLOR === undefined && env.TERM !== 'dumb' && env.CI === undefined)
  const appearance = detectAppearance(env)
  const colors = appearance === 'light' ? LIGHT : DARK
  const mode: TerminalColorMode = enabled ? getTerminalColorMode() : '256color'
  const style = (text: string, o: StyleOptions): string => {
    if (!enabled || text === '') return text
    const { fg, bg, ...attrs } = o
    return styleText(
      text,
      { ...attrs, fg: fg ? colors[fg] : undefined, bg: bg ? colors[bg] : undefined },
      mode,
    )
  }
  const fg =
    (token: Token): Styler =>
    (text) =>
      style(text, { fg: token })
  return {
    enabled,
    mode: enabled ? mode : 'none',
    appearance,
    style,
    fg,
    bold: (t) => style(t, { bold: true }),
    dim: (t) => style(t, { fg: 'dim' }),
    italic: (t) => style(t, { italic: true }),
    lane: (i) => fg(LANES[i % LANES.length] ?? 'laneA'),
  }
}
