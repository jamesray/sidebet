# Security model and limitations

Sidebet separates **instructions to a model** from **enforcement**. Instructions can be ignored by a model; enforcement happens in code before an action occurs.

## Enforced

- **Model/provider policy**: checked before a session starts; denied models are never contacted.
- **Read-only**: write-capable tools (`write`, `edit`, `bash`) are not exposed, a `tool_call` hook blocks them anyway, user extensions are not loaded, and the working tree is compared before/after (recorded as an evaluation).
- **Tool allow/deny lists**.
- **Approval-required operations**: matching `bash` commands pause for a human on an interactive terminal; otherwise they are **denied**. Compare runs have no human, so they are denied.
- **Protected paths for file tools** (`read`, `write`, `edit`, `grep`, `find`, `ls`), and protected files are never placed in Sidebet context.
- **Secret redaction**: well-known secret shapes (private keys, AWS, GitHub, Anthropic/OpenAI, Slack tokens, `KEY=value` assignments) are redacted from injected context and from stored snapshots. If `AGENTS.md` contains one, Sidebet stops Pi from loading it natively and injects the redacted copy.
- **Fail closed**: if the policy hook cannot be loaded in Pi, the attempt does not run.

## Not enforced (be aware)

- **Bash can read anything.** A shell can `cat` a protected file through a script or an indirect path. Sidebet blocks commands that literally name a protected path (best effort) and, with `policy.strict`, removes `bash`. Use read-only mode for untrusted tasks.
- **Pi extensions and skills run with your permissions.** Their own code is outside Sidebet policy except in read-only mode, where user extensions are not loaded.
- **Parent-directory `AGENTS.md`** files that Pi discovers above the repo root are not inspected by Sidebet.
- **Redaction is pattern-based**; novel secret formats will not be caught. Do not put secrets in rules or memory.
- **Direct Pi sessions** (outside `sidebet run/compare`) get Sidebet context via the extension but no policy enforcement.
- **No sandbox**: agents run as you. Compare worktrees isolate Git state, not the filesystem or network.
- **Local data**: run records (task text, summaries, diffs, redacted context) are stored unencrypted in `~/.sidebet/sidebet.db`. Diffs may contain whatever the agent wrote.
- Prompts and file contents go to whichever model providers you choose, exactly as with Pi.

## Upstream advisories

`pnpm audit` reports advisories in Pi and its dependencies that have no patched release yet. None of the affected code paths run inside Sidebet, but they are in the dependency tree:

| Advisory | Where | Why Sidebet is not exposed |
|---|---|---|
| Pi: predictable temp extension install paths | `pi install` / `pi -e` | Sidebet never installs Pi packages |
| Pi: race in `auth.json` writes | Pi's login flow | Sidebet only reads credentials, through Pi's own `AuthStorage` |
| Pi: XSS in HTML session export | `/export` in Pi's TUI | Sidebet never exports sessions to HTML |
| `extract-zip` symlink traversal | Pi package installs | Not called by Sidebet |

`basic-ftp` (reachable through `proxy-agent`) is pinned to a fixed version with a pnpm override. Re-check with `pnpm audit` after upgrading Pi.

## Reporting vulnerabilities

Please open a private security advisory on the repository rather than a public issue.
