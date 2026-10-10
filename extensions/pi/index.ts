import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'

/**
 * Thin Pi extension. All logic lives in the `sidebet` CLI; this file only maps Pi commands to it.
 * Requires `sidebet` on PATH (or SIDEBET_BIN).
 */

const bin = (): string => process.env.SIDEBET_BIN ?? 'sidebet'

/** Subcommands /sidebet will forward. Interactive and long-running ones are deliberately excluded. */
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
])

export const splitArgs = (input: string): string[] => {
  const out: string[] = []
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g
  for (const m of input.matchAll(re)) out.push(m[1] ?? m[2] ?? m[3] ?? '')
  return out
}

export default function sidebetExtension(pi: ExtensionAPI): void {
  const sidebet = async (args: string[], cwd: string, timeout = 60_000): Promise<string> => {
    const r = await pi.exec(bin(), [...args, '--no-color'], { cwd, timeout })
    const text = `${r.stdout}${r.stderr ? `\n${r.stderr}` : ''}`.trim()
    if (r.code !== 0 && !text)
      return `sidebet exited with code ${r.code}${r.killed ? ' (timed out)' : ''}`
    return text
  }

  const show = (text: string): void => {
    pi.sendMessage(
      { customType: 'sidebet', content: text || '(no output)', display: true },
      { deliverAs: 'nextTurn' },
    )
  }

  pi.registerCommand('sidebet', {
    description: 'Run a Sidebet command (default: doctor). e.g. /sidebet runs, /sidebet odds',
    handler: async (args, ctx) => {
      const parts = splitArgs(args)
      const sub = parts[0] ?? 'doctor'
      if (!FORWARDED.has(sub)) {
        ctx.ui.notify(
          `Unknown Sidebet command "${sub}". Try: ${[...FORWARDED].join(', ')}`,
          'warning',
        )
        return
      }
      const long = sub === 'run' || sub === 'compare' || sub === 'rerun'
      if (long) ctx.ui.notify(`sidebet ${sub} started; this can take several minutes`, 'info')
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
      if (parts.length === 0) parts.push('list')
      show(await sidebet(['memory', ...parts], ctx.cwd))
    },
  })

  pi.registerCommand('sidebet-compare', {
    description:
      'Run the same task with two models in isolated worktrees: /sidebet-compare [--models a,b] "<task>"',
    handler: async (args, ctx) => {
      const parts = splitArgs(args)
      if (parts.length === 0) {
        ctx.ui.notify('Usage: /sidebet-compare [--models a,b] "<task>"', 'warning')
        return
      }
      ctx.ui.notify(
        'Comparing; your working tree stays untouched. Review with `sidebet review` afterwards.',
        'info',
      )
      show(await sidebet(['compare', ...parts], ctx.cwd, 60 * 60_000))
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
