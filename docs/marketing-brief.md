# Sidebet: brief for the marketing website

You are building the marketing website for Sidebet. This document is the product truth you work from. It was written by the engineer who built v1, from the code as it exists today. Everything in here is verifiable in the repository at https://github.com/jamesray/sidebet; where something is *not* true yet, this document says so, and the site must not claim it.

Read the whole thing before writing copy. When in doubt, understate.

Where the site lives: `apps/web/` in this repository (reserved for it from the start). The rest of the monorepo uses Biome for formatting and linting; `apps/web` is excluded from that, so the site keeps its own tooling and nobody else's formatter touches its files. Keep the site self-contained in `apps/web` and do not import from the other packages.

## 1. What Sidebet is, in three sentences

Sidebet is an open-source developer harness that sits around an AI coding agent. It keeps a developer's rules, memory and policies consistent across every AI coding session, and it runs the same task on different models side by side, in isolated Git worktrees, so the developer can compare real diffs, real test results and real token costs before keeping one. Over time it turns the developer's own history into evidence about which model works for their projects.

Tagline (fixed, use verbatim): **Same context. Different models. Better decisions.**

One-line description for meta tags and listings: *Sidebet is an open-source developer harness built on Pi. It keeps your rules, memory, and tooling consistent across AI coding sessions while making it easy to run different models against the same task, compare their results, and learn which models work best for your projects.*

## 2. What Sidebet is not

Say this plainly on the site; it is a strength, not an apology.

