import { isAbsolute, relative, resolve } from 'node:path'
import {
  describeEnforcement,
  evaluateModel,
  evaluateModels,
  evaluateToolCall,
  isProtectedPath,
  lookupModel,
  modelRef,
  SidebetError,
} from '@sidebet/core'
import { type CliContext, loadRuntime, openApp } from '../app.js'
import { parse } from '../args.js'
import { table } from '../ui.js'

export const policyCommand = async (ctx: CliContext, args: string[]): Promise<number> => {
  if (args[0] !== 'check')
    throw new SidebetError(
      'Usage: sidebet policy check [--model m] [--tool t --path p | --command c] [--readonly]',
    )
  const { values } = parse(args.slice(1), {
    model: { type: 'string' },
    tool: { type: 'string' },
    path: { type: 'string' },
    command: { type: 'string' },
    readonly: { type: 'boolean' },
    json: { type: 'boolean' },
  })
  const { ui } = ctx
  const app = await openApp(ctx)
  try {
    const { project } = app
    const policy = project.policy
    const info = await (await loadRuntime(ctx.env)).detect().catch(() => undefined)
    const models = info?.models ?? []
    const verdicts = evaluateModels(policy, models)

    // Targeted questions: "why was this denied?"
    if (values.model || values.tool || values.command || values.path) {
      let denied = false
      if (values.model) {
        const found = lookupModel(values.model, models, project.config.models.aliases)
        const m =
          'model' in found
            ? found.model
            : {
                provider: values.model.split('/')[0] ?? '',
                id: values.model.split('/').slice(1).join('/') || values.model,
              }
        const d = evaluateModel(policy, m)
        if ('error' in found)
          ui.out(ui.yellow(`${found.error} (policy evaluated on the name as typed)`))
        ui.out(
          `${modelRef(m)}: ${d.allowed ? ui.green('allowed') : ui.red('denied')} - ${d.reason}`,
        )
        denied ||= !d.allowed
      }
      if (values.tool || values.command || values.path) {
        const tool = values.tool ?? (values.command ? 'bash' : 'read')
        const input: Record<string, unknown> = values.command
          ? { command: values.command }
          : { path: values.path }
        const rel = (p: string): string =>
          relative(project.root, isAbsolute(p) ? p : resolve(project.root, p))
        const d = evaluateToolCall(policy, Boolean(values.readonly), { tool, input }, rel)
        ui.out(
          `${tool} ${values.command ?? values.path ?? ''}: ${d.allowed ? (d.needsApproval ? ui.yellow('needs human approval') : ui.green('allowed')) : ui.red('denied')} - ${d.reason}`,
        )
        denied ||= !d.allowed
      }
      return denied ? 1 : 0
    }

    if (values.json) {
      ui.out(
        JSON.stringify(
          {
            policyVersion: project.policyVersion,
            sources: project.sources,
            policy,
            warnings: project.policyWarnings,
            models: verdicts.map((v) => ({ model: modelRef(v.model), ...v.decision })),
            enforcement: describeEnforcement(policy),
          },
          null,
          2,
        ),
      )
      return 0
    }
    ui.out(ui.bold(`Policy ${project.policyVersion}`))
    ui.out(
      ui.dim(
        project.sources.length
          ? `from ${project.sources.join(', ')}`
          : 'built-in defaults (no config files found)',
      ),
    )
    ui.out()
    const rows: string[][] = [
      ['Providers', policy.allowedProviders?.join(', ') ?? 'any'],
      ['Allowed models', policy.allowedModels?.join(', ') ?? 'any'],
      ['Denied models', policy.deniedModels.join(', ') || 'none'],
      ['Protected paths', policy.protectedPaths.join(', ') || 'none'],
      ['Read-only', policy.readonly ? 'always' : 'on request (--readonly)'],
      [
        'Tools',
        policy.tools.allow
          ? `only ${policy.tools.allow.join(', ')}`
          : `all except ${policy.tools.deny.join(', ') || 'none'}`,
      ],
      [
        'Approval required',
        `${policy.approvalRequired.bash.length} bash pattern(s)${policy.approvalRequired.tools.length ? `, tools: ${policy.approvalRequired.tools.join(', ')}` : ''}`,
      ],
      ['Always-denied bash', policy.bashDeny.join(', ') || 'none'],
      ['Strict (no bash with protected paths)', policy.strict ? 'yes' : 'no'],
    ]
    for (const l of table(rows)) ui.out(`  ${l}`)
    for (const w of project.policyWarnings) ui.out(ui.yellow(`  warning: ${w}`))
    ui.out()
    ui.out(ui.bold('Models'))
    if (verdicts.length === 0) ui.out('  (no models with credentials; run `sidebet doctor`)')
    for (const v of verdicts)
      ui.out(
        `  ${v.decision.allowed ? ui.green('✓') : ui.red('✗')} ${modelRef(v.model)}${v.decision.allowed ? '' : ui.dim(`  ${v.decision.reason}`)}`,
      )
    ui.out()
    ui.out(ui.bold('What is enforced, and how'))
    for (const r of describeEnforcement(policy)) {
      const tag =
        r.status === 'enforced'
          ? ui.green('enforced   ')
          : r.status === 'partial'
            ? ui.yellow('partial    ')
            : ui.red('unsupported')
      ui.out(`  ${tag} ${r.control}`)
      ui.out(`             ${ui.dim(r.how)}`)
    }
    void isProtectedPath
    const eligible = verdicts.filter((v) => v.decision.allowed).length
    return info && eligible === 0 ? 1 : 0
  } finally {
    app.close()
  }
}
