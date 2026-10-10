import type { ExtensionAPI, ExtensionCommandContext } from '@earendil-works/pi-coding-agent'
import { Container, matchesKey, Text } from '@earendil-works/pi-tui'

/**
 * Thin Pi extension. All logic lives in the `sidebet` CLI; this file maps Pi commands and UI to it.
 * Requires `sidebet` on PATH (or SIDEBET_BIN).
 */

const bin = (): string => process.env.SIDEBET_BIN ?? 'sidebet'

/** Subcommands /sidebet will forward. */
const FORWARDED = new Set([
  'doctor',
  'context',
  'memory',
  'runs',
  'odds',
  'policy',
  'models',
  'review',
  'init',
  'rerun',
  'run',
  'compare',
  'bet',
])

export const splitArgs = (input: string): string[] => {
  const out: string[] = []
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g
  for (const m of input.matchAll(re)) out.push(m[1] ?? m[2] ?? m[3] ?? '')
  return out
}

interface AttemptSummary {
  attempt: {
    label: string
    model: string
    status: string
    changedFiles: string[]
    durationMs?: number
  }
  tests: Array<{ status: string; passed?: number; failed?: number }>
  usage?: { totalTokens: number; costUsd?: number }
  diff?: { content: string }
}
interface RunSummary {
  run: { id: string; task: string; status: string }
  attempts: AttemptSummary[]
  reviews: Array<{ preferredAttemptId?: string; accepted: boolean }>
}
interface OddsReport {
  generatedFromRuns: number
  reviewedRuns: number
  models: Array<{
    model: string
    attempts: number
    testsRun: number
    testsPassed: number
    appearances: number
    preferred: number
    medianDurationMs?: number
    medianCostUsd?: number
  }>
  calls: { hits: number; total: number; outcomes: Array<'hit' | 'miss'> }
  caveats: string[]
}

const fmtDuration = (ms?: number): string =>
  ms === undefined
    ? '-'
    : ms < 1000
      ? `${Math.round(ms)}ms`
      : ms < 60_000
        ? `${(ms / 1000).toFixed(1)}s`
        : `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`
const pct = (n: number, d: number): string =>
  d === 0 ? '-' : `${n}/${d} (${Math.round((n / d) * 100)}%)`

