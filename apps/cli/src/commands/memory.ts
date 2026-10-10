import { createInterface } from 'node:readline/promises'
import {
  loadRunDetail,
  type MemoryEntry,
  newId,
  nowIso,
  resolveRun,
  SCHEMA_VERSION,
  SidebetError,
  suggestMemories,
} from '@sidebet/core'
import { type CliContext, openApp } from '../app.js'
import { parse } from '../args.js'
import { ago, table, truncate } from '../ui.js'

const readStdin = async (): Promise<string> => {
  const chunks: Buffer[] = []
  for await (const c of process.stdin) chunks.push(c as Buffer)
  return Buffer.concat(chunks).toString('utf8').trim()
}

export const memoryCommand = async (ctx: CliContext, args: string[]): Promise<number> => {
  const sub = args[0]
  const rest = args.slice(1)
  const { values, positionals } = parse(rest, {
    global: { type: 'boolean', short: 'g' },
    tag: { type: 'string' },
    all: { type: 'boolean' },
    project: { type: 'boolean' },
    accept: { type: 'string' },
    limit: { type: 'string' },
    json: { type: 'boolean' },
  })
  const { ui } = ctx
  const app = await openApp(ctx)
  const store = app.storage.memory
  const pid = app.project.projectId
  const show = (entries: MemoryEntry[]): void => {
    if (values.json) {
      ui.out(JSON.stringify(entries, null, 2))
      return
    }
    if (entries.length === 0) {
      ui.out('No memories.')
      return
    }
    const rows = entries.map((e) => [
      e.id,
      e.scope,
      ago(e.createdAt),
      e.tags.join(','),
      truncate(e.text, 90),
    ])
    for (const l of table([
      ['ID', 'SCOPE', 'ADDED', 'TAGS', 'TEXT'].map((h) => ui.dim(h)),
      ...rows,
    ]))
      ui.out(l)
  }
  try {
    switch (sub) {
      case 'add': {
        const text = (
          positionals.join(' ') || (process.stdin.isTTY ? '' : await readStdin())
        ).trim()
        if (!text)
          throw new SidebetError(
            'memory add needs text.',
            'Example: sidebet memory add "Public API responses use camelCase"',
          )
        const entry: MemoryEntry = {
          id: newId('mem'),
          schemaVersion: SCHEMA_VERSION,
          scope: values.global ? 'global' : 'project',
          projectId: values.global ? undefined : pid,
          text,
          tags:
            values.tag
              ?.split(',')
              .map((t) => t.trim())
              .filter(Boolean) ?? [],
          source: 'human',
          createdAt: nowIso(),
        }
        store.add(entry)
        ui.out(
          values.json
            ? JSON.stringify(entry)
            : `Saved ${entry.id} (${entry.scope}). It will be included in relevant future runs; explicit rules still take precedence.`,
        )
        return 0
      }
      case 'list':
        show(
          store.list({
            projectId: pid,
            scope: values.global ? 'global' : values.project ? 'project' : undefined,
          }),
        )
        return 0
      case 'search': {
        const q = positionals.join(' ')
        if (!q) throw new SidebetError('memory search needs a query.')
        const hits = store.search(q, { projectId: pid, limit: Number(values.limit ?? 20) })
        show(hits.map((h) => h.entry))
        return 0
      }
      case 'remove': {
        const idArg = positionals[0]
        if (!idArg) throw new SidebetError('memory remove needs an id.')
        const id = store.resolveId(idArg)
        if (!id) throw new SidebetError(`No memory "${idArg}".`)
        store.remove(id)
        ui.out(`Removed ${id}.`)
        return 0
      }
      case 'suggest': {
        if (!positionals[0]) throw new SidebetError('memory suggest needs a run id.')
        const detail = loadRunDetail(app.storage, resolveRun(app.storage, positionals[0]))
        const summaries = detail.attempts.map((a) => a.attempt.summary ?? '').filter(Boolean)
        const candidates = suggestMemories(summaries.join('\n'), store, pid)
        if (candidates.length === 0) {
          ui.out(
            'No memory candidates found in this run. (Suggestions are heuristic; nothing is ever saved automatically.)',
          )
          return 0
        }
        ui.out(
          ui.bold(`Candidates from ${detail.run.id}`) +
            ui.dim('  (heuristic; review before saving)'),
        )
        for (const [i, c] of candidates.entries()) ui.out(`  ${i + 1}. ${c}`)
        let chosen: number[] = []
        if (values.accept) {
          chosen =
            values.accept === 'all'
              ? candidates.map((_, i) => i)
              : values.accept.split(',').map((n) => Number(n) - 1)
        } else if (ctx.interactive) {
          const rl = createInterface({ input: process.stdin, output: process.stdout })
          try {
            for (const [i, c] of candidates.entries()) {
              if (
                /^y/i.test((await rl.question(`Save #${i + 1} as a project memory? [y/N] `)).trim())
              )
                chosen.push(i)
              void c
            }
          } finally {
            rl.close()
          }
        } else {
          ui.out(
            ui.dim(
              '\nNot saved. Re-run with --accept 1,2 (or --accept all) to save specific candidates.',
            ),
          )
          return 0
        }
        for (const i of chosen) {
          const text = candidates[i]
          if (!text) continue
          store.add({
            id: newId('mem'),
            schemaVersion: SCHEMA_VERSION,
            scope: values.global ? 'global' : 'project',
            projectId: values.global ? undefined : pid,
            text,
            tags: [],
            source: 'suggestion',
            createdAt: nowIso(),
          })
        }
        ui.out(`Saved ${chosen.length} of ${candidates.length}.`)
        return 0
      }
      default:
        throw new SidebetError(
          `Unknown memory command "${sub ?? ''}".`,
          'Use: add | list | search | remove | suggest',
        )
    }
  } finally {
    app.close()
  }
}
