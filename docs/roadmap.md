# Roadmap

Only what exists in this repository is described elsewhere in the docs. This page is intent, not a promise.

**Next (v1.x)**
- Smarter default compare pairs (prefer models with history in `sidebet odds`; today it is Pi's default plus the first eligible model from another provider).
- Per-attempt `.env` handling for worktrees (opt-in copy list) so more test suites run unmodified.
- Policy enforcement in plain Pi sessions through the extension.
- Windows support.
- Stronger memory suggestions, still human-approved.
- `sidebet export` / `import` of run records.

**Later**
- A second runtime package (e.g. another CLI agent) behind `AgentRuntime`.
- `packages/protocol` and `packages/sdk`: versioned wire contracts extracted from `core/domain`.
- Sidebet Cloud: optional sync of runs, shared memory, org policy layer, hosted evaluation history, `apps/console`, `apps/api`, `apps/worker`.
- Docs site (`apps/docs`). The marketing site lives in `apps/web`.

**Non-goals for now:** accounts, cloud sync, a vector store, a plugin marketplace, automatic memory promotion, automatic merging.
