import {
  computeOdds,
  type ModelOdds,
  type TaskCategory,
  TaskCategory as TaskCategorySchema,
} from '@sidebet/core'
import { type CliContext, openApp } from '../app.js'
import { parse } from '../args.js'
import { VERSION } from '../help.js'
import { chipStack, header } from '../style/banner.js'
import { bar } from '../style/draw.js'
import { formatCost, formatDuration, formatTokens, table, type Ui } from '../ui.js'

const pct = (n: number, d: number): string =>
  d === 0 ? '-' : `${n}/${d} (${Math.round((n / d) * 100)}%)`

const meter = (ui: Ui, n: number, d: number): string =>
  d === 0
    ? ui.dim('-')
    : `${bar(n, d, 8, { on: ui.p.fg('accent'), off: ui.p.fg('border') })} ${pct(n, d)}`

export const oddsCommand = async (ctx: CliContext, args: string[]): Promise<number> => {
  const { values } = parse(args, {
    category: { type: 'string' },
    'by-category': { type: 'boolean' },
    json: { type: 'boolean' },
  })
  const { ui } = ctx
  const cat = values.category ? TaskCategorySchema.safeParse(values.category) : undefined
  if (cat && !cat.success) {
    ui.err(
      `Unknown category "${values.category}". Choose: ${TaskCategorySchema.options.join(', ')}`,
    )
    return 2
  }
  const app = await openApp(ctx)
  try {
    const report = computeOdds(app.storage, app.project.projectId, { category: cat?.data })
    if (values.json) {
      ui.out(JSON.stringify(report, null, 2))
      return 0
    }
    for (const l of header(ui.p, VERSION, {
      context: `odds · ${app.project.name}`,
      detail: `${report.generatedFromRuns} finished run(s) · ${report.compareRuns} compare · ${report.reviewedRuns} with a recorded preference${cat?.data ? ` · ${cat.data}` : ''}`,
    }))
      ui.out(l)
    ui.out()
    if (report.models.length === 0) {
      for (const c of report.caveats) ui.out(c)
      return 0
    }
    const head = [
      'Model',
      'Runs',
      'Tests passed (objective)',
      'Preferred (human)',
      'Accepted',
      'Median time',
      'Median tokens',
      'Median cost',
    ].map((h) => ui.dim(h))
    const rows = report.models.map((m) => [
      m.model,
      String(m.attempts),
      meter(ui, m.testsPassed, m.testsRun),
      meter(ui, m.preferred, m.appearances),
      pct(m.reviewsAccepted, m.reviewsPicked),
      formatDuration(m.medianDurationMs),
      formatTokens(m.medianTotalTokens),
      m.medianCostUsd !== undefined
        ? `${formatCost(m.medianCostUsd)} (n=${m.costReported})`
        : 'n/a',
    ])
    for (const l of table([head, ...rows])) ui.out(l)
    if (report.headToHead.length > 0) {
      ui.out()
      ui.out(ui.bold('Head-to-head (same task, both attempted)'))
      for (const h of report.headToHead) {
        const tests =
          h.bothRanTests > 0
            ? `tests: ${h.bothPassed} both passed, ${h.aOnlyPassed} only ${short(h.a)}, ${h.bOnlyPassed} only ${short(h.b)}, ${h.bothFailed} both failed (n=${h.bothRanTests})`
            : 'tests: no shared results'
        ui.out(
          `  ${h.a} vs ${h.b}: ${h.runs} run(s); preferred ${h.aPreferred}-${h.bPreferred}; ${tests}`,
        )
      }
    }
    if (values['by-category']) {
      const cats = new Set<string>()
      for (const m of report.models) for (const c of Object.keys(m.byCategory)) cats.add(c)
      for (const c of [...cats].sort()) {
        ui.out()
        ui.out(ui.bold(`Category: ${c}`))
        const crow = (m: ModelOdds): string[] => {
          const o = m.byCategory[c as TaskCategory]
          return o
            ? [
                m.model,
                String(o.attempts),
                pct(o.testsPassed, o.testsRun),
                pct(o.preferred, o.appearances),
              ]
            : []
        }
        for (const l of table(report.models.map(crow).filter((r) => r.length))) ui.out(`  ${l}`)
      }
    }
    if (report.calls.total > 0) {
      ui.out()
      ui.out(
        `${ui.bold('Your calls')}  ${chipStack(ui.p, report.calls.outcomes)}  ${report.calls.hits}/${report.calls.total} matched your later preference${report.calls.streak >= 2 ? ui.dim(` · ${report.calls.streak} in a row`) : ''}`,
      )
      ui.out(
        ui.dim(
          '  A call is a `sidebet bet` placed before reviewing; it measures your prediction, not the models.',
        ),
      )
    }
    ui.out()
    for (const c of report.caveats) ui.out(ui.dim(`• ${c}`))
    return 0
  } finally {
    app.close()
  }
}

const short = (ref: string): string => ref.split('/').pop() ?? ref
