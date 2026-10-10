import { matchesKey, ProcessTerminal, TuiMainScreen } from '@earendil-works/pi-tui'
import type { AttemptStatus, Reporter, RuntimeEvent } from '@sidebet/core'
import { header } from './style/banner.js'
import { bar, fit, hr, padEnd, panel, sparkline, spinnerFrame, termWidth } from './style/draw.js'
import type { Palette } from './style/palette.js'
import { compactTokens, formatCost, formatDuration, truncate, type Ui } from './ui.js'

export interface Gauge {
  label: string
  model: string
  status: AttemptStatus | 'pending'
  startedAt?: number
  endedAt?: number
  turns: number
  tools: number
  denied: number
  errors: number
  input: number
  output: number
  cacheRead: number
  cost?: number
  current: string
  firstEditAt?: number
  /** Output tokens per turn, for the trend line. */
  perTurn: number[]
  error?: string
}

export interface DashboardState {
  task: string
  version: string
  gauges: Gauge[]
  startedAt: number
  tick: number
  /** Messages printed above the cards (warnings, phases). Newest last. */
  notes: string[]
  cancelling: boolean
}

const statusGlyph = (p: Palette, g: Gauge, tick: number): string => {
  switch (g.status) {
    case 'running':
      return p.fg('accent')(spinnerFrame(tick))
    case 'completed':
      return p.fg('success')('✓')
    case 'pending':
      return p.dim('·')
    default:
      return p.fg('error')('✕')
  }
}

const statusWord = (p: Palette, g: Gauge): string => {
  if (g.status === 'completed') return p.fg('success')('completed')
  if (g.status === 'running') return p.fg('accent')('running')
  if (g.status === 'pending') return p.dim('waiting')
  return p.fg('error')(g.status)
}

/** One card per attempt. Pure: same state and width give the same lines. */
export const renderCard = (
  p: Palette,
  g: Gauge,
  index: number,
  width: number,
  now: number,
  tick: number,
): string[] => {
  const lane = p.lane(index)
  const elapsed = g.startedAt ? (g.endedAt ?? now) - g.startedAt : 0
  const total = g.input + g.output + g.cacheRead
  const inner = width - 4
  const labelW = 11
  const row = (label: string, value: string): string => `${p.dim(padEnd(label, labelW))}${value}`
  const lines: string[] = []
  lines.push(
    `${statusGlyph(p, g, tick)} ${statusWord(p, g)}${p.dim(' · ')}${formatDuration(elapsed)}${g.firstEditAt && g.startedAt ? p.dim(` · first edit ${formatDuration(g.firstEditAt - g.startedAt)}`) : ''}`,
  )
  lines.push(
    row(
      'tokens',
      `${padEnd(compactTokens(total), 7)}${p.dim(`↑${compactTokens(g.input + g.cacheRead)} ↓${compactTokens(g.output)}`)}`,
    ),
  )
  const meterW = Math.max(8, Math.min(24, inner - labelW - 12))
  const cost = g.cost !== undefined ? formatCost(g.cost) : p.dim('cost n/a')
  lines.push(
    row(
      'turns',
      `${padEnd(String(g.turns), 7)}${g.perTurn.length > 1 ? p.fg('muted')(sparkline(g.perTurn, meterW)) : ''}`,
    ),
  )
  lines.push(
    row(
      'tools',
      `${padEnd(String(g.tools), 7)}${g.denied ? p.fg('error')(`${g.denied} blocked `) : ''}${g.errors ? p.fg('warning')(`${g.errors} failed`) : ''}`,
    ),
  )
  lines.push(row('cost', cost))
  const activity =
    g.status === 'running'
      ? p.fg('text')(truncate(g.current, inner))
      : g.error
        ? p.fg('error')(truncate(g.error, inner))
        : g.status === 'completed'
          ? p.dim('done')
          : p.dim(g.current)
  lines.push(fit(activity, inner))
  void bar
  return panel(lines, {
    width,
    title: `${g.label}  ${g.model}`,
    titleStyle: (s) => p.bold(lane(s)),
    border: lane,
    badge: g.status === 'running' ? undefined : statusWord(p, g),
  })
}

export const renderDashboard = (
  p: Palette,
  s: DashboardState,
  width: number,
  now = Date.now(),
): string[] => {
  const w = Math.max(40, width)
  const out: string[] = []
  const elapsed = formatDuration(now - s.startedAt)
  const running = s.gauges.filter((g) => g.status === 'running').length
  const detail = s.cancelling
    ? 'cancelling: stopping agents and keeping partial work'
    : `${s.gauges.length} attempts · ${running} running · ${elapsed}`
  out.push(...header(p, s.version, { detail, hint: s.cancelling ? undefined : 'ctrl+c cancel' }))
  out.push('')
  out.push(fit(`${p.dim('task')}  ${p.fg('text')(s.task)}`, w))
  out.push('')
  // Cards side by side when they fit, stacked otherwise.
  const cardW = s.gauges.length >= 2 && w >= 96 ? Math.floor((w - 2) / 2) : w
  const cards = s.gauges.map((g, i) => renderCard(p, g, i, cardW, now, s.tick))
  if (cardW === w) {
    for (const c of cards) out.push(...c, '')
  } else {
    for (let i = 0; i < cards.length; i += 2) {
      const a = cards[i] ?? []
      const b = cards[i + 1] ?? []
      const h = Math.max(a.length, b.length)
      for (let r = 0; r < h; r++) out.push(`${fit(a[r] ?? '', cardW)}  ${b[r] ?? ''}`.trimEnd())
      out.push('')
    }
  }
  const notes = s.notes.slice(-4)
  if (notes.length > 0) {
    out.push(hr(w, p.fg('border')))
    for (const n of notes) out.push(fit(n, w))
  }
  return out
}

