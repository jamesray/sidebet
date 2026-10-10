# Pi integration

Sidebet does not fork Pi. It uses Pi's public SDK (`@earendil-works/pi-coding-agent`, pinned at 1.1.0).

## What the adapter uses

| Need | Pi API |
|---|---|
| Existing logins, API keys, OAuth | `AuthStorage.create()`, `ModelRegistry.getAvailable()` (the same files and env vars Pi uses; Sidebet never asks for credentials) |
| Default model | Pi `settings.json` via `SettingsManager` |
| Programmatic session | `createAgentSession` with `DefaultResourceLoader` |
| Context injection | `appendSystemPrompt` on the resource loader; `noContextFiles` when Sidebet must take over `AGENTS.md` delivery |
| Policy hooks | an inline extension factory using `pi.on('tool_call')` to block with a reason |
| Tool restriction | `tools: string[]` allow-list; `noExtensions` in read-only mode |
| Progress, usage | `session.subscribe` events (`message_update`, `tool_execution_*`, `message_end` usage and cost) |
| Cancel/timeout | `session.abort()` with a grace period so a provider that ignores abort cannot hang a run |
| Session metadata | `session.setSessionName`, session file path stored on the attempt (resume it with Pi) |
| Skills | Loaded by Pi from the usual directories; Sidebet lists them in the context report |

Sessions started by `sidebet run`/`compare` set `SIDEBET_SESSION=1` in the process so the extension below does not inject context twice.

## The extension

`extensions/pi` is a Pi package (`pi.extensions` in its `package.json`) written in TypeScript. It stays thin: each command shells out to the `sidebet` binary (`SIDEBET_BIN` to override).

```bash
pi install ./extensions/pi        # or: pi -e ./extensions/pi/index.ts
```

| Command | Does |
|---|---|
| `/sidebet [cmd ...]` | Runs a Sidebet command (default `doctor`), e.g. `/sidebet runs`, `/sidebet odds` |
| `/sidebet-context [task]` | Shows the context Sidebet would add |
| `/sidebet-memory add\|list\|search\|remove ...` | Manage memory without leaving Pi |
| `/sidebet-compare [--models a,b] "<task>"` | Runs a compare in isolated worktrees, then points you to `sidebet review` |

It also adds Sidebet rules and relevant memory to plain Pi sessions via `before_agent_start` (disable with `SIDEBET_PI_CONTEXT=0`).

**Not covered in plain Pi sessions:** policy enforcement and run recording. Those apply to sessions Sidebet starts.

## Compatibility

Pi's SDK is pre-1.0. If Pi changes an API the adapter uses, `sidebet doctor` reports the runtime failing to load and the adapter tests (which use Pi's faux provider) fail in CI.
