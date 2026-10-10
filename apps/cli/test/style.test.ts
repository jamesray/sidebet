import { visibleWidth } from '@earendil-works/pi-tui'
import { describe, expect, it } from 'vitest'
import { type DashboardState, type Gauge, renderDashboard } from '../src/live.js'
import { header } from '../src/style/banner.js'
import { bar, columns, panel, sparkline } from '../src/style/draw.js'
import { createPalette } from '../src/style/palette.js'

const plain = createPalette({ color: false, env: {} })
const colored = createPalette({ color: true, env: { COLORTERM: 'truecolor' } })

const gauge = (label: string, over: Partial<Gauge> = {}): Gauge => ({
  label,
  model: `provider/model-${label.toLowerCase()}`,
  status: 'running',
  startedAt: 1000,
  turns: 3,
  tools: 7,
  denied: 1,
  errors: 0,
  input: 12_000,
  output: 900,
  cacheRead: 4000,
  cost: 0.042,
  current: 'edit src/handler.ts',
  perTurn: [200, 400, 300],
  ...over,
})

const state = (gauges: Gauge[]): DashboardState => ({
  task: 'Refactor the search handler',
  version: '0.1.0',
  gauges,
  startedAt: 0,
  tick: 3,
  notes: ['warning: something'],
  cancelling: false,
})

describe('palette', () => {
  it('is inert without colour and styles with it', () => {
    expect(plain.fg('accent')('x')).toBe('x')
    expect(plain.bold('x')).toBe('x')
    expect(colored.fg('accent')('x')).not.toBe('x')
    expect(colored.fg('accent')('x')).toContain('x')
  })
  it('respects NO_COLOR and CI on a TTY', () => {
    expect(createPalette({ env: { NO_COLOR: '1' }, isTTY: true }).enabled).toBe(false)
    expect(createPalette({ env: { CI: '1' }, isTTY: true }).enabled).toBe(false)
    expect(createPalette({ env: {}, isTTY: false }).enabled).toBe(false)
  })
  it('picks a light palette from COLORFGBG or SIDEBET_THEME', () => {
    expect(createPalette({ env: { COLORFGBG: '0;15' } }).appearance).toBe('light')
    expect(createPalette({ env: { COLORFGBG: '15;0' } }).appearance).toBe('dark')
    expect(createPalette({ env: { SIDEBET_THEME: 'light' } }).appearance).toBe('light')
  })
})

describe('drawing', () => {
  it('panels are exactly the requested width, with or without colour', () => {
    for (const p of [plain, colored]) {
      const lines = panel(
        ['short', 'a much longer line that must be truncated to fit inside the panel body'],
        {
          width: 40,
          title: 'A  provider/model',
          badge: 'completed',
          border: p.fg('laneA'),
        },
      )
      expect(lines).toHaveLength(4)
      for (const l of lines) expect(visibleWidth(l)).toBe(40)
      expect(lines[2]).toContain('…')
    }
  })
  it('bars and sparklines scale to their width', () => {
    expect(visibleWidth(bar(5, 10, 10))).toBe(10)
    expect(bar(10, 10, 4)).toBe('████')
    expect(bar(0, 10, 4)).toBe('░░░░')
    expect(sparkline([1, 2, 3, 4], 4)).toHaveLength(4)
    expect(sparkline([1, 2, 3, 4, 5, 6], 3)).toHaveLength(3)
  })
  it('aligns columns by visible width even with ANSI', () => {
    const rows = columns([
      [colored.fg('accent')('ab'), 'x'],
      ['abcd', 'y'],
    ])
    expect(rows.map((r) => visibleWidth(r))).toEqual([7, 7])
  })
  it('header is two lines', () => {
    const h = header(colored, '0.1.0', { context: 'proj · main', detail: 'd', hint: 'h' })
    expect(h).toHaveLength(2)
    expect(h.join('\n')).toContain('sidebet')
  })
})

describe('dashboard', () => {
  it('never exceeds the terminal width and stacks or pairs cards by width', () => {
    for (const width of [60, 80, 96, 120, 140]) {
      const lines = renderDashboard(
        colored,
        state([gauge('A'), gauge('B', { status: 'completed', endedAt: 5000 })]),
        width,
        10_000,
      )
      for (const l of lines)
        expect(visibleWidth(l), `width ${width}: ${l}`).toBeLessThanOrEqual(width)
      const pairs = lines.filter((l) => l.includes('╭') && l.split('╭').length > 2)
      expect(pairs.length > 0).toBe(width >= 96)
    }
  })
  it('shows the error of a failed attempt and the cancelling state', () => {
    const s = state([
      gauge('A', {
        status: 'failed',
        error: 'OpenAI API error (400): model not supported',
        endedAt: 2000,
      }),
    ])
    const text = renderDashboard(plain, s, 100, 10_000).join('\n')
    expect(text).toContain('model not supported')
    expect(text).toContain('failed')
    s.cancelling = true
    expect(renderDashboard(plain, s, 100, 10_000).join('\n')).toContain('cancelling')
  })
})