export default function sidebetExtension(pi: ExtensionAPI): void {
  const sidebet = async (args: string[], cwd: string, timeout = 60_000): Promise<string> => {
    const r = await pi.exec(bin(), [...args, '--no-color'], { cwd, timeout })
    const text = `${r.stdout}${r.stderr ? `\n${r.stderr}` : ''}`.trim()
    if (r.code !== 0 && !text)
      return `sidebet exited with code ${r.code}${r.killed ? ' (timed out)' : ''}`
    return text
  }
  const sidebetJson = async <T>(
    args: string[],
    cwd: string,
    timeout = 60_000,
  ): Promise<T | undefined> => {
    const r = await pi.exec(bin(), [...args, '--json'], { cwd, timeout })
    if (r.code !== 0 || !r.stdout.trim()) return undefined
    try {
      return JSON.parse(r.stdout) as T
    } catch {
      return undefined
    }
  }

  const show = (text: string): void => {
    pi.sendMessage(
      { customType: 'sidebet', content: text || '(no output)', display: true },
      { deliverAs: 'nextTurn' },
    )
  }
  const notify = (
    ctx: ExtensionCommandContext,
    text: string,
    type: 'info' | 'warning' | 'error' = 'info',
  ): void => {
    if (ctx.hasUI) ctx.ui.notify(text, type)
    else show(text)
  }

  // A quiet status entry so you can see Sidebet is active and what it adds to the session.
  pi.on('session_start', async (_event, ctx) => {
    if (!ctx.hasUI || process.env.SIDEBET_SESSION === '1') return
    try {
      const snap = await sidebetJson<{ items: Array<{ kind: string; delivery: string }> }>(
        ['context'],
        ctx.cwd,
        8000,
      )
      if (!snap) return
      const rules = snap.items
        .filter((i) => i.kind === 'rule' || i.kind === 'agents')
        .filter((i) => i.delivery !== 'omitted').length
      const memories = snap.items.filter(
        (i) => i.kind === 'memory' && i.delivery === 'injected',
      ).length
      ctx.ui.setStatus(
        'sidebet',
        `◉ sidebet · ${rules} rule${rules === 1 ? '' : 's'} · ${memories} memor${memories === 1 ? 'y' : 'ies'}`,
      )
    } catch {
      // never block a session on Sidebet
    }
  })

  pi.registerCommand('sidebet', {
    description: 'Run a Sidebet command (default: doctor). e.g. /sidebet runs, /sidebet odds',
    getArgumentCompletions: (prefix: string) => {
      const items = [...FORWARDED]
        .filter((s) => s.startsWith(prefix))
        .map((s) => ({ value: s, label: s }))
      return items.length ? items : null
    },
    handler: async (args, ctx) => {
      const parts = splitArgs(args)
      const sub = parts[0] ?? 'doctor'
      if (!FORWARDED.has(sub)) {
        notify(
          ctx,
          `Unknown Sidebet command "${sub}". Try: ${[...FORWARDED].join(', ')}`,
          'warning',
        )
        return
      }
      const long = sub === 'run' || sub === 'compare' || sub === 'rerun'
      if (long) notify(ctx, `sidebet ${sub} started; this can take several minutes`)
      show(await sidebet(parts.length ? parts : ['doctor'], ctx.cwd, long ? 60 * 60_000 : 60_000))
    },
  })

  pi.registerCommand('sidebet-context', {
    description: 'Show the Sidebet context (rules, memory, skills) for an optional task',
    handler: async (args, ctx) => {
      show(await sidebet(args.trim() ? ['context', '--task', args.trim()] : ['context'], ctx.cwd))
    },
  })

  pi.registerCommand('sidebet-memory', {
    description: 'Manage memory: add <text> | list | search <query> | remove <id>',
    getArgumentCompletions: (prefix: string) => {
      const items = ['add', 'list', 'search', 'remove', 'suggest']
        .filter((s) => s.startsWith(prefix))
        .map((s) => ({ value: s, label: s }))
      return items.length ? items : null
    },
    handler: async (args, ctx) => {
      const parts = splitArgs(args)
      if (parts.length === 0 && ctx.hasUI) {
        const text = await ctx.ui.input(
          'Remember for this project',
          'e.g. Public API responses use camelCase',
        )
        if (!text) return
        parts.push('add', text)
      }
      if (parts.length === 0) parts.push('list')
      show(await sidebet(['memory', ...parts], ctx.cwd))
    },
  })

  pi.registerCommand('sidebet-compare', {
    description:
      'Run the same task with two models in isolated worktrees: /sidebet-compare [--models a,b] "<task>"',
    handler: async (args, ctx) => {
      let parts = splitArgs(args)
      if (parts.length === 0) {
        if (!ctx.hasUI) {
          show('Usage: /sidebet-compare [--models a,b] "<task>"')
          return
        }
        const task = await ctx.ui.input(
          'Task for both models',
          'e.g. Make search case-insensitive and add a test',
        )
        if (!task) return
        const models = await sidebetJson<{
          models: Array<{ ref: string; eligible: boolean; alias?: string; isDefault: boolean }>
        }>(['models'], ctx.cwd)
        const eligible = models?.models.filter((m) => m.eligible).map((m) => m.ref) ?? []
        let pair: string[] | undefined
        if (eligible.length >= 2) {
          const a = await ctx.ui.select('Model A', ['(configured default pair)', ...eligible])
          if (a === undefined) return
          if (a !== '(configured default pair)') {
            const b = await ctx.ui.select(
              'Model B',
              eligible.filter((m) => m !== a),
            )
            if (b === undefined) return
            pair = [a, b]
          }
        }
        parts = pair ? ['--models', pair.join(','), task] : [task]
      }
      notify(ctx, 'Comparing in isolated worktrees; your files stay untouched.')
      show(await sidebet(['compare', ...parts], ctx.cwd, 60 * 60_000))
    },
  })

  pi.registerCommand('sidebet-review', {
    description: 'Review the latest comparison: diffs, preference, apply',
    handler: async (args, ctx) => {
      const runArg = splitArgs(args)[0]
      const detail = await sidebetJson<RunSummary>(['review', ...(runArg ? [runArg] : [])], ctx.cwd)
      if (!detail) {
        notify(ctx, 'No comparison to review yet. Try /sidebet-compare.', 'warning')
        return
      }
      if (!ctx.hasUI) {
        show(await sidebet(['review', detail.run.id], ctx.cwd))
        return
      }
      const labelOf = (id?: string): string | undefined =>
        detail.attempts.find((a) => a.attempt.label === id)?.attempt.label
      let preferred: string | undefined
      for (;;) {
        const lines = detail.attempts.map((a) => {
          const t = a.tests[0]
          const tests = t
            ? `${t.status}${t.passed !== undefined ? ` (${t.passed} passed${t.failed ? `, ${t.failed} failed` : ''})` : ''}`
            : 'not run'
          return `${a.attempt.label}  ${a.attempt.model}  ·  ${a.attempt.status}  ·  ${a.attempt.changedFiles.length} files  ·  tests ${tests}  ·  ${fmtDuration(a.attempt.durationMs)}`
        })
        const options = [
          ...detail.attempts.map((a) => `View ${a.attempt.label} diff`),
          ...(detail.attempts.length === 2 ? ['Compare A and B'] : []),
          `Select preferred${preferred ? ` (now ${preferred})` : ''}`,
          'Record review',
          'Apply a result',
          'Open the full review in a terminal',
          'Done',
        ]
        const choice = await ctx.ui.select(`${detail.run.task}\n${lines.join('\n')}`, options)
        if (!choice || choice === 'Done') return
        if (choice.startsWith('View ')) {
          const label = choice.split(' ')[1] ?? ''
          const a = detail.attempts.find((x) => x.attempt.label === label)
          const patch = a?.diff?.content ?? ''
          show(
            patch
              ? `**${label} · ${a?.attempt.model}**\n\n\`\`\`diff\n${patch}\n\`\`\``
              : `${label} made no changes.`,
          )
        } else if (choice === 'Compare A and B') {
          const { renderDiff } = await import('@earendil-works/pi-coding-agent')
          const text = await sidebet(['review', detail.run.id, '--compare'], ctx.cwd)
          await ctx.ui.custom<void>((tui, theme, _kb, done) => {
            const c = new Container()
            c.addChild(
              new Text(theme.fg('accent', theme.bold('A → B')) + theme.fg('dim', '  esc/q close')),
            )
            c.addChild(new Text(renderDiff(text)))
            return {
              render: (w) => c.render(w),
              invalidate: () => c.invalidate(),
              handleInput: (data: string) => {
                if (matchesKey(data, 'escape') || matchesKey(data, 'q')) done()
                tui.requestRender()
              },
            }
          })
        } else if (choice.startsWith('Select preferred')) {
          const pick = await ctx.ui.select(
            'Preferred result',
            detail.attempts.map((a) => `${a.attempt.label}  ${a.attempt.model}`),
          )
          if (pick) preferred = labelOf(pick.split(' ')[0])
        } else if (choice === 'Record review') {
          const accepted = await ctx.ui.confirm('Record review', 'Accept this solution?')
          const reason = (await ctx.ui.input('Reason (optional)')) ?? ''
          const flags = [
            ...(preferred ? ['--select', preferred] : []),
            accepted ? '--accept' : '--reject',
            ...(reason ? ['--reason', reason] : []),
          ]
          notify(ctx, await sidebet(['review', detail.run.id, ...flags], ctx.cwd))
        } else if (choice === 'Apply a result') {
          const pick = await ctx.ui.select(
            'Apply which result?',
            detail.attempts.map((a) => `${a.attempt.label}  ${a.attempt.model}`),
          )
          if (!pick) continue
          const label = pick.split(' ')[0] ?? ''
          const preview = await sidebet(['review', detail.run.id, '--apply', label], ctx.cwd)
          const ok = await ctx.ui.confirm('Apply to your working tree?', preview)
          if (ok) show(await sidebet(['review', detail.run.id, '--apply', label, '--yes'], ctx.cwd))
        } else if (choice.startsWith('Open the full review')) {
          show(`Run this in a terminal:\n\n\`\`\`\nsidebet review ${detail.run.id}\n\`\`\``)
          return
        }
      }
    },
  })

  pi.registerCommand('sidebet-odds', {
    description: 'Your model history for this project, as a panel',
    handler: async (args, ctx) => {
      const report = await sidebetJson<OddsReport>(['odds', ...splitArgs(args)], ctx.cwd)
      if (!report) {
        notify(ctx, 'Could not load odds (is sidebet on PATH and the repo initialised?)', 'warning')
        return
      }
      if (!ctx.hasUI) {
        show(await sidebet(['odds'], ctx.cwd))
        return
      }
      await ctx.ui.custom<void>(
        (tui, theme, _kb, done) => {
          const c = new Container()
          const dim = (s: string) => theme.fg('dim', s)
          c.addChild(
            new Text(
              `${theme.fg('accent', theme.bold('Sidebet odds'))}  ${dim(`${report.generatedFromRuns} runs · ${report.reviewedRuns} reviewed · esc close`)}`,
            ),
          )
          c.addChild(new Text(''))
          const rows = report.models.map((m) => [
            m.model,
            String(m.attempts),
            pct(m.testsPassed, m.testsRun),
            pct(m.preferred, m.appearances),
            fmtDuration(m.medianDurationMs),
            m.medianCostUsd !== undefined ? `$${m.medianCostUsd.toFixed(2)}` : '-',
          ])
          const head = ['model', 'runs', 'tests passed', 'preferred', 'median time', 'median cost']
          const widths = head.map((h, i) =>
            Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)),
          )
          const line = (r: string[]) =>
            r
              .map((cell, i) => cell.padEnd(widths[i] ?? 0))
              .join('  ')
              .replace(/\s+$/, '')
          c.addChild(new Text(dim(line(head))))
          for (const r of rows) c.addChild(new Text(line(r)))
          if (report.calls.total > 0) {
            c.addChild(new Text(''))
            c.addChild(
              new Text(
                `${theme.bold('Your calls')}  ${report.calls.outcomes.map((o) => (o === 'hit' ? theme.fg('warning', '◉') : dim('◎'))).join('')}  ${report.calls.hits}/${report.calls.total}`,
              ),
            )
          }
          c.addChild(new Text(''))
          for (const cv of report.caveats) c.addChild(new Text(dim(`• ${cv}`)))
          return {
            render: (w) => c.render(w),
            invalidate: () => c.invalidate(),
            handleInput: (data: string) => {
              if (matchesKey(data, 'escape') || matchesKey(data, 'q') || matchesKey(data, 'enter'))
                done()
              tui.requestRender()
            },
          }
        },
        { overlay: true, overlayOptions: { anchor: 'center', width: '80%' } },
      )
    },
  })

  // Share Sidebet rules and relevant memory with plain Pi sessions. Sessions started by
  // `sidebet run/compare` set SIDEBET_SESSION and already carry the approved context, so skip them.
  pi.on('before_agent_start', async (event, ctx) => {
    if (process.env.SIDEBET_SESSION === '1' || process.env.SIDEBET_PI_CONTEXT === '0')
      return undefined
    try {
      const out = await pi.exec(
        bin(),
        ['context', '--json', '--task', event.prompt.slice(0, 500)],
        { cwd: ctx.cwd, timeout: 5000 },
      )
      if (out.code !== 0) return undefined
      const snapshot = JSON.parse(out.stdout) as { rendered?: string }
      if (!snapshot.rendered) return undefined
      return { systemPrompt: `${event.systemPrompt}\n\n${snapshot.rendered}` }
    } catch {
      return undefined // never block the session because Sidebet is missing or slow
    }
  })
}
