# Design

## Context

See proposal.md - Why. The review engine (`src/main/ai/review.ts`, pure helpers in `review-core.ts`) persists one `ReviewRun` per target under the app's user-data directory through `saveRun`, which already writes atomically (temp file + rename) and prunes to `MAX_RUNS_PER_REPO`. Pre-commit runs replace their predecessor; pull request and branch runs are keyed by head SHA. The renderer keeps the pull request/branch run in `state/review.ts` and the pre-commit run in `state/precommitReview.ts`; the latter is in-memory only and rebuilt from the commit form's included files and partial selections. `src/main/index.ts` already registers the `gitgood://` scheme (also in `electron-builder.yml`), parses `openRepo` links in `parseProtocolUrl`, and forwards them to the renderer as a `menu.action` of kind `protocol-open`. `src/main/integrations/shells.ts` can open a terminal in a directory but cannot run a command in it. `src/main/git/status.ts` exposes `getGitDir` (cached `git rev-parse --git-dir`).

Terminal agents were checked against their current docs: Claude Code plugins use `.claude-plugin/plugin.json` with `skills/`, `commands/` and `hooks/hooks.json`; Codex plugins use a root `plugin.json` on the agent-plugins.org schema with `skills/` and `hooks/hooks.json`, and read skills from `.agents/skills`; omp plugins are npm-style packages with `skills/`, `commands/` and TypeScript hook factories under `hooks/pre|post/`, install with `omp plugin install name@marketplace`, and accept `.claude-plugin/marketplace.json` as a marketplace catalog. All three take an initial prompt as a positional argument (`claude "…"`, `codex "…"`, `omp "…"`).

## Goals / Non-Goals

**Goals:**
- The agent needs nothing but file access to the repository to find the findings; GitGood needs nothing but a URL open to be told to re-review.
- One plugin folder serves all three agents without per-tool copies of the skill text.
- The launcher degrades gracefully: any terminal GitGood can open, it can at least open with the command on the clipboard.

**Non-Goals:**
- A `gitgood` CLI or MCP server (the export is the interface; a CLI could read it later).
- Agent write-back of resolve/dismiss state; the re-review decides what is fixed.
- Bundling the plugin into the Electron app or auto-installing it into agent config directories.

## Decisions