- Not another coding agent. Pi (https://github.com/earendil-works/pi) is the agent. Sidebet never forks Pi; it uses Pi's public SDK and reads the credentials Pi already has.
- Not a model, a proxy, or an inference layer. Prompts go to the providers the developer already logged into through Pi, exactly as they would from Pi.
- Not a chat app or an IDE.
- Not a cloud service (yet). The complete v1 runs locally with no account. See section 9 before writing anything about "Sidebet Cloud".
- Not a benchmark. Sidebet reports what happened on *your* tasks, in *your* repo, with *your* tests. It never publishes leaderboards or claims one model is "best".

## 3. Who it is for

Primary: individual developers who use an AI coding agent daily and have felt two specific pains:

1. Re-explaining the same project conventions every session ("we use camelCase in API responses", "migrations need review", "that test suite is slow").
2. Not knowing whether a different model would have done the job better, cheaper or faster, because trying it means redoing the task by hand and juggling branches.

Today's install base is developers who already use Pi. The site can assume Pi familiarity in the "how it works" section but the hero must make sense to someone who has only used one agent (Claude Code, Codex CLI, Cursor, etc.).

Secondary, later: teams and tech leads who want shared rules, shared memory and policy across a team. That is the future cloud product (section 9). Do not sell it as available.

## 4. The core workflow (this is the demo the site should tell)

Every claim here is implemented and tested.

```
sidebet init                      # detects git, package manager, tests, AGENTS.md, Pi models and skills; writes one small file
sidebet run "Fix the failing tests"
sidebet compare "Refactor the search handler"
sidebet review
sidebet odds
sidebet ui
```

1. **Init in seconds.** `sidebet init` inspects an existing repository and reports what it found: project name, language, package manager, test command, an existing `AGENTS.md`, how many models Pi has credentials for, skills. It writes exactly one file, `.sidebet/config.json`, never overwrites, and is idempotent. There is nothing to re-enter: credentials stay in Pi.

2. **Run with context that follows you.** `sidebet run "<task>"` starts a Pi-backed session with the developer's rules (`AGENTS.md`, `.sidebet/rules/*.md`) and relevant persistent memory injected, streams the agent's work, records tool calls, usage and the exact change set, and prints a summary. `--readonly` removes write tools for real (enforced in code, verified afterwards), `--dry-run` shows the whole plan without calling a model. Memory lives in SQLite with full-text search; it never overrides explicit rules.

3. **Compare, safely.** `sidebet compare "<task>"` runs the same task on two (or more) models concurrently, each in its own Git worktree created from a snapshot of the working tree. The developer's files are never touched. Each attempt gets the test suite run against it. A live dashboard shows, per model: status, elapsed time, time to first edit, turns, tool calls (and blocked calls), tokens, and cost as reported so far.

4. **Review with real metrics, then apply.** `sidebet review` shows both implementations side by side: files changed, lines added and removed, tests, total and agent time, time to first token and first edit, turns, tool calls by tool, input/output/cache tokens, output speed, cost. A `◂` marks the better value for each single metric; nothing is combined into a score. Diffs open in a full-screen viewer. The developer records which they prefer and why, then applies the chosen result to their working tree: the preview lists affected files, warns about local edits, refuses on conflict, saves a recoverable backup ref first, and prints the undo command. Nothing is auto-merged, ever.

5. **Learn from your own history.** `sidebet odds` summarises, per model: runs, test pass rate (objective), how often the developer preferred it (human), acceptance rate, median time, tokens and cost, with sample sizes always shown and a head-to-head table that only uses runs where both models attempted the same task. `sidebet bet A` lets the developer record a prediction before reviewing; `odds` reports how often their calls matched their later preference. This is explicitly a measure of the developer's judgement, not of the models.

6. **See everything in a browser.** `sidebet ui` serves a local, read-only web view: every run, attempts side by side, metrics, per-file diffs, tool calls, test output, the exact context the model received, odds and memory. It binds to 127.0.0.1, has no write endpoints, and adds no dependencies.

Also implemented: `sidebet runs` (history), `sidebet rerun <id>` (with an explicit choice between the original context snapshot and the current context, and an honest note that outputs are not reproducible), `sidebet context` / `context inspect` (what the model would get, and why each item was included, omitted or budgeted out), `sidebet memory add|list|search|remove|suggest`, `sidebet policy check` (effective policy and an enforcement matrix that says what is enforced, partial, or unsupported), `sidebet doctor`, `sidebet models`.

## 5. Why it is different (the arguments the site should make)

Use these; each is true today.

- **Comparison without risk.** Isolated worktrees from a snapshot of the working tree, including uncommitted changes; the original tree is byte-identical afterwards (tested). Failed, timed-out and cancelled attempts keep their partial work and their numbers.
- **Evidence, not vibes.** Every number on screen was measured in that run. Cost is shown only when the runtime reported it; subscription logins often report none, and Sidebet says "not reported" rather than estimating. Token counts in context reports are labelled as estimates.
- **Transparency of context.** The developer can see, for any past run, exactly which rule, document or memory the model received, how many tokens it cost, and why anything was left out. Secrets are redacted before anything is stored or sent.
- **Policy that is enforced, not requested.** Read-only mode, tool allow/deny lists, protected file patterns and approval-required commands are enforced by a hook inside Pi that blocks the tool call; a denied call never executes. The site may say "enforced in code, not in the prompt". It must not say "sandboxed" or "secure": a shell can still read files, and `sidebet policy check` prints a matrix that is honest about this (enforced / partial / unsupported).
- **Nothing to re-enter.** Credentials, default model, skills and `AGENTS.md` come from Pi. Models available through Pi's logins (Anthropic, OpenAI, GitHub Copilot, xAI, Kimi and others, including subscription OAuth logins) are available to Sidebet.
- **Local-first and open.** Apache-2.0. SQLite on disk. No account, no telemetry, no cloud.
- **Built on Pi's own terminal toolkit**, so it looks and feels like Pi: a compact two-line header with the Sidebet chip, a live dashboard, menu-driven review, a full-screen diff viewer with Pi's own diff rendering.

## 6. Voice and visual direction

The product's voice is calm, specific and understated. The terminal UI was deliberately made "clean, not fun, but beautiful". The website should match.

- No gambling jokes, no casino imagery beyond the chip, no "place your bets" copy, no slot machines, no dice. The name is a metaphor for hedging a decision, not a theme.
- Short sentences. Concrete nouns. Numbers only when they are real.
- Never "AI picks the best model for you". Sidebet never picks; the developer does, with evidence.
- Never "benchmark", "leaderboard", "probability", "win rate" as a product claim. "Odds" is the feature's name; describe it as *your own history*.
- Never "10x", "revolutionary", "the future of".
- Prefer "model" to "AI". Prefer "compare" to "battle"/"race"/"duel".

Brand elements:
- **The chip.** Pixel art: a poker chip drawn on a 32-pixel grid with a 1-pixel outline, two-tone shading, eight edge notches, a stamped inner ring and a shaded centre with a highlight arc. It is the same object as the terminal glyph, generated from one piece of code (`apps/cli/src/style/chip.ts`). Six palettes ship as SVGs in `docs/assets/`: `chip-red.svg` (the default and the mark to use), plus blue, green, violet, black and white. Users can pick one or `random` in their config, so the site may show the set, but the brand mark is red. Render SVGs with `image-rendering: pixelated` so browsers do not blur them; they scale cleanly from 24 px to 256 px. Do not redraw the chip by hand; regenerate with `pnpm chips`. In the terminal it is a two-row half-block glyph (`▗▟▀▙▖` / `▝▜▄▛▘`). Use the SVG as the mark; use the glyph only inside terminal screenshots.
- **Colours** (OKLCH, dark theme values): accent violet `oklch(0.78 0.16 300)`; chip red `oklch(0.72 0.19 25)`; gold `oklch(0.86 0.15 90)`; model lanes A cyan `oklch(0.80 0.14 215)` and B pink `oklch(0.80 0.17 340)`; success green `oklch(0.80 0.17 150)`; backgrounds near-black `#0f0f12` / panels `#17171c`. Light theme: accent `oklch(0.50 0.20 300)`, backgrounds `#f6f5f2` / `#ffffff`. The web UI in the repo (`apps/cli/web/index.html`) is the reference implementation of the palette in CSS.
- **Type.** System font stack for UI, monospace for everything that came from a terminal. No display fonts.
- **Lanes.** Model A is always cyan, model B always pink, everywhere (CLI, web UI). Keep that on the site.

## 7. Real output to use (do not fabricate screenshots)

Use these verbatim or re-run them; they are what the product prints. Replace model names with ones that exist if you re-run.

`sidebet init`:
```
Sidebet initialized

Project      search-service
Runtime      Pi 1.1.0
Language     JavaScript
Package mgr  npm
Rules        AGENTS.md detected
Models       87 available (default anthropic/claude-opus-4-8)
Tests        npm test

Wrote .sidebet/config.json (commit it to share the project id)

You're ready.

  sidebet run "Explain this repository"
  sidebet compare "Improve the search handler"
```

Compare dashboard (one card per model, side by side on wide terminals):
```
▗▟▀▙▖  sidebet v0.1.0
▝▜▄▛▘  2 attempts · 2 running · 24s  ctrl+c cancel

task  Make search case-insensitive and add a test

╭─ A  github-copilot/claude-sonnet-5.5 ───────────────╮  ╭─ B  openai/gpt-5.5 ─────────────────────────────────╮
│ ⠹ running · 24s · first edit 9.1s                   │  │ ⠹ running · 24s                                    │
│ tokens     83.1k  ↑80.5k ↓2.6k                      │  │ tokens     41.2k  ↑40.1k ↓1.1k                     │
│ turns      8      ▂▃▅▃▇▄▆█                          │  │ turns      5      ▃▄▅▆█                            │
│ tools      8                                        │  │ tools      4                                       │
│ cost       $0.06                                    │  │ cost       cost n/a                                │
│ edit apps/cli/src/commands/memory.ts                │  │ bash pnpm exec vitest run apps/cli                 │
╰─────────────────────────────────────────────────────╯  ╰─────────────────────────────────────────────────────╯
```

Metrics table after a compare (from a real run against the fake runtime; the shape is what matters):
```
Metrics
                          A  alpha            B  beta
  Status                  completed           completed
  Total time              992ms ◂             1.9s
  Agent time              610ms ◂             1.5s
  Time to first token     607ms ◂             1.5s
  Time to first edit      607ms ◂             1.5s
  Turns                   1                   1
  Tool calls              1 (write 1)         1 (write 1)
  Tool errors / blocked   0 / 0               0 / 0
  Input tokens            1,200               100 ◂
  Output tokens           300                 20 ◂
  Cache read / write      0 / 0               0 / 0
  Total tokens            1,500               120 ◂
  Output speed            491.8 tok/s         13.1 tok/s
  Cost                    $0.01               not reported
  Files changed           1                   1
  Lines +/-               +1 / -1             +1 / -2
  Tests                   passed (1 passed)   passed (1 passed)
  Test time               228ms               173ms
  ◂ marks the better value for that single metric; metrics are not combined into a score.
```

`sidebet odds`:
```
Model         Runs  Tests passed (objective)  Preferred (human)    Accepted    Median time  Median tokens  Median cost
fakeai/alpha  7     ████████ 6/6 (100%)       ░░░░░░░░ 0/2 (0%)    -           971ms        1,500          $0.01 (n=7)
other/beta    6     ████████ 6/6 (100%)       ████████ 2/2 (100%)  2/2 (100%)  1.8s         120            n/a

Your calls  ◉  1/1 matched your later preference

• Only 2 compare run(s) have a recorded human preference. Treat preference rates as anecdotes until you have more.
```

The web UI (`sidebet ui`): dark and light screenshots can be taken from the real page; the runs list is on the left, the selected run on the right with attempt cards (cyan A, pink B), the metrics table, and tabs for diff / summary / tools / tests / context. Take real screenshots; do not mock them.

## 8. Facts that constrain copy (read twice)

- **Install is from source today.** Sidebet is not published to npm yet. The only honest install block is:
  ```
  git clone https://github.com/jamesray/sidebet.git && cd sidebet
  pnpm install && pnpm build
  cd apps/cli && pnpm link --global
  ```
  Requirements: Node 22.19+, pnpm, Git, and a working Pi login. Do not show `npm install -g sidebet` until it exists.
- **Pi is required.** No Pi, no Sidebet. Pi is at https://github.com/earendil-works/pi (`npm install -g @earendil-works/pi-coding-agent`). Sidebet is built and tested against Pi 1.1.0.
- **Compare needs two models the developer can use.** Both can come from the same provider.
- **`sidebet run` edits the working tree directly**, like Pi. Only `compare` isolates.
- **Cost is often unavailable.** Subscription logins (Claude plan, ChatGPT, Copilot) generally report no cost. The site must not imply "see exactly what every run costs" unconditionally; say "cost, when the provider reports it".
- **Odds are small-sample by construction.** The product itself prints caveats. Copy must not promise statistical significance.
- **Policy limits.** Protected paths are enforced for file tools; a shell can still read any file unless `policy.strict` removes bash. Pi extensions and skills run with the user's permissions. Say "enforced in code"; never "sandbox", "secure", "airtight".
- **Reruns are not reproducible** and the product says so on every rerun.
- **Platform.** macOS and Linux exercised; Windows untested. Node's built-in SQLite is used (still marked experimental by Node).
- **Tests make no paid model calls.** The adapter is tested against Pi's real SDK with its faux provider. That is a fair engineering-credibility point: "86 tests, none call a paid model".
- **Pi extension** is installed with `pi install ./extensions/pi` from the cloned repo and adds `/sidebet`, `/sidebet-context`, `/sidebet-memory`, `/sidebet-compare`, `/sidebet-review`, `/sidebet-odds` inside Pi, plus a status entry showing how many rules and memories the session received.
- **No telemetry, no analytics, no network calls** of Sidebet's own. The only network traffic is Pi talking to the model providers.

## 9. The business, and what to say about it

Sidebet is open-core. The CLI, core, Pi adapter and web view are and will stay open source under Apache-2.0. The intended business is **Sidebet Cloud**: a subscription for teams that adds shared memory, organisation-level policy, hosted run and evaluation history, and usage analytics across a team. None of it exists yet.

Allowed on the site: a "Sidebet Cloud" section marked clearly as *planned* or *coming*, describing the team use case in one paragraph, with an email waitlist. Not allowed: pricing, dates, "sign up", "start free trial", feature lists presented as available, or any login.

The architecture is deliberately ready for it (records are versioned, self-contained JSON documents; storage and the agent runtime are behind interfaces; memory and policy already have scopes that a "team" layer slots into), which is a reasonable thing to say in a "built to grow" paragraph for technical readers.

## 10. Suggested page structure

1. Hero: chip mark, product name, tagline, two-line description, two buttons: "Get started" (links to the install section) and "GitHub". A real terminal screenshot of the compare dashboard beside it.
2. The problem, in two short paragraphs (section 3's two pains).
3. How it works: the six steps from section 4, each with a real command and one real output excerpt.
4. "Nothing invented": a short section on evidence and transparency (section 5, bullets 2–3). This is the credibility anchor.
5. Policy and safety, honestly (section 5 bullet 4, with the enforced/partial language).
6. Works with Pi: what Pi provides, what Sidebet adds, the slash commands. Link to Pi.
7. Local-first and open source: Apache-2.0, SQLite, no account, the repo link, contribution welcome.
8. Sidebet Cloud, planned: one paragraph and a waitlist (section 9 rules).
9. Install: the from-source block, requirements, and the `sidebet doctor` tip.
10. FAQ (section 11).
11. Footer: GitHub, docs (the repo's `docs/` folder: getting-started, cli, configuration, pi-integration, security, architecture, roadmap), license.

## 11. FAQ answers you can use

- *Does my code go anywhere?* Only to the model providers you have logged into through Pi, exactly as it would from Pi. Sidebet itself makes no network requests and has no telemetry.
- *Why not just use Pi?* You should keep using Pi. Sidebet adds the things around it: context that persists across sessions, policy that is enforced, comparison in isolated worktrees, review with measured metrics, and a history you can learn from.
- *Which models?* Anything Pi has credentials for. On a typical setup that is dozens of models across Anthropic, OpenAI, GitHub Copilot, xAI and others, including subscription logins.
- *Does it merge the winner automatically?* No. You choose, with the diffs and metrics in front of you, and apply explicitly. A backup ref is saved first and the undo command is printed.
- *Can I trust the odds?* Only as far as your sample size, which is always shown. Tests are objective but only as good as your suite; preference is your judgement; the two are never blended.
- *Is it free?* Yes, Apache-2.0, run it anywhere. A paid cloud offering for teams is planned; nothing about the local tool depends on it.
- *Windows?* Untested so far.

## 12. Glossary (use these words consistently)

- **Run**: one task the developer asked for. **Attempt**: one model's go at that task; a compare run has two or more attempts, labelled A, B, …
- **Context snapshot**: the exact set of rules, documents and memories a run received, stored with reasons.
- **Policy**: allowed providers and models, protected paths, read-only, tool restrictions, approval-required commands. Versioned by content hash and recorded on every run.
- **Worktree**: Git's mechanism for a second checkout of the same repository; Sidebet creates one per attempt from a snapshot commit.
- **Odds**: the developer's own history per model. **Call** / **bet**: the developer's recorded prediction before reviewing.
- **Lane**: the colour assigned to an attempt (A cyan, B pink).

## 13. What to ask the product engineer rather than guess

New screenshots after UI changes; exact numbers from a real compare on a real repo for the hero (the figures above from the fake runtime are structurally real but should not be presented as a benchmark of any named model); whether the npm package name is settled before publishing an `npm install` command.
