# Configuration reference

Files, merged in this order (later wins, objects merge key by key, arrays replace):

1. `~/.sidebet/config.json` (global; `SIDEBET_HOME` overrides the directory)
2. `<repo>/.sidebet/config.json` (project; commit it)

Everything is optional. Invalid config fails early, naming the file and field. `sidebet init` writes only `version`, `projectId`, `name`, and a detected `tests.command`.

```jsonc
{
  "version": 1,
  "projectId": "prj_1a2b3c4d",          // stable id; written by init
  "name": "credits-api",
  "runtime": "pi",
  "models": {
    "default": "anthropic/claude-sonnet-4-5",   // else Pi's default, else first eligible
    "compare": ["fast", "openai/gpt-5"],        // default pair for compare / dual
    "aliases": { "fast": "anthropic/claude-haiku-4-5" }
  },
  "tests": { "command": "pnpm test", "timeoutSec": 600 },
  "context": {
    "budgetTokens": 12000,        // injected by Sidebet; native files are reported separately
    "perItemTokens": 3000,
    "docs": ["ARCHITECTURE.md", "docs/ARCHITECTURE.md", "CONTRIBUTING.md"],   // included if they exist
    "memoryLimit": 8,
    "memoryIncludeAllBelow": 5    // at or below this many memories, include all instead of searching
  },
  "compare": {
    "concurrency": 4, "timeoutSec": 900,
    "uncommitted": "snapshot",    // or "refuse"
    "linkPaths": ["node_modules"],// symlinked into each worktree, excluded from diffs
    "setup": "pnpm install --offline --frozen-lockfile",   // optional, run in each worktree first (non-interactive: CI=1)
    "keepWorktrees": false
  },
  "run": { "timeoutSec": 1800, "runTests": false, "dual": false },
  "policy": { /* see below */ }
}
```

### Worktree dependencies

By default each compare worktree gets a symlink to your `node_modules` (`compare.linkPaths`), which is enough for npm and yarn projects. For a **pnpm workspace** that is not enough, because every package has its own `node_modules`; `sidebet init` detects this and writes `linkPaths: []` with `setup: "pnpm install --offline --frozen-lockfile"` (a few seconds from pnpm's local store). Setup runs with `CI=1`, its output is stored as the attempt's `setup.log`, and a non-zero exit fails the attempt before any model is called.

## Policy

| Field | Meaning |
|---|---|
| `allowedProviders` | Only these providers may run |
| `allowedModels` | `provider/model` patterns with `*` |
| `deniedModels` | Patterns that are always refused |
| `protectedPaths` | Gitignore-style globs; `!pattern` re-allows; last match wins. Default covers `.env*` (not examples), `*.pem`, `*.key`, `id_rsa*`, `.git/**` |
| `readonly` | Force read-only for every run |
| `tools.allow` / `tools.deny` | Tool name allow/deny lists |
| `approvalRequired.bash` | Regexes needing human approval (defaults: `rm -rf`, `git push`, `git reset --hard`, `git clean`, `sudo`, `curl \| sh`). Without an interactive terminal they are denied. Compare never prompts |
| `approvalRequired.tools` | Tool names needing approval |
| `bashDeny` | Regexes that are always denied |
| `strict` | With protected paths, remove `bash` entirely |

Layering: the global policy is a floor. A project can add restrictions (denies, protected paths, approvals, readonly, strict) but cannot widen or replace a global `allowedProviders`, `allowedModels`, or `tools.allow`; a warning is shown. `sidebet policy check` shows the result and the policy version hash recorded on every run.

## Rules and memory

`~/.sidebet/rules/*.md` (global) and `.sidebet/rules/*.md` (project) are injected in filename order. Memory lives in SQLite, not in files. Rules always take precedence over memory.
