# Examples

- `search-service/`: a tiny Node project with a passing `node --test` suite and an `AGENTS.md`. Sidebet's end-to-end tests copy it into a temporary Git repository; you can do the same to try the CLI:

  ```bash
  cp -R examples/search-service /tmp/search-service && cd /tmp/search-service
  git init -b main && git add -A && git commit -m init
  sidebet init
  sidebet run "Make search case-insensitive" --dry-run
  ```

- `configs/dual-models.json`: aliases for models you are logged into in Pi, a default compare pair, and `run.dual` so a plain `sidebet run` shows two models side by side. Copy to `.sidebet/config.json`.
- `configs/strict-policy.json`: provider allow-list, protected paths, approval-required commands, and `strict` (no `bash`). Copy to `.sidebet/config.json` or `~/.sidebet/config.json`.
- `configs/rules/api.md`: a rule file. Put files like this in `.sidebet/rules/` (project) or `~/.sidebet/rules/` (global).

Try the whole flow offline, with no model calls, using the built-in fake runtime:

```bash
SIDEBET_RUNTIME=fake sidebet compare "demo task"
```
