# Contributing

Thanks for helping. Sidebet is a TypeScript monorepo (pnpm workspaces + Turborepo).

## Setup

```bash
pnpm install
pnpm build        # turbo builds all packages
pnpm lint         # biome
pnpm typecheck
pnpm test         # builds, then runs vitest (no paid model calls)
```

Requires Node 22.19+, pnpm 10, and Git. You do not need Pi credentials to run the tests.

## Layout

- `packages/core`: domain, config, context, memory logic, policy, routing, runs, comparison, evaluation. **No runtime or storage dependencies.**
- `packages/storage-local`: SQLite (`node:sqlite`, FTS5) implementation of `Storage`.
- `packages/runtime-pi`: the Pi adapter (`AgentRuntime`).
- `extensions/pi`: thin Pi extension; logic belongs in the CLI/core, not here.
- `apps/cli`: argument parsing and presentation only.
- `tests/`: cross-package tests against real temporary Git repositories.

## Style

TypeScript strict, ESM, no semicolons, named exports, no `any`, small modules, explicit errors (`SidebetError` with a hint for user-facing failures). `pnpm exec biome check --write .` formats.

## Rules of the road

- Keep domain logic out of the CLI. If a command needs a decision, it belongs in `core` with a test.
- Persisted records are versioned zod schemas in `core/src/domain/schemas.ts`. Changing a shape means bumping `SCHEMA_VERSION` and writing a migration.
- Never claim a metric you did not measure. Absent data stays absent (see cost and test counts).
- Anything touching the user's repository must be reversible or non-destructive, and have a test that checks the original tree.
- Tests must not call paid models. Use `FakeRuntime` (`@sidebet/core/testing`) or Pi's faux provider.
- Please open an issue before large changes, particularly anything that looks like cloud sync, accounts, or a new runtime.
