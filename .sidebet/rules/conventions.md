# Sidebet code conventions

- TypeScript strict, ESM, no semicolons, single quotes, named exports, no `any`, no non-null assertions.
- Small composable modules. Domain logic lives in `packages/core`; the CLI only parses and presents.
- Explicit errors: throw `SidebetError(message, hint)` for anything a user will see.
- Never claim a metric that was not measured; absent data stays absent.
- Anything that touches the user's repository must be reversible and have a test that checks the original tree.
- Tests use vitest and must not call paid models: use `FakeRuntime` from `@sidebet/core/testing` or Pi's faux provider.
- Run `pnpm lint && pnpm typecheck && pnpm test` before declaring a change done. Formatting is `pnpm exec biome check --write .`.
