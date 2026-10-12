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
- **`compare.linkPaths` are shared, not copied.** A symlinked `node_modules` points into your real repository, so a tool run inside a worktree (an agent's `pnpm install`, `rm -rf node_modules`) changes it for you too. Use an install step (`compare.setup`) instead of linking when the package manager makes that cheap; `sidebet init` does this for pnpm workspaces.
- **No sandbox**: agents run as you. Compare worktrees isolate Git state, not the filesystem or network.
- **Local data**: run records (task text, summaries, diffs, redacted context) are stored unencrypted in `~/.sidebet/sidebet.db`. Diffs may contain whatever the agent wrote.
- Prompts and file contents go to whichever model providers you choose, exactly as with Pi.

## Local web UI

`sidebet ui` is an HTTP server on `127.0.0.1` that can start runs, apply results and edit `.sidebet/config.json`, so it defends against being driven by other websites open in the same browser:

- Every mutation (`POST`, `PUT`, `DELETE`) must carry a random per-process token that only the served page knows. The custom header also forces a CORS preflight, which the server never answers with CORS headers, so a cross-origin script cannot get past it.
- Requests whose `Origin` or `Host` is not the local server are refused (DNS rebinding).
- The page runs under a Content-Security-Policy that allows only its own script and styles, and it never renders model output as HTML.
- Bodies are limited to 1 MB and validated field by field.

Reads carry no token: anyone with the same user account on the machine can read run history, which is the same as reading `~/.sidebet/sidebet.db`. The server runs with your permissions, like the CLI. Use `--readonly` for a viewer with no write endpoints, and do not expose the port beyond the machine (no reverse proxy, no port forwarding): the token travels in clear text on the loopback interface, and the UI has no accounts.

## Upstream advisories

Sidebet depends on Pi (`@earendil-works/pi-coding-agent`). `pnpm audit` is clean at the pinned version; re-run it after upgrading Pi, since Pi's own install and export code paths (which Sidebet does not call) have had advisories in the past.

## Reporting vulnerabilities

Please open a private security advisory on the repository rather than a public issue.
