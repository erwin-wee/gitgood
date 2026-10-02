# Contributing

Thanks for considering a contribution to GitGood. This is a small, mostly solo-maintained project, so keeping changes focused and reviewable matters more than process.

## Before you start

- For anything more than a small fix, open an issue or a discussion first describing the problem and your proposed approach — it saves rework on both sides.
- This repo tracks its roadmap with [OpenSpec](https://github.com/Fission-AI/OpenSpec) under `openspec/`: `openspec/specs/` holds the current baseline behaviour per capability, and `openspec/changes/` holds proposed and in-flight changes (proposal, spec deltas, design notes, a task checklist). Browsing an existing change there is often the fastest way to understand *why* something works the way it does, since the spec deltas capture intent that isn't always obvious from the code.
- When a change is implemented, archive it (`openspec archive <name>`, or the `opsx` archive workflow) so its spec deltas are merged into `openspec/specs/` and the change moves to `openspec/changes/archive/`; tasks you could not verify yet stay unchecked with a one-line note in `tasks.md`. Not every change needs a formal OpenSpec proposal — a bug fix or small, self-contained improvement is fine as a plain pull request. A new capability or a behaviour change worth documenting is a good candidate for one.

## Development setup

See [DEVELOPMENT.md](DEVELOPMENT.md) for installing dependencies and running the app, and [ARCHITECTURE.md](ARCHITECTURE.md) for how the codebase is laid out.

## Before opening a pull request

```bash
npm run lint        # eslint (react-hooks) + typecheck
npm test
```

Both must pass. If your change touches the renderer UI, also run `npm run test:smoke` (see DEVELOPMENT.md for its display-server requirement) and describe what you verified manually if a scenario isn't automated.

Guidelines that keep this codebase consistent:

- Prefer editing existing files and reusing existing patterns (e.g. the `*-core.ts` pure-logic-plus-thin-orchestrator split used throughout `src/main/`) over introducing new abstractions.
- New third-party dependencies (a library, a GitHub Action, a new build tool) are a bigger deal than they look — they're a permanent addition to the supply chain and the build. Flag the addition and your reasoning in the PR description so it can be discussed before merging.
- Match the existing comment style: comments explain *why* something non-obvious is done a certain way, not *what* the code does.
- User-visible changes get a line under **Unreleased** in [CHANGELOG.md](../CHANGELOG.md), and anything that makes a README or `docs/` statement false is updated in the same pull request.
- Commit messages and PR titles in this repo generally follow a `type: summary` shape (`feat:`, `fix:`, `test:`, `docs:`, `refactor:`, …) — check recent history (`git log --oneline`) for the tone.

## Reporting bugs

Include: what you did, what you expected, what happened instead, your OS and GitGood version (Help → About), and the relevant lines from the app log (Options → Advanced has a link to the log file — scrub anything sensitive first, tokens are already redacted by GitGood itself but double-check).

## Security issues

Please don't open a public issue for a security vulnerability. Report it privately as described in [SECURITY.md](../SECURITY.md) (GitHub → Security → Advisories → Report a vulnerability).
