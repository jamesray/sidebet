# Guidelines

How we treat each other and the repository. [CONTRIBUTING.md](CONTRIBUTING.md) covers setup, layout, and code rules; this page covers conduct and etiquette. Both apply to issues, pull requests, discussions, and anything else that happens under this repository.

## Be decent

- Assume good faith. Most confusing messages are a time zone, a language barrier, or a bad day, not malice.
- Disagree with ideas, not people. "This breaks reruns" is useful; "you clearly didn't think about this" is not.
- Harassment, discrimination, personal attacks, sexualised language, and publishing someone's private information are not tolerated, in any venue connected to the project.
- Respect "no". A maintainer declining a change is a decision, not an opening bid.
- If you see something that crosses a line, report it privately to a maintainer rather than escalating in the thread. Maintainers may edit, hide, or delete comments, lock threads, and block accounts to keep the project healthy. They will say when they have done so and why.

## Issues

- Search first. Add to an existing issue instead of opening a near duplicate.
- One problem per issue. Include your OS, Node and pnpm versions, the Pi version, the output of `sidebet doctor`, what you ran, what you expected, and what happened. Redact anything from your repository or memory that you would not post publicly.
- For feature requests, describe the problem before the solution. Check the [roadmap](docs/roadmap.md), including the non-goals, so nobody spends an evening on something that will be closed.
- Use reactions instead of "+1" or "any update?" comments. They are counted; the comments only notify people.
- Security problems go through a private security advisory, never a public issue. See [docs/security.md](docs/security.md#reporting-vulnerabilities).

## Pull requests

- Open an issue before large changes, particularly anything that looks like cloud sync, accounts, or a new runtime.
- One change per pull request. A fix and an unrelated refactor are two pull requests.
- Say what changed and why in the description, and link the issue. The subject line of the commit should read as an imperative sentence, like the ones already in the history.
- Run `pnpm lint`, `pnpm typecheck`, and `pnpm test` before you push. Keep CI green; use a draft pull request for work in progress.
- Behaviour changes come with tests. User-facing changes come with documentation changes in the same pull request.
- Do not bump versions, reformat untouched files, or rewrite documentation prose that is not part of your change.
- Contributions written with an AI coding agent are welcome; this project exists to make that workflow better. You are still the author. Read every line, run it, and be ready to explain it. Do not open a pull request you have not tested yourself.
- By submitting a pull request you agree that your contribution is licensed under the [Apache-2.0 license](LICENSE). Do not paste in code under an incompatible license, and add an entry to [NOTICE](NOTICE) when a dependency's license requires one.

## Reviews

- Review the code, not the person. Explain the reason behind a request so the author can apply it next time without asking.
- Mark what is blocking and what is a nit. A nit never blocks a merge on its own.
- Authors: answer every comment, even if the answer is "done" or "I disagree, because...". Avoid force-pushing in the middle of a review, since it detaches the comments; squashing at the end is fine.
- Approve when the change makes `main` better than it was, not when it is perfect.

## Communication

- Write plainly and in English. Short sentences and concrete examples travel better than clever ones.
- Be patient. Maintenance is done in spare time, so a response can take days. One polite ping after a week or two is fine; a daily one is not.
- Summarise long threads before asking for a decision. Nobody should have to read forty comments to find the question.
- Do not claim a result you did not measure, in a pull request description any more than in the product. Absent data stays absent.

Thanks for being here. The best thing about an open repository is the people who show up to it.
