#!/usr/bin/env node
// node:sqlite is stable enough for us but still prints an ExperimentalWarning on some Node versions.
const emit = process.emitWarning.bind(process) as (w: string | Error, ...rest: unknown[]) => void
process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
  const text = typeof warning === 'string' ? warning : warning.message
  if (/SQLite/i.test(text)) return
  emit(warning, ...rest)
}) as typeof process.emitWarning

const { main } = await import('./main.js')
process.exitCode = await main(process.argv.slice(2))
