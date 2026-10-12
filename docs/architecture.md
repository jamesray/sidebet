# Architecture

## Principles

Sidebet owns the environment around a coding agent (context, rules, memory, skills, permissions, isolation, evaluation, history). It does not implement an agent, an inference layer, or an editor. Pi is the first runtime behind a small interface.

## Packages

| Package | Responsibility | Depends on |
|---|---|---|
| `@sidebet/core` | Domain schemas, config, context assembly, memory logic, policy, routing, run planning/execution, worktree comparison, apply, odds | `zod` only |
| `@sidebet/storage-local` | `Storage` over SQLite with FTS5 | core |
| `@sidebet/runtime-pi` | `AgentRuntime` over the Pi SDK | core, Pi |
| `@sidebet/cli` | Parsing and presentation; lazy-loads the runtime and storage. Terminal UI on `@earendil-works/pi-tui`; `sidebet ui` serves a static page from `apps/cli/web` over a JSON API (`apps/cli/src/server`) that calls the same core functions as the commands, with token-gated mutations on 127.0.0.1 | all |
| `extensions/pi` | Pi commands that call the CLI | Pi types only |

Dependency direction is strictly downward. `core` never imports a runtime or storage implementation, which is what makes a second runtime or a remote store possible.

## Domain model

```
SidebetRun ──┬── ContextSnapshot  (rendered prompt + per-item provenance, redacted)
             ├── PolicyRecord     (versioned by content hash)
             ├── SidebetAttempt * ─┬── UsageMetrics     (tokens; cost only if reported)
             │                     │   (+ timing: agent time, first token, first edit; tool counts)
             │                     ├── ToolEvent *      (allowed / approved / denied)
             │                     ├── Artifact *       (diff)
             │                     ├── TestResult *
             │                     └── Evaluation *     (tests, read-only check)
             ├── HumanReview *      (preferred attempt, accepted, reason, notes)
             └── Application *      (apply event + backup ref)
```

Every record is a zod-validated JSON document with `id` (prefix + 8 hex) and `schemaVersion`. `RecordStore` persists them generically; SQLite keeps `kind`, `id`, and the foreign keys needed for queries beside the JSON. A future sync layer can ship these documents unchanged.

## Run lifecycle

1. **Plan** (`planExecution`): resolve project and policy, pick models (policy-checked), assemble or replay a context snapshot, decide tools, tests, timeouts. `--dry-run` prints this and stops.
2. **Persist** policy record, snapshot, and run.
3. **Execute**: `run` snapshots the working tree before/after with a private temporary Git index (the change set is exactly what the agent did). `compare` creates a base commit (HEAD, or a synthetic snapshot commit if the tree is dirty), a worktree per attempt, runs attempts through a concurrency pool, then commits each result tree under `refs/sidebet/runs/<run>/<label>`.
4. **Capture**: diff, changed files, tests, usage, tool events, evaluations, even for failed/cancelled attempts.
5. **Clean up**: worktrees removed unless `--keep-worktrees`; refs preserve results.

## Context

Sources in precedence order (higher wins and appears earlier in the prompt): `AGENTS.md` (100, native), project rules (90), global `AGENTS.md` (80, native), global rules (70), `--context` files (60), docs (50), skills (40, native), memory (30, advisory). "Native" means Pi loads it itself, so Sidebet lists it for transparency but does not repeat it. If policy or secret scanning prevents native loading, Sidebet disables Pi's context-file loading and injects a redacted copy instead. A budget drops lowest-priority items first and records why.

## Policy enforcement

Model/provider checks run before any session starts. Inside a session, an inline Pi extension hooks `tool_call` and can block it; read-only mode additionally restricts the tool allow-list and skips user extensions. If the hook fails to load, the attempt fails closed. See [security.md](security.md).

## Storage and files

`~/.sidebet/` (override with `SIDEBET_HOME`): `sidebet.db`, `config.json` (global), `rules/` (global rules), `worktrees/<project>/` (temporary). Repo-side: `.sidebet/config.json`, `.sidebet/rules/*.md`. Git refs under `refs/sidebet/` hold bases, results, and backups.

## Future cloud boundaries (not implemented)

Reserved, not built: `apps/web`, `apps/docs`, `apps/console`, `apps/api`, `apps/worker`, `packages/sdk`, `packages/protocol`, `packages/ui`.

- **protocol**: the zod schemas in `core/domain` are the seed of a versioned wire contract; extract them when a server needs them.
- **Sync**: implement `Storage` remotely or add an outbox beside `RecordStore`; records are already self-contained and idempotent by id.
- **Teams**: memory has `scope` (global/project); a `team` scope adds a third layer without changing assembly.
- **Policy sync**: policy is already merged from layers with a "global is a floor" rule; an org layer slots in above global.
- **Remote execution**: `AgentRuntime.execute` takes a working directory and returns an outcome; a remote runner is another implementation.
- **Other runtimes**: add `packages/runtime-<name>`; nothing in core names Pi.
