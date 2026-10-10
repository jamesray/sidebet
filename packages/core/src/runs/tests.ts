import { exec } from '../util/exec.js'

export interface TestRun {
  status: 'passed' | 'failed' | 'error' | 'timeout'
  exitCode: number | null
  durationMs: number
  passed?: number
  failed?: number
  outputTail: string
  note?: string
}

/** Best-effort parse of common runner summaries. Returns nothing when the format is not recognised. */
export const parseTestCounts = (output: string): { passed?: number; failed?: number } => {
  const strip = output.replace(/\u001b\[[0-9;]*m/g, '')
  // vitest / jest: "Tests  18 passed (18)" or "Tests: 2 failed, 16 passed, 18 total"
  const vitest = /Tests\s+(?:(\d+) failed\s*\|\s*)?(\d+) passed/.exec(strip)
  if (vitest) return { passed: Number(vitest[2]), failed: Number(vitest[1] ?? 0) }
  const jest = /Tests:\s+(?:(\d+) failed,\s*)?(?:\d+ skipped,\s*)?(\d+) passed/.exec(strip)
  if (jest) return { passed: Number(jest[2]), failed: Number(jest[1] ?? 0) }
  // pytest: "== 3 failed, 15 passed in 1.2s ==" or "18 passed in 0.5s"
  const pyPassed = /(\d+) passed/.exec(strip)
  const pyFailed = /(\d+) failed/.exec(strip)
  if (pyPassed && /\bin [\d.]+s/.test(strip)) {
    return { passed: Number(pyPassed[1]), failed: Number(pyFailed?.[1] ?? 0) }
  }
  // cargo: "test result: ok. 12 passed; 0 failed"
  const cargo = [...strip.matchAll(/test result: \w+\. (\d+) passed; (\d+) failed/g)]
  if (cargo.length > 0) {
    return {
      passed: cargo.reduce((n, m) => n + Number(m[1]), 0),
      failed: cargo.reduce((n, m) => n + Number(m[2]), 0),
    }
  }
  // node:test (spec reporter): "ℹ pass 12" / "ℹ fail 0"
  const nodeSpecPass = /ℹ pass (\d+)/.exec(strip)
  if (nodeSpecPass)
    return { passed: Number(nodeSpecPass[1]), failed: Number(/ℹ fail (\d+)/.exec(strip)?.[1] ?? 0) }
  // node:test TAP-ish summary
  const nodePass = /^# pass (\d+)/m.exec(strip)
  const nodeFail = /^# fail (\d+)/m.exec(strip)
  if (nodePass) return { passed: Number(nodePass[1]), failed: Number(nodeFail?.[1] ?? 0) }
  return {}
}

const tail = (text: string, lines = 40): string => text.split('\n').slice(-lines).join('\n')

export const runTestCommand = async (
  command: string,
  cwd: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<TestRun> => {
  const started = Date.now()
  try {
    const r = await exec('sh', ['-c', command], {
      cwd,
      timeoutMs,
      signal,
      detached: true,
      env: { ...process.env, CI: '1', FORCE_COLOR: '0' },
    })
    const output = `${r.stdout}\n${r.stderr}`
    const counts = parseTestCounts(output)
    const durationMs = Date.now() - started
    if (r.timedOut)
      return {
        status: 'timeout',
        exitCode: r.code,
        durationMs,
        outputTail: tail(output),
        ...counts,
      }
    if (r.aborted)
      return {
        status: 'error',
        exitCode: r.code,
        durationMs,
        outputTail: tail(output),
        note: 'cancelled',
      }
    return {
      status: r.code === 0 ? 'passed' : 'failed',
      exitCode: r.code,
      durationMs,
      outputTail: tail(output),
      ...counts,
    }
  } catch (err) {
    return {
      status: 'error',
      exitCode: null,
      durationMs: Date.now() - started,
      outputTail: '',
      note: err instanceof Error ? err.message : String(err),
    }
  }
}
