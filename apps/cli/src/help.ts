export const VERSION = '0.1.0'

export const HELP = `Sidebet ${VERSION}

Usage: sidebet <command> [options]

Getting started
  init                         Detect repo, rules, Pi config, models; write minimal config
  doctor                       Diagnose Node, Git, storage, Pi, models, worktrees
  models                       List models you are logged into in Pi (with aliases, eligibility)

Do work
  run "<task>"                 Run a task with Pi using your rules and memory
      -m, --model <m>          Model: provider/id, id, unique substring, or alias
      --models a,b             Two or more models: dual output (runs a compare)
      --dual / --single        Force dual output (or one model) regardless of config
      --readonly               Remove write tools; verified afterwards
      --dry-run                Show plan, context, model, policy; start nothing
      --test                   Run tests.command afterwards
      --context <file>         Add a file for this task only (repeatable)
      --timeout <sec>
  compare "<task>"             Same task, several models, isolated Git worktrees
      --models a,b             Default: two eligible models
      --concurrency <n>  --timeout <sec>  --keep-worktrees  --dry-run  --readonly
  review [run-id]              Inspect, select, record, and safely apply a result
      --diff A | --compare | --select A [--accept|--reject] [--reason ..] [--notes ..]
      --apply A [--yes] [--allow-incomplete] | --checkout A
  runs [list|show <id>|diff <id> [A]]   Run history (--limit n, --status s)
  rerun <run-id>               --original-context (default) | --current-context | --models | --dry-run
  odds                         Your own model history (--category c, --by-category)
  bet <A|B>                    Record which result you expect to prefer, before reviewing

Context, memory, policy
  context [--task ".."]        What the agent would receive now
  context inspect [run-id]     Exact stored snapshot (--item <src>, --full)
  memory add|list|search|remove|suggest   (--global, --tag a,b; suggest <run-id> [--accept 1,2])
  policy check                 Effective policy, enforcement matrix (--model m | --tool t --path p | --command c)
  clean                        Remove leftover worktrees

Global options
  --json         Machine-readable output where supported
  --verbose, -v  Structured debug logs on stderr
  --no-color     Also honours NO_COLOR
  --cwd <dir>    Run as if started in <dir>
  --version, -h/--help
`
