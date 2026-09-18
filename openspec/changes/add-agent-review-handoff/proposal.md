# Proposal

## Why

GitGood's AI review (pull request, branch and pre-commit) produces anchored findings with suggestions, but acting on them means editing files by hand or applying suggestions one at a time. Terminal coding agents such as Claude Code, Codex and omp already sit next to GitGood on developers' machines and can fix a batch of findings in one pass, yet nothing in GitGood hands them the findings or lets them ask for a re-review when they are done.

## What Changes

- Export every completed review run into the repository's git directory as a machine-readable JSON file and a Markdown twin that opens with instructions for an agent, so any agent working in the repository can read the findings with its own file tools.
- Extend the existing `gitgood://` protocol handler with a **re-review** deep link that re-runs the most recent review for a repository already open in GitGood, so an agent can close the loop without a CLI.
- Add a **Fix with agent** action on the pull request review panel and the pre-commit findings strip that opens the repository in the user's terminal and runs a configurable agent command, with built-in presets for Claude Code, Codex and omp and a clipboard fallback when the terminal cannot run a command.
- Ship an agent plugin folder in this repository containing one shared `gitgood-review` skill, a slash command, and a session-start hook for Claude Code, Codex and omp, plus a marketplace manifest so it can be installed from GitHub.
- No CLI, no MCP server, and no write-back from the agent: the re-review is the source of truth for what was fixed.

## Capabilities

### New Capabilities
- `ai-review-agent-handoff`: exporting AI review findings to the repository, launching a terminal coding agent on them, triggering a re-review through a deep link, and the agent plugin that packages the workflow.

### Modified Capabilities
<!-- none: the review engine, its findings, validation and staleness tracking are unchanged; this change only adds an export after each run, a new deep link and a new entry point -->

## Impact

- Git commands: `git rev-parse --git-dir` (already wrapped in `src/main/git/status.ts`) to locate the export directory for the main working tree and linked worktrees. No new git operations; the re-review reuses the existing review runs.
- Files written: `<git-dir>/gitgood/review/latest.json`, `latest.md`, `runs/<runId>.json` and `runs/<runId>.md`, pruned to the same per-repository cap as the review store. Nothing is written into the working tree, so no `.gitignore` changes are needed.
- Protocol: a new `gitgood://review/rerun?repo=<path>` URL alongside the existing `gitgood://openRepo/...`; registered scheme unchanged (`electron-builder.yml`).
- Code touched: `src/main/ai/review.ts` (export after save, rerun lookup), new `src/main/ai/review-export.ts` (pure rendering, unit tested), `src/main/index.ts` (protocol parsing), `src/main/integrations/shells.ts` (run a command in the terminal), `src/main/ipc.ts`, `src/shared/types.ts`, `src/shared/ipc.ts`, `src/renderer/src/state/actions.ts`, `components/review/ReviewView.tsx`, `components/ChangesTab.tsx`, `components/dialogs/SettingsDialog.tsx`.
- New settings: `ai.agentCommand` (preset id or `custom`) and `ai.agentCustomCommand` (template with `{file}`), defaults to the Claude Code preset. Portable through settings sync as preferences.
- New repository folder `plugin/` with Markdown and JSON only; not bundled into the Electron app. No new runtime dependencies.
- Launching the agent hands the exported findings, which contain excerpts of the reviewed diff, to a third-party tool the user chose and configured; the first launch shows a one-time notice.