const newGauge = (a: { label: string; model: string }): Gauge => ({
  ...a,
  status: 'pending',
  turns: 0,
  tools: 0,
  denied: 0,
  errors: 0,
  input: 0,
  output: 0,
  cacheRead: 0,
  current: 'waiting for a worktree',
  perTurn: [],
})

export interface LiveOptions {
  task: string
  version: string
  /** Called when the user presses Ctrl+C while the dashboard owns the terminal. */
  onCancel: () => void
}

/**
 * Live dashboard for compare runs. On a TTY it owns the terminal through Pi's TUI (regular mode,
 * so the final frame stays in scrollback). Elsewhere it degrades to one usage line per model turn.
 */
export const createLiveReporter = (
  ui: Ui,
  attempts: Array<{ label: string; model: string }>,
  base: Reporter,
  options: LiveOptions,
): Reporter & { stop(): void } => {
  const tty = Boolean(process.stderr.isTTY && process.stdin.isTTY) && !ui.json
  const p = ui.p
  const state: DashboardState = {
    task: options.task,
    version: options.version,
    gauges: attempts.map(newGauge),
    startedAt: Date.now(),
    tick: 0,
    notes: [],
    cancelling: false,
  }
  const g = (who: { label: string }): Gauge | undefined =>
    state.gauges.find((x) => x.label === who.label)

  let tui: TuiMainScreen | undefined
  let timer: NodeJS.Timeout | undefined
  if (tty) {
    const terminal = new ProcessTerminal()
    tui = new TuiMainScreen(terminal, false)
    const view = {
      render: (width: number) =>
        renderDashboard(p, state, Math.min(width, termWidth()), Date.now()),
      invalidate: () => {},
    }
    tui.addChild(view)
    tui.addInputListener((data) => {
      if (matchesKey(data, 'ctrl+c')) {
        if (state.cancelling) process.exit(130)
        state.cancelling = true
        options.onCancel()
        tui?.requestRender()
        return { consume: true }
      }
      return { consume: true }
    })
    tui.start()
    timer = setInterval(() => {
      state.tick += 1
      tui?.requestRender()
    }, 120)
    timer.unref()
  }
  const redraw = (): void => tui?.requestRender()
  const note = (line: string): void => {
    if (tui) {
      state.notes.push(line)
      redraw()
    } else ui.err(line)
  }

  return {
    info: (m) => note(p.dim(m)),
    warn: (m) => note(p.fg('warning')(`warning: ${m}`)),
    phase: (who, m) => {
      const x = g(who)
      if (x) x.current = m
      if (tui) redraw()
      else base.phase(who, m)
    },
    attempt: (who, status, error) => {
      const x = g(who)
      if (!x) return
      x.status = status
      if (status === 'running') x.startedAt ??= Date.now()
      else x.endedAt = Date.now()
      if (error) x.error = error
      if (!tui) ui.err(ui.dim(`[${who.label} ${who.model}] ${status}${error ? `: ${error}` : ''}`))
      redraw()
    },
    event: (who, e: RuntimeEvent) => {
      const x = g(who)
      if (!x) return
      switch (e.type) {
        case 'tool-start':
          x.tools += 1
          x.current = `${e.tool} ${e.summary}`
          if ((e.tool === 'write' || e.tool === 'edit') && !x.firstEditAt)
            x.firstEditAt = Date.now()
          break
        case 'tool-end':
          if (e.isError) x.errors += 1
          x.current = e.isError ? `${e.tool} failed` : 'thinking'
          break
        case 'tool-denied':
          x.denied += 1
          x.current = `${e.tool} blocked: ${e.reason}`
          note(
            `${p.dim(`[${who.label}]`)} ${p.fg('error')('blocked')} ${e.tool} ${p.dim(e.reason)}`,
          )
          break
        case 'usage':
          x.turns = Math.max(x.turns, e.turn)
          x.input += e.inputTokens
          x.output += e.outputTokens
          x.cacheRead += e.cacheReadTokens
          x.perTurn.push(e.outputTokens)
          if (e.costUsd !== undefined) x.cost = (x.cost ?? 0) + e.costUsd
          if (!tui) {
            ui.err(
              ui.dim(
                `[${who.label} ${who.model}] turn ${e.turn} · ${compactTokens(x.input + x.output + x.cacheRead)} tok · ${x.cost !== undefined ? formatCost(x.cost) : 'cost n/a'} · ${formatDuration(Date.now() - (x.startedAt ?? Date.now()))}`,
              ),
            )
          }
          break
        case 'text':
          x.current = 'writing'
          break
        case 'warning':
          note(p.fg('warning')(e.message))
          break
      }
      if (tui) redraw()
      else if (e.type !== 'usage') base.event(who, e)
    },
    stop: () => {
      if (timer) clearInterval(timer)
      if (tui) {
        tui.renderNow(true)
        tui.stop()
        tui = undefined
      }
    },
  }
}
