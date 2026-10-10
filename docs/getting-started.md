# Getting started with Sidebet

This guide is for developers who have not used AI coding agents before, or who have used a chat assistant but never one that edits files for them. It takes about twenty minutes and ends with you comparing two AI models on a real change to a real codebase, then choosing which result to keep.

Nothing in this guide can damage your code: Sidebet runs comparisons in copies of your repository, and the only step that changes your files asks for confirmation first.

## What an AI coding agent is, in one paragraph

A chat assistant answers questions. A *coding agent* is a model wired to tools: it can read your files, run commands, and edit code, looping until it thinks the task is done. [Pi](https://github.com/badlogic/pi-mono) is one such agent. It is good, but it has two gaps that Sidebet fills: it forgets your project's conventions between sessions, and it gives you one answer from one model with no way to know whether a different model would have done better. Sidebet keeps your rules and notes consistent across sessions, and runs the same task on several models side by side so you can see for yourself.

## Step 1: Install Pi and log in to a model provider

Pi needs an account with at least one model provider (Anthropic, OpenAI, GitHub Copilot, and others are supported). Many providers offer a subscription or a pay-as-you-go API key.

```bash
npm install -g @earendil-works/pi-coding-agent
pi
```

Inside Pi, type `/login` and follow the prompts for your provider. When it works, ask Pi something trivial like "what is 2+2" to confirm a model responds. Type `/exit` to leave.

For a comparison you need **two** models. They can be from the same provider (for example two different Anthropic models) or from different providers. If you only have one provider, that is fine for the first steps; Step 6 explains your options.

## Step 2: Install Sidebet

Sidebet needs Node.js 22.19 or newer, pnpm, and Git.

```bash
git clone https://github.com/jamesray/sidebet.git
cd sidebet
pnpm install
pnpm build
cd apps/cli && pnpm link --global
```

Check that everything is connected:

```bash
sidebet doctor
```

You should see green ticks for Node, Git, storage, and the Pi runtime, plus a count of models with credentials. If models show `0`, go back to Step 1. If `doctor` says it cannot find Pi, make sure `pi` runs from your terminal.

## Step 3: Pick a project and initialize it

Use any Git repository you own. If you want a safe sandbox, Sidebet ships one:

```bash
cp -R /path/to/sidebet/examples/search-service ~/search-service
cd ~/search-service
git init -b main && git add -A && git commit -m "init"
```

It is a tiny Node project with one function, one test, and an `AGENTS.md` file (instructions that agents read before starting). Now initialize Sidebet:

```bash
sidebet init
```

Sidebet reports what it found: the project name, the test command (`npm test`), the `AGENTS.md`, and how many models are available. It writes one small file, `.sidebet/config.json`. Commit that file so the project id stays stable.

## Step 4: Look before you run

Before an agent touches anything, see what it would receive:

```bash
sidebet context
```

This lists the rules, documentation, and memory that would be given to the model, and an estimate of their size. Right now it is just `AGENTS.md`. Let's add a project note that every future session should know:

```bash
sidebet memory add "Search must stay case-insensitive and must not use regular expressions on user input"
```

Run `sidebet context` again and you will see one memory entry. Memory is advisory: your written rules always take precedence over it.

Now preview a task without running it:

```bash
sidebet run "Make search case-insensitive" --dry-run
```

The dry run shows the model that would be used, the tools it would have, every piece of context with the reason it was included, and the policy that applies (for example, `.env` files are protected and `git push` needs your approval). No model is called. Dry runs are free; use them whenever you are unsure.

## Step 5: Your first real run

```bash
sidebet run "Explain what this repository does" --readonly
```

`--readonly` removes the agent's ability to write files, enforced by Sidebet rather than by asking the model nicely. You will see the agent read files (lines starting with `▸`) and then its explanation. At the end Sidebet prints a summary with the run id, time, and tokens used. Your files are unchanged; Sidebet verifies this and records it.

A read-only run is the safest way to learn how an agent behaves. Try a few questions about your own codebase.

## Step 6: The comparison

This is the part Sidebet exists for. Pick two models. To see what you can use:

```bash
sidebet models
```

Copy two names from that list. Then run the same task on both:

```bash
sidebet compare "Make search case-insensitive and add a test for it" --models <model-a>,<model-b>
```

For example, `--models anthropic/claude-sonnet-4-5,openai/gpt-5`. If you only have one provider, two different models from it still make a useful comparison (a fast model against a careful one). If you only have one model at all, run the task twice with `sidebet run` instead; the review features below still work on single runs.

While it runs you get a live line per model: elapsed time, turns, tool calls, tokens, cost so far, and what each model is doing right now. Both run at the same time in separate copies of your repository (Git worktrees), so they cannot interfere with each other or with your files. When they finish, Sidebet runs `npm test` in each copy.

The summary shows, for each model: whether it finished, files changed, test result, time, tokens, and cost, followed by a metrics table that puts the two side by side (time to first edit, tool calls, lines added and removed, and more). A `◂` marks the better value for that one metric. Nothing is combined into a score; that judgement is yours.

Check that nothing changed in your own files:

```bash
git status
```

Clean, apart from `.sidebet/` if you have not committed it yet.

## Step 7: Review and choose

```bash
sidebet review
```

This opens an interactive menu for the latest comparison. Try these in order:

1. `da` shows model A's diff; `db` shows B's. Read them the way you would read a colleague's pull request: does it do what was asked, is it the way you would do it, did it touch anything it should not have?
2. `c` shows the difference *between* the two results, which is often the fastest way to see where the models disagreed.
3. `s` then `A` or `B` to mark the one you prefer.
4. `r` to record your review: whether you accept the solution, and a one-line reason. This takes ten seconds and is what makes `sidebet odds` useful later.
5. `a` to apply your chosen result to your repository.

Before applying, Sidebet lists the files it will change, warns if you have local edits in any of them, refuses entirely if the change would conflict, and asks you to confirm. It changes only your working tree (nothing is committed), and it saves a backup of your files first. The confirmation message tells you the exact `git` command to undo it.

Now run your tests yourself and look at the result in your editor. If you are happy, commit it like any other change. If not, undo it with the command Sidebet printed, or just `git checkout -- .`.

## Step 8: Look back

Everything is recorded:

```bash
sidebet runs                  # every run, newest first
sidebet runs show <run-id>    # one run in full, including the exact context it got
sidebet runs diff <run-id> B  # a diff from any past attempt
```

After a few comparisons with recorded reviews, ask which model has been working for you:

```bash
sidebet odds
```

It shows, per model, how often tests passed (objective), how often you preferred it (your judgement), and typical time, tokens, and cost. Sample sizes are always shown. With three runs the numbers are anecdotes; with thirty they start to mean something.

## What to do next

- Put project conventions in `.sidebet/rules/*.md` (always injected) and one-off facts in `sidebet memory add` (included when relevant). See [configuration.md](configuration.md).
- Set `models.compare` in `.sidebet/config.json` so `sidebet compare` picks your two models without `--models` every time. Set `run.dual: true` if you want *every* `sidebet run` to show two answers.
- Read [security.md](security.md) once. The short version: agents run with your permissions, `--readonly` is the safe mode, and `compare` never touches your working tree.
- If something looks wrong, `sidebet doctor` and `sidebet policy check` explain what Sidebet is seeing and why a model or tool was refused.

## Troubleshooting

| Symptom | What to do |
|---|---|
| `0 models with credentials` | Run `pi`, then `/login`. Or set an API key such as `ANTHROPIC_API_KEY` in your shell |
| `"x" matches several models` | Use the full `provider/model` name from `sidebet models` |
| `compare needs two eligible models` | Log in to a second provider, or name two models from the same provider with `--models` |
| Tests show `skipped (no tests.command configured)` | Add `"tests": { "command": "<your test command>" }` to `.sidebet/config.json` |
| A model's attempt says `timeout` | The default is 15 minutes per attempt; raise it with `--timeout <seconds>`. Partial work is still saved |
| `not inside a Git repository` | Sidebet needs Git for isolation and diffs: `git init` first |