- **Export location `<git-dir>/gitgood/review/`.** Uses `getGitDir` so linked worktrees (whose `.git` is a file) export next to their own HEAD, and nothing lands in the working tree or needs ignoring. Alternative: `.gitgood/` in the worktree, where the guideline file already lives; rejected because exports are per-machine artifacts and would show up as untracked changes in every status.
- **Export as a side effect of `saveRun`.** `saveRun` is the single write path for runs and dismissals, so hooking the export there (fire-and-forget, wrapped in try/catch with `log.warn`) keeps JSON, Markdown and the store consistent without touching the run loops. The previous run id comes from `loadRuns` filtered by `targetKey`. Rendering lives in a new pure module `src/main/ai/review-export.ts` (`buildExportJson`, `renderExportMarkdown`, `exportFileNames`) so ordering, Markdown shape and path normalisation are unit tested without git or Electron.
- **Stable pretty-printed JSON.** The export is written with two-space `JSON.stringify` so a hook script with only `grep` can count `"dismissed": false` lines; this formatting is part of the contract and covered by a test.
- **`latest.*` are copies, not symlinks.** Windows symlinks need privileges and agents read files, not links. Latest reflects the most recently finished run of any target, and a re-export of an older run (a dismissal, an applied suggestion) refreshes only that run's own `runs/` pair, so an agent is never redirected to superseded findings. `previousRunId` is resolved by scanning the exported `runs/` directory for the newest earlier run of the same target, not from the review store: the store keeps one pre-commit run per repository and would lose the chain after the second run. `latest()` orders by finish time, since a long pull request review can start before and finish after a quick pre-commit one.
- **A failed export is reported, not hidden.** `writeExport` throws; `saveRun` swallows the error so a failed export never fails a review or a dismissal, while `exportPath` turns it into an `AiError`. Checking only that `latest.md` exists would hand an agent the previous run's findings after a failed write.
- **Protocol parsing returns a discriminated union.** `parseProtocolUrl` gains `{ kind: 'review-rerun'; repoPath }` next to the existing `{ kind: 'open-repo'; … }`; `deliverProtocolUrl` maps the new kind to a `menu.action` of `protocol-review-rerun`. The renderer owns the rerun because the pre-commit review needs the commit form's included files and partial patches, which only exist there. A new `ai.review.latest(repoPath)` IPC returns the most recent finished run so the renderer can pick pre-commit vs pull request/branch before opening the repository's UI.
- **Rerun semantics: only the pre-commit review closes the loop.** `resolveTarget` reads committed history for pull request and branch reviews (`baseSha...headSha`, or the diff from `gh`), while the agent is told not to commit, so re-running one of those would return byte-identical findings and burn a model call. So: pre-commit runs export a `rerun` object and the deep link re-runs `runPrecommitReview()` over the currently included files; pull request and branch runs export `rerun: null`, their instruction block tells the agent to report and stop, and the deep link answers with a toast offering to review the pending changes instead. A running review (`review.running || precommitReview.running`, re-checked after the awaited lookup) is left alone with a toast.
- **Terminal command launching.** A pure `shellCommandInvocation(id, path, cwd, command, scriptPath, platform)` maps a terminal id to argv; it takes the platform explicitly because `shells.ts` reuses the id `ghostty` for a Linux binary and a macOS `.app` bundle, which cannot be launched the same way. Linux terminals run `sh -c '<command>; exec "${SHELL:-sh}"'` through their `-e`/`--`/`-x` argument so the window stays open after the agent exits. macOS resolves to Terminal and iTerm only, through a temp `.command` script (executable, `cd` + command) opened with `open -a <App>` and removed a minute later; Warp and the Ghostty bundle have no verified form. Windows: Windows Terminal `-d <cwd> cmd /k <command>`, PowerShell `-NoExit -Command <command>`, Command Prompt `/k <command>`; Git Bash has none. Terminals without a form, and custom shell paths, fall back to `openShell` plus clipboard. `quotingFor(id, platform)` says which shell will parse the command (`posix`, `powershell` or `cmd`), and `openShellWithCommand` takes a `buildCommand(quoting)` callback and returns the command it used, so the substituted path is escaped for the right shell and the clipboard shows exactly that string. Each shell expands something different inside the double quotes the presets use: POSIX `$` and backtick (escape `\`), PowerShell `$` and backtick (escape backtick), cmd.exe `%VAR%` (no escape character, so `%` is doubled) — all legal path characters. A custom template that quotes `{file}` differently is the user's responsibility; the settings hint says so. Alternative: spawn the agent directly with a pseudo-terminal; rejected because the agents are interactive TUIs that need a real terminal.
- **Presets over free-form.** `AiSettings.agentCommand: 'claude' | 'codex' | 'omp' | 'custom'` plus `agentCustomCommand`. Preset templates live in a shared table (`src/shared/agent-presets.ts`) so the settings UI shows exactly what will run. Templates are prompts, not slash commands, so they work whether or not the plugin is installed: `claude "Read {file} and fix every finding it lists, following its instructions. Do not commit."`.
- **One-time notice.** `AiSettings.agentHandoffNoticeShown` (default false, not portable) gates a confirm dialog on first launch explaining that the export, including diff excerpts, is handed to the chosen agent.
- **Plugin folder shape.** `plugin/` at the repository root with `.claude-plugin/plugin.json`, `plugin.json` (Codex, `$schema` agent-plugins.org 1.0.0), `package.json` (omp), `skills/gitgood-review/SKILL.md`, `commands/gitgood-review.md`, `hooks/hooks.json` (Claude Code shape, also what Codex reads by default), `hooks/session-start.sh` (POSIX; prefers `node` for counting, falls back to `grep -c`), and `hooks/pre/session-start.ts` (omp factory on `before_agent_start` injecting a minimal system note). Root `.claude-plugin/marketplace.json` lists the plugin with a relative source. Hook commands reference `${CLAUDE_PLUGIN_ROOT}` with `${PLUGIN_ROOT}` as fallback so the same file works for Codex.

Types and IPC:

```ts
// AiSettings gains
agentCommand: 'claude' | 'codex' | 'omp' | 'custom'; // default 'claude'
agentCustomCommand: string;                          // default '', must contain {file}
agentHandoffNoticeShown: boolean;                    // default false
// ApiMethods
'ai.review.latest': (repoPath: string) => Promise<ReviewRun | null>;
'ai.review.exportPath': (repoPath: string, runId: string) => Promise<string>; // rewrites the export, throws on failure, returns the run's markdown
'ai.review.fixWithAgent': (repoPath: string, runId: string) => Promise<{ launched: boolean; command: string }>; // refuses an empty or {file}-less custom template
// MenuActionEvent
{ action: 'protocol-review-rerun'; args: { repoPath: string } }
```

## Risks / Trade-offs

- [Agent edits move lines so finding line numbers drift] → the Markdown instruction block tells the agent to work file by file and trust title/detail after the first edit; the re-review re-anchors everything.
- [Two runs finish close together and `latest.*` flips targets] → every run keeps its own `runs/<id>.*`, `latest.json` names its target, and the skill re-reads `latest.json` after rerun and reports a target change instead of comparing across targets.
- [Terminal quoting differs per shell] → substitution is chosen per terminal (`quotingFor`), unit tested with paths containing spaces, quotes, `$`, backticks and `%`; terminals without a verified command form fall back to clipboard. Windows Terminal takes the command as trailing `cmd /k` tokens and `wt` splits its own command line on `;`, so a template or path containing `;` is a known limitation there.
- [Export written while an agent reads it] → temp file + rename, same as the store.
- [Hook noise in agent sessions] → the hook prints exactly one line and only when the export has non-dismissed findings; exits 0 otherwise.
- [omp hook API changes] → the factory is small and typed only through a local interface; the skill and JSON export do not depend on it.
- [Codex marketplace configuration key not shown in the docs] → documented as "install through the /plugins browser after adding this repository as a marketplace"; left as an open question for a manual check.

## Migration Plan

Additive. New settings take defaults through the existing `{ ...DEFAULT_SETTINGS.ai, ...loaded.ai }` merge; no data migration. Rollback removes the export hook, the new URL kind and the button; existing exports under `.git/gitgood/` are harmless leftovers.

## Open Questions

- Exact Codex CLI configuration for registering a GitHub repository as a plugin marketplace; verify on a machine with Codex installed and document in `plugin/README.md`.
