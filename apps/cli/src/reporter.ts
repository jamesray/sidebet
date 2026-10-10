import type { Reporter, RuntimeEvent } from '@sidebet/core'
import { truncate, type Ui } from './ui.js'

/** Terminal progress. Tool activity goes to stderr; streamed assistant text goes to stdout (single runs only). */
export const createReporter = (ui: Ui, options: { streamText: boolean }): Reporter => {
  const show = !ui.json || ui.verbose
  const prefix = (label: string, model: string, multi: boolean): string =>
    multi ? ui.dim(`[${label} ${model}] `) : ''
  let multi = false
  let lastWasText = false
  return {
    info: (m) => show && ui.err(ui.dim(m)),
    warn: (m) => ui.err(ui.yellow(`warning: ${m}`)),
    phase: (who, m) => show && ui.err(`${prefix(who.label, who.model, true)}${ui.dim(m)}`),
    event: (who, e: RuntimeEvent) => {
      if (!show) return
      multi = !options.streamText
      const p = prefix(who.label, who.model, multi)
      switch (e.type) {
        case 'text':
          if (options.streamText && !ui.json) {
            process.stdout.write(e.delta)
            lastWasText = true
          }
          break
        case 'tool-start':
          if (lastWasText) {
            process.stdout.write('\n')
            lastWasText = false
          }
          ui.err(
            `${p}${ui.cyan('▸')} ${e.tool} ${ui.dim(truncate(e.summary, 100))}${e.approved ? ui.yellow(' (approved)') : ''}`,
          )
          break
        case 'tool-end':
          if (e.isError) ui.err(`${p}${ui.red('✗')} ${e.tool} failed`)
          break
        case 'tool-denied':
          ui.err(`${p}${ui.red('⊘')} ${e.tool} blocked: ${e.reason}`)
          break
        case 'warning':
          ui.err(`${p}${ui.yellow(e.message)}`)
          break
      }
    },
  }
}
