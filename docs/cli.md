# CLI reference

Global options (anywhere on the line): `--json` machine-readable output, `-v/--verbose` structured debug logs on stderr, `--no-color` (also `NO_COLOR`), `--cwd <dir>`, `-h/--help`, `--version`.

Exit codes: `0` success, `1` failure (error, or no attempt completed), `2` usage error, `130` interrupted.

Progress and tool activity go to **stderr**; summaries and `--json` go to **stdout**. Ctrl+C aborts agents, captures partial work, removes worktrees, and records the run as `cancelled`. A second Ctrl+C force-quits.

Run ids look like `run_1a2b3c4d`; any unique prefix works.

## init
`sidebet init [--force] [--json]`. Detects Git, name, language, package manager, test command, `AGENTS.md`, Sidebet rules, Pi models and skills. Writes `.sidebet/config.json` only if it does not exist (`--force` is explicit approval to refresh detected values; the project id is kept).

## doctor
`sidebet doctor [--json]`. Node, Git, config validity, storage and FTS5, Pi version and config dir, model count per provider, policy conflicts, leftover worktrees. Non-zero exit on blocking problems.

## models
`sidebet models [--json]`. Models Pi has credentials for (including OAuth/subscription logins), aliases, default, and policy eligibility.

## run
`sidebet run "<task>" [options]`

| Option | Meaning |
|---|---|
| `-m, --model <m>` | One model: `provider/id`, bare id, unique substring, or alias |
| `--models a,b` | Two or more: dual output (runs a compare) |
| `--dual` / `--single` | Force dual output / force a single model, overriding `run.dual` |
| `--readonly` | Only `read, grep, find, ls` are exposed; write tools are blocked; the tree is verified unchanged |
| `--dry-run` | Print model, tools, context sources and budget, policy decisions; call nothing, save nothing |
| `--test` | Run `tests.command` afterwards |
| `--context <file>` | Extra file for this task only (repeatable; still policy-checked) |
| `--timeout <sec>` | Per-run timeout |

## compare
`sidebet compare "<task>" [--models a,b] [--concurrency n] [--timeout sec] [--keep-worktrees] [--readonly] [--dry-run] [--context file]`. Default models: Pi's default plus the first eligible model from another provider; set `models.compare` to choose.

While running, a live gauge per attempt is redrawn on stderr (TTY): elapsed time, turns, tool calls (and blocked calls), tokens with in/out split, cost as reported so far, time of first edit, and the current tool. Off a TTY the gauge degrades to one usage line per model turn, so CI logs still show progress.

Afterwards (and in `review` and `runs show`) a metrics table compares attempts column by column: status, total and agent time, time to first token, time to first edit, turns, tool calls by tool, tool errors/blocked, input/output/cache tokens, output speed, cost, files changed, lines +/-, tests and test time. `◂` marks the better value for that one metric; nothing is combined into a score, and cost is only ever what the runtime reported. Uncommitted changes are included via a snapshot commit (or stop the run if `compare.uncommitted` is `refuse`). Nothing is merged automatically.

## review
`sidebet review [run-id]` (default: latest compare run). On a terminal it opens an interactive menu: view each diff, compare changes, select preferred, record review, apply, check out an attempt. Non-interactive flags:

`--diff A`, `--compare` (diff between attempt results), `--select A [--accept|--reject] [--reason ".."] [--notes ".."]`, `--apply A [--yes] [--allow-incomplete]`, `--checkout A`, `--json`.

Apply: previews the files (`M*` marks files you also edited), requires confirmation, refuses on conflicts without changing anything, saves a backup ref of your working tree, applies to the working tree only (no commit, index untouched), and keeps the attempt at `refs/sidebet/runs/<run>/<label>`.

## runs / rerun
`sidebet runs [--limit n] [--status s] [--json]`, `runs show <id>`, `runs diff <id> [A]`.
`sidebet rerun <id> [--original-context | --current-context] [--models a,b] [--readonly] [--dry-run]`. Default is the original snapshot (AGENTS.md is replayed from the snapshot, not disk). Output states what changed since: HEAD, policy, config.

## odds
`sidebet odds [--category c] [--by-category] [--json]`. Per model: runs, test pass (objective), preferred (human), accepted, median time, median cost with n. Head-to-head only over runs both models attempted.

## context
`sidebet context [--task "..."] [--context file]` shows what would be sent now. `sidebet context inspect [run-id] [--item <source>] [--full]` shows the stored snapshot: each item's delivery (`injected` / `native` / `omitted`), tokens, and the reason. Stored content is already secret-redacted.

## memory
`memory add <text> [--global] [--tag a,b]`, `memory list [--global|--project]`, `memory search <query>`, `memory remove <id>`, `memory suggest <run-id> [--accept 1,2|all]`. Suggestions are heuristic, shown for review, and never saved without confirmation.

## policy
`sidebet policy check` prints the effective policy, eligible models, and an enforcement matrix. Targeted: `--model <m>`, `--tool <t> --path <p>`, `--command "<cmd>"` (exit 1 if denied).

## clean
`sidebet clean` removes leftover Sidebet worktrees for this project. Results stay in `refs/sidebet/`.

## Environment
`SIDEBET_HOME` data dir (default `~/.sidebet`), `NO_COLOR`, `PI_CODING_AGENT_DIR` (Pi's), `SIDEBET_RUNTIME=fake` + `SIDEBET_FAKE_SCRIPT=<json>` for an offline fake runtime (testing/demos only).
