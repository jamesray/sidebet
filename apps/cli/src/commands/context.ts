import type { ContextSnapshot } from '@sidebet/core'
import { assembleContext, loadRunDetail, resolveRun, SidebetError } from '@sidebet/core'
import { type CliContext, loadRuntime, openApp } from '../app.js'
import { parse } from '../args.js'
import { contextLines } from '../present.js'
import { formatTokens, table } from '../ui.js'

export const contextCommand = async (ctx: CliContext, args: string[]): Promise<number> => {
  const inspect = args[0] === 'inspect'
  const { values, positionals } = parse(inspect ? args.slice(1) : args, {
    task: { type: 'string' },
    item: { type: 'string' },
    full: { type: 'boolean' },
    json: { type: 'boolean' },
    context: { type: 'string', multiple: true },
  })
  const { ui } = ctx
  const app = await openApp(ctx)
  try {
    let snapshot: ContextSnapshot | undefined
    let label: string
    const runArg = inspect ? positionals[0] : undefined
    if (runArg) {
      const id = resolveRun(app.storage, runArg)
      const run = loadRunDetail(app.storage, id).run
      snapshot = app.storage.records.get('snapshot', run.contextSnapshotId)
      if (!snapshot) throw new SidebetError(`Snapshot ${run.contextSnapshotId} is missing.`)
      label = `${run.id} (snapshot ${snapshot.id}, ${snapshot.createdAt})`
    } else {
      const info = await (await loadRuntime(ctx.env)).detect().catch(() => undefined)
      snapshot = await assembleContext({
        project: app.project,
        task: values.task ?? positionals.join(' '),
        memory: app.storage.memory,
        runtime: info ?? { skillDirs: [], globalContextFiles: [] },
        taskFiles: values.context,
        env: ctx.env,
      })
      label = 'current project (assembled now, not saved)'
    }
    if (values.json) {
      ui.out(JSON.stringify(snapshot, null, 2))
      return 0
    }
    if (values.item) {
      const matches = snapshot.items.filter(
        (i) =>
          i.source === values.item ||
          i.id === values.item ||
          i.source.endsWith(values.item ?? '\0'),
      )
      if (matches.length === 0)
        throw new SidebetError(
          `No context item matches "${values.item}".`,
          'Run `sidebet context inspect` to list items.',
        )
      for (const i of matches) {
        ui.out(ui.bold(`${i.kind}: ${i.source}`))
        ui.out(
          `  delivery: ${i.delivery}   scope: ${i.scope}   priority: ${i.priority}   ~${i.tokens} tokens${i.redactions ? `   ${i.redactions} secret(s) redacted` : ''}`,
        )
        ui.out(`  why:      ${i.reason}`)
        if (i.content !== undefined) ui.out(`\n${i.content}`)
        else ui.out(ui.dim('  (content not retained: item was not delivered)'))
      }
      return 0
    }
    ui.out(ui.bold(`Context for ${app.project.name}`))
    ui.out(ui.dim(label))
    ui.out()
    for (const l of contextLines(ui, snapshot, inspect)) ui.out(l)
    if (inspect && values.full) {
      ui.out()
      ui.out(ui.bold('Exact text appended to the system prompt (secrets redacted):'))
      ui.out(snapshot.rendered || ui.dim('(empty)'))
    } else if (inspect) {
      ui.out()
      ui.out(
        ui.dim(
          'Use --item <source> to see why one item was included, or --full for the exact prompt text.',
        ),
      )
    }
    if (!inspect) {
      ui.out()
      ui.out(
        ui.dim(
          `Budget ${formatTokens(snapshot.budgetTokens)} tokens. Pass --task "..." to see which memories would match a task.`,
        ),
      )
    }
    void table
    return 0
  } finally {
    app.close()
  }
}
