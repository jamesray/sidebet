/**
 * The Sidebet chip as pixel art, from one definition.
 *
 * `renderChipSvg` draws a poker chip on a small grid (crisp, 1-pixel outline, two-tone shading,
 * eight edge notches, a dashed inner ring, a shaded centre) and emits it as an SVG of rectangles.
 * The terminal header uses the same palettes for its two-row glyph, and the web UI serves the SVG
 * from the same function, so every surface shows the same chip in the same colours.
 */

export interface ChipPalette {
  name: string
  /** Edge outline, darkest colour. */
  outline: string
  ring: string
  ringLight: string
  ringDark: string
  notch: string
  notchDark: string
  core: string
  coreLight: string
  coreDark: string
  /** Specular highlight on the centre. */
  shine: string
  /** Terminal approximations (OKLCH l c h) for ring, notch and core. */
  term: {
    ring: [number, number, number]
    notch: [number, number, number]
    core: [number, number, number]
  }
}

const cream = { notch: '#f3ead6', notchDark: '#cfc3a6' }
const gold = { core: '#e8c467', coreLight: '#f6dd93', coreDark: '#b8902e', shine: '#fff6cf' }
const silver = { core: '#d8dbe0', coreLight: '#f2f3f5', coreDark: '#9ea3ab', shine: '#ffffff' }

export const CHIP_PALETTES: Record<string, ChipPalette> = {
  red: {
    name: 'red',
    outline: '#3a1412',
    ring: '#d9453a',
    ringLight: '#ec6a5e',
    ringDark: '#a8302a',
    ...cream,
    ...gold,
    term: { ring: [0.62, 0.2, 28], notch: [0.93, 0.02, 90], core: [0.84, 0.15, 90] },
  },
  blue: {
    name: 'blue',
    outline: '#122040',
    ring: '#3a6fd9',
    ringLight: '#5f8ff0',
    ringDark: '#2a4fa8',
    ...cream,
    ...silver,
    term: { ring: [0.58, 0.18, 262], notch: [0.93, 0.02, 90], core: [0.88, 0.01, 260] },
  },
  green: {
    name: 'green',
    outline: '#0f3a20',
    ring: '#2f9e5b',
    ringLight: '#4fc27a',
    ringDark: '#1f6e3f',
    ...cream,
    ...gold,
    term: { ring: [0.62, 0.16, 152], notch: [0.93, 0.02, 90], core: [0.84, 0.15, 90] },
  },
  violet: {
    name: 'violet',
    outline: '#2a1650',
    ring: '#8a5ae0',
    ringLight: '#ad84f5',
    ringDark: '#5e3aa8',
    ...cream,
    ...gold,
    term: { ring: [0.6, 0.2, 300], notch: [0.93, 0.02, 90], core: [0.84, 0.15, 90] },
  },
  black: {
    name: 'black',
    outline: '#050506',
    ring: '#2b2b30',
    ringLight: '#4a4a52',
    ringDark: '#141417',
    notch: '#e8c467',
    notchDark: '#b8902e',
    ...silver,
    term: { ring: [0.3, 0.01, 280], notch: [0.84, 0.15, 90], core: [0.88, 0.01, 260] },
  },
  white: {
    name: 'white',
    outline: '#4a4030',
    ring: '#f1ece0',
    ringLight: '#ffffff',
    ringDark: '#c9c2b2',
    notch: '#d9453a',
    notchDark: '#a8302a',
    ...gold,
    term: { ring: [0.95, 0.01, 90], notch: [0.62, 0.2, 28], core: [0.84, 0.15, 90] },
  },
}

export const CHIP_NAMES = Object.keys(CHIP_PALETTES)
export const DEFAULT_CHIP = 'red'

/** Resolve a configured chip name; "random" picks one per call. Unknown names fall back to red. */
export const resolveChip = (name: string | undefined, seed = Math.random()): ChipPalette => {
  if (name === 'random')
    return CHIP_PALETTES[
      CHIP_NAMES[Math.floor(seed * CHIP_NAMES.length)] ?? DEFAULT_CHIP
    ] as ChipPalette
  return CHIP_PALETTES[name ?? DEFAULT_CHIP] ?? (CHIP_PALETTES[DEFAULT_CHIP] as ChipPalette)
}

type Cell = keyof Omit<ChipPalette, 'name' | 'term'> | null

/** Classify one pixel of a size×size grid. Pure geometry; palette-independent. */
const classify = (x: number, y: number, size: number): Cell => {
  const c = size / 2
  const dx = x + 0.5 - c
  const dy = y + 0.5 - c
  const r = Math.hypot(dx, dy)
  const R = c - 0.5
  if (r > R) return null
  // light from the top-left
  const s = r === 0 ? 0 : (-dx - dy) / (Math.SQRT2 * r)
  const angle = ((Math.atan2(dy, dx) * 180) / Math.PI + 360) % 360
  const u = size / 32 // all radii below are tuned on a 32-pixel grid
  const outlineIn = R - 1 // 1px outline
  const ringIn = 9.5 * u
  const sepIn = 8.6 * u // 1px dark separator between ring and centre
  const dashIn = 7.4 * u // thin stamped ring inside the separator
  // Notches: the four cardinal ones are axis-aligned bars (clean edges), the diagonals angular.
  const bar = 1.6 * u
  const cardinal = Math.abs(dx) < bar || Math.abs(dy) < bar
  const diagonal = [45, 135, 225, 315].some((a) => Math.abs(angle - a) < 7)
  if (r > outlineIn) return 'outline'
  if (r > ringIn) {
    if (cardinal || diagonal) return s < -0.6 ? 'notchDark' : 'notch'
    if (s > 0.5) return 'ringLight'
    if (s < -0.5) return 'ringDark'
    return 'ring'
  }
  if (r > sepIn) return 'outline'
  if (r > dashIn) return Math.floor(angle / 30) % 2 === 0 ? 'notch' : 'core'
  if (s > 0.8 && r > dashIn * 0.45 && r < dashIn * 0.85) return 'shine'
  if (s > 0.35) return 'coreLight'
  if (s < -0.45) return 'coreDark'
  return 'core'
}

export interface ChipSvgOptions {
  /** Grid size in pixels. 32 reads well from 24px up to 256px. */
  size?: number
  /** Rendered width/height in CSS px. */
  scale?: number
}

/** Pixel-art chip as an SVG string. Deterministic for a given palette and options. */
export const renderChipSvg = (palette: ChipPalette, options: ChipSvgOptions = {}): string => {
  const size = options.size ?? 32
  const px = options.scale ?? 3
  const rects: string[] = []
  for (let y = 0; y < size; y++) {
    let x = 0
    while (x < size) {
      const cell = classify(x, y, size)
      let run = 1
      while (x + run < size && classify(x + run, y, size) === cell) run++
      if (cell)
        rects.push(`<rect x="${x}" y="${y}" width="${run}" height="1" fill="${palette[cell]}"/>`)
      x += run
    }
  }
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size * px}" height="${size * px}" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges" role="img" aria-label="Sidebet chip (${palette.name})">`,
    ...rects,
    '</svg>',
  ].join('\n')
}
