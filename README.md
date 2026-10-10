# Sidebet

**Same context. Different models. Better decisions.**

Sidebet is an open-source developer harness built on [Pi](https://github.com/badlogic/pi-mono). It keeps your rules, memory, and tooling consistent across AI coding sessions while making it easy to run different models against the same task, compare their results, and learn which models work best for your projects.

Sidebet is not another coding agent. Pi runs the agent; Sidebet owns everything around it: context, memory, policy, isolation, review, and history. Everything is local-first. No account, no cloud.

## Quick start

```bash
sidebet init
sidebet run "Fix the failing tests"
sidebet compare "Refactor the search handler"
sidebet review
sidebet odds
```

`sidebet init` reuses your existing Pi login and `AGENTS.md`; there is nothing to re-enter. If Pi works on your machine, Sidebet works.

### Install (from source)

Requires Node 22.13+ (24 recommended), pnpm, Git, and a working [Pi](https://github.com/badlogic/pi-mono) login.

```bash
git clone <this repo> sidebet && cd sidebet
pnpm install
pnpm build
cd apps/cli && pnpm link --global   # puts `sidebet` on your PATH
sidebet doctor
```

Optional Pi extension (adds `/sidebet`, `/sidebet-context`, `/sidebet-memory`, `/sidebet-compare` inside Pi):

```bash
pi install ./extensions/pi
```

## What you get

| | |
|---|---|
| `sidebet init` | Detects git, package manager, tests, `AGENTS.md`, Pi models, skills. Writes a minimal `.sidebet/config.json`. Idempotent. |
| `sidebet run "<task>"` | One Pi-backed task with your rules and memory injected, tool activity streamed, usage and changes recorded. `--readonly` really removes write tools. `--dry-run` shows the exact plan. |
| `sidebet compare "<task>"` | Same task, several models, each in its own Git worktree, concurrently, with a live per-model gauge (elapsed, turns, tool calls, tokens, cost, current activity). Your working tree is never touched. Tests run per attempt. |
| `sidebet run --models a,b` / `run.dual` | Dual output: a plain `run` automatically runs two models side by side. |
| `sidebet models` | The models you are logged into in Pi, their aliases, and whether policy allows them. |
| `sidebet review` | Side-by-side metrics (time, time to first edit, turns, tool calls, tokens, cost, lines changed, tests), diffs, a recorded verdict, and a safe, confirmed, undoable apply. |
| `sidebet runs`, `rerun` | Full history; rerun with the **original** or **current** context, stated explicitly. |
| `sidebet odds` | Your own evidence about which model works for you. Sample sizes always shown. Tests and preference never blended. |
| `sidebet context`, `memory` | See exactly what the agent receives; persistent project/global memory with FTS5 search. |
| `sidebet policy check`, `doctor` | Why a model or tool was denied; what is truly enforced and what is not. |

Using named models you are logged into in Pi:

```bash
sidebet models                                   # what is available to you
sidebet compare "Refactor auth" --models anthropic/claude-sonnet-4-5,openai/gpt-5
sidebet run "Explain the auth flow" --models fast,deep --readonly   # dual answers; aliases from config
```

Set `models.compare`, `models.aliases`, and `run.dual: true` in `.sidebet/config.json` to make two-model output the default. See [`examples/configs/dual-models.json`](examples/configs/dual-models.json).

## How it fits together

```
                       ┌────────────────────── sidebet CLI ──────────────────────┐
                       │  init  run  compare  review  runs  rerun  odds  ...     │
                       └───────────────┬─────────────────────────┬────────────────┘
                                       │                         │
                       ┌───────────────▼───────────────┐  ┌──────▼────────────────┐
                       │          @sidebet/core        │  │ @sidebet/storage-local │
                       │ config · context · memory     │  │ SQLite + FTS5          │
                       │ policy · routing · runs       │◄─┤ (implements Storage)   │
                       │ comparison (git) · evaluation │  └───────────────────────┘
                       │ AgentRuntime interface        │
                       └───────────────┬───────────────┘
                                       │ AgentRuntime
                       ┌───────────────▼───────────────┐        ┌──────────────────┐
                       │       @sidebet/runtime-pi     │        │ extensions/pi     │
                       │ Pi SDK sessions, tool hooks,  │        │ thin Pi commands  │
                       │ usage, abort                  │        │ shelling to CLI   │
                       └───────────────┬───────────────┘        └──────────────────┘
                                       │
                                 Pi (unmodified)  ──►  your providers & credentials
```

Sidebet's central record is a `SidebetRun` with one or more `SidebetAttempt`s; it contains no Pi types. Pi is the first runtime behind the `AgentRuntime` interface. See [docs/architecture.md](docs/architecture.md).

## Documentation

- [CLI reference](docs/cli.md)
- [Configuration reference](docs/configuration.md)
- [Pi integration guide](docs/pi-integration.md)
- [Architecture and future cloud boundaries](docs/architecture.md)
- [Security model and limitations](docs/security.md)
- [Roadmap](docs/roadmap.md)
- [Examples](examples/README.md)
- [Contributing](CONTRIBUTING.md)

## Known limitations (read before trusting it)

- **Policy is enforced inside Sidebet-launched Pi sessions only.** A `bash` tool can read anything; protected paths are best-effort for shell commands unless `policy.strict` removes `bash`. See [docs/security.md](docs/security.md).
- `sidebet run` edits your working tree directly (like Pi). Use `compare` for isolation.
- Compare worktrees contain tracked and untracked **non-ignored** files only. Ignored files (`.env`, build output) are absent; `node_modules` is symlinked, and `compare.setup` can run a command per worktree.
- Token counts in context reports are estimates (about 4 characters per token). Usage and cost in run records come from Pi as reported; cost is shown only if Pi reports one (subscription logins often report none).
- A rerun reproduces the inputs, not the outputs.
- Built and tested against Pi 0.73.x. Pi's SDK is pre-1.0; the version is pinned.
- Only macOS and Linux paths were exercised. Windows is untested.
- Requires Node's built-in `node:sqlite`, which Node still labels experimental.
- No paid model calls are made by the automated tests; the Pi adapter is tested against Pi's real SDK using its faux provider. A one-call real-provider test is available behind `SIDEBET_INTEGRATION=1`.

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
