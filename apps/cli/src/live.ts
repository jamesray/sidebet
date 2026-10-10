import type { AttemptStatus, Reporter, RuntimeEvent } from '@sidebet/core'
import { formatCost, formatDuration, formatTokens, truncate, type Ui } from './ui.js'

interface Gauge {
  label: string
  model: string
  status: AttemptStatus | 'pending'
  startedAt?: number
  endedAt?: number
  turns: number
  tools: number
  denied: number
  input: number
  output: number
  cacheRead: number
  cost?: number
  current: string
  firstEditAt?: number
}

const SPIN = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

const gaugeLine = (ui: Ui, g: Gauge, now: number, tick: number): string => {
  const elapsed = g.startedAt ? (g.endedAt ?? now) - g.startedAt : 0
  const icon =
    g.status === 'running'
      ? ui.cyan(SPIN[tick % SPIN.length] ?? '•')
      : g.status === 'completed'
        ? ui.green('✓')
        : g.status === 'pending'
          ? ui.dim('·')
          : ui.red('✗')
  const tok = g.input + g.output + g.cacheRead
  const parts = [
    formatDuration(elapsed),
    `${g.turns} ${g.turns === 1 ? 'turn' : 'turns'}`,
    `${g.tools} ${g.tools === 1 ? 'tool' : 'tools'}${g.denied ? ui.red(` (${g.denied} blocked)`) : ''}`,
    `${formatTokens(tok)} tok ${ui.dim(`↑${formatTokens(g.input + g.cacheRead)} ↓${formatTokens(g.output)}`)}`,
    g.cost !== undefined ? formatCost(g.cost) : ui.dim('cost n/a'),
  ]
  if (g.firstEditAt && g.startedAt)
    parts.push(ui.dim(`first edit ${formatDuration(g.firstEditAt - g.startedAt)}`))
  const tail = g.status === 'running' ? ui.dim(truncate(g.current, 48)) : g.status
  return `${icon} ${ui.bold(g.label)} ${g.model.padEnd(34)} ${parts.join(ui.dim(' · '))}  ${tail}`
}

/**
 * Live per-attempt gauges on stderr, redrawn in place on a TTY. Off a TTY it prints a usage line
 * after every model turn instead, so logs still show token and cost progress.
 */
export const createLiveReporter = (
  ui: Ui,
  attempts: Array<{ label: string; model: string }>,
  base: Reporter,
): Reporter & { stop(): void } => {
  const tty = Boolean(process.stderr.isTTY) && !ui.json
  const gauges = new Map<string, Gauge>(
    attempts.map((a) => [
      a.label,
      {
        ...a,
        status: 'pending',
        turns: 0,
        tools: 0,
        denied: 0,
        input: 0,
        output: 0,
        cacheRead: 0,
        current: 'waiting',
      },
    ]),
  )
  let drawn = 0
  let tick = 0
  const render = (): void => {
    if (!tty) return
    const lines = [...gauges.values()].map((g) => gaugeLine(ui, g, Date.now(), tick))
    const up = drawn > 0 ? `\u001b[${drawn}A` : ''
    process.stderr.write(`${up}${lines.map((l) => `\u001b[2K${l}`).join('\n')}\n`)
    drawn = lines.length
    tick += 1
  }
  const timer = tty ? setInterval(render, 200) : undefined
  timer?.unref()
  // Lines printed by the base reporter would corrupt the block; on a TTY we fold tool activity into the gauge.
  const log = (line: string): void => {
    if (!tty) {
      ui.err(line)
      return
    }
    // Erase the gauge block, print the line above where it was, then redraw the block below it.
    if (drawn > 0) process.stderr.write(`\u001b[${drawn}A\u001b[J`)
    process.stderr.write(`${line}\n`)
    drawn = 0
    render()
  }
  const g = (who: { label: string }): Gauge | undefined => gauges.get(who.label)
  return {
    info: (m) => log(ui.dim(m)),
    warn: (m) => log(ui.yellow(`warning: ${m}`)),
    phase: (who, m) => {
      const x = g(who)
      if (x) x.current = m
      if (!tty) base.phase(who, m)
    },
    attempt: (who, status) => {
      const x = g(who)
      if (!x) return
      x.status = status
      if (status === 'running') x.startedAt ??= Date.now()
      else x.endedAt = Date.now()
      if (!tty) ui.err(ui.dim(`[${who.label} ${who.model}] ${status}`))
      render()
    },
    event: (who, e: RuntimeEvent) => {
      const x = g(who)
      if (!x) return
      switch (e.type) {
        case 'tool-start':
          x.tools += 1
          x.current = `▸ ${e.tool} ${e.summary}`
          if ((e.tool === 'write' || e.tool === 'edit') && !x.firstEditAt)
            x.firstEditAt = Date.now()
          break
        case 'tool-end':
          x.current = e.isError ? `✗ ${e.tool} failed` : 'thinking'
          break
        case 'tool-denied':
          x.denied += 1
          x.current = `⊘ ${e.tool} blocked`
          if (tty) log(`${ui.dim(`[${who.label}]`)} ${ui.red('⊘')} ${e.tool} blocked: ${e.reason}`)
          break
        case 'usage':
          x.turns = Math.max(x.turns, e.turn)
          x.input += e.inputTokens
          x.output += e.outputTokens
          x.cacheRead += e.cacheReadTokens
          if (e.costUsd !== undefined) x.cost = (x.cost ?? 0) + e.costUsd
          if (!tty) {
            ui.err(
              ui.dim(
                `[${who.label} ${who.model}] turn ${e.turn} · ${formatTokens(x.input + x.output + x.cacheRead)} tok · ${x.cost !== undefined ? formatCost(x.cost) : 'cost n/a'} · ${formatDuration(Date.now() - (x.startedAt ?? Date.now()))}`,
              ),
            )
          }
          break
        case 'text':
          x.current = 'writing'
          break
        case 'warning':
          log(ui.yellow(e.message))
          break
      }
      if (!tty && e.type !== 'usage') base.event(who, e)
    },
    stop: () => {
      if (timer) clearInterval(timer)
      if (tty) render()
    },
  }
}
