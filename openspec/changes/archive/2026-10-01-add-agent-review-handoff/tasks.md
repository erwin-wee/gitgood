# Tasks

## 1. Export

- [x] 1.1 Add `src/main/ai/review-export.ts` with `buildExportJson(run, previousRunId)`, `renderExportMarkdown(run, platform)` and `exportFileNames(runId)`; verify unit tests in `test/review-export.test.ts` cover severity ordering, dismissed findings omitted from Markdown but present in JSON, forward-slash paths, CRLF suggestion round-trip, the instruction block text and the two-space JSON formatting
- [x] 1.2 Hook the export into `ReviewService.saveRun` in `src/main/ai/review.ts` using `getGitDir`, writing `runs/<runId>.json|.md` atomically plus `latest.json|.md` only when the run is the newest finished one, with pruning and try/catch logging (`exportPath` rethrows instead); verify with real-git tests in `test/precommit-review-service.test.ts` covering a seeded run written through `dismiss`, a linked worktree, a dismissal on a superseded run, a failed export and the five-run cap
- [x] 1.3 Add `ai.review.latest` and `ai.review.exportPath` to `src/shared/ipc.ts` and `src/main/ipc.ts`; verify `npm run typecheck`

## 2. Re-review deep link

- [x] 2.1 Move `parseProtocolUrl`/`protocolUrlFromArgv` out of `src/main/index.ts` into `src/main/protocol.ts`, returning a discriminated union with `review-rerun`, and update `deliverProtocolUrl`; verify unit tests in `test/protocol.test.ts` for the rerun URL, percent-encoded Windows paths, a `+` in the path, missing `repo` and the unchanged `openRepo` form
- [x] 2.2 Handle `protocol-review-rerun` in `src/renderer/src/state/agentHandoff.ts`: match the repository (case-insensitively on Windows/macOS), open it, re-run the pre-commit review, refuse with a toast while a review runs, when the provider is disabled, when no run exists and when the latest run is a pull request or branch review (which reads committed history); verify by driving `window.__gitgood.actions.handleProtocolReviewRerun` in a smoke scenario with a stubbed claude and by `test/agent-handoff-paths.test.ts`

## 3. Fix with agent

- [x] 3.1 Add `agentCommand`, `agentCustomCommand` and `agentHandoffNoticeShown` to `AiSettings`, defaults, `PortableAiSettings` (first two only) and `src/shared/agent-presets.ts` with the three preset templates and `{file}` substitution helpers; verify unit tests for POSIX and Windows quoting of paths with spaces and quotes and for the `{file}` validation
- [x] 3.2 Add a platform-aware `shellCommandInvocation`/`quotingFor` table in `src/main/integrations/shell-command.ts` and an `openShellWithCommand` in `shells.ts` that builds the command for the chosen terminal's shell and reports whether it ran or must be pasted; verify unit tests for the Linux/macOS/Windows argument shapes, that the macOS Ghostty bundle falls back, and the custom-shell and unknown-terminal fallbacks (`test/shell-command.test.ts`, `test/agent-handoff-launch.test.ts`)
- [x] 3.3 Add `ai.review.fixWithAgent` to IPC that writes the export if missing, expands the template and launches, copying to the clipboard on fallback; verify `npm run typecheck`
- [x] 3.4 Add the Fix with agent button to `ReviewView.tsx` and the pre-commit strip in `ChangesTab.tsx` (hidden when the provider is disabled or no live findings, disabled while running) with the one-time notice dialog and fallback toast; verify with a smoke screenshot and a store dump showing the notice flag flipped
- [x] 3.5 Add the Agent for fixes control to the AI tab of `SettingsDialog.tsx` with inline `{file}` validation; verify a smoke dump that a template without `{file}` is not saved

## 4. Plugin

- [x] 4.1 Create `plugin/` with `.claude-plugin/plugin.json`, `plugin.json`, `package.json`, `skills/gitgood-review/SKILL.md`, `commands/gitgood-review.md`, `hooks/hooks.json`, `hooks/session-start.sh`, `hooks/pre/session-start.ts`, `plugin/README.md`, and root `.claude-plugin/marketplace.json`; verify a unit test in `test/agent-plugin.test.ts` that every manifest parses, the skill frontmatter has `name` and `description`, and `hooks.json` names the shell script
- [x] 4.2 Verify `hooks/session-start.sh` against a fixture export: prints one line with the count when findings exist, prints nothing and exits 0 when the file is missing, both with and without `node` on PATH (test spawns `sh` with a trimmed PATH)

## 5. Docs and verification

- [x] 5.1 Document the handoff in `docs/AI-FEATURES.md` (new section), the export and deep link in `docs/ARCHITECTURE.md`, plugin installation for all three agents in `plugin/README.md`, and add a README Features bullet; verify the README mentions "Fix with agent"
- [x] 5.2 Run `npm run typecheck` and `npm test` and confirm both pass
- [x] 5.3 Smoke pass: new scenario `34-agent-review-handoff.json` runs a stubbed pre-commit review, asserts `latest.json`, `latest.md` and `runs/<id>.json` exist under the git directory, that the Fix with agent button renders and its notice dialog opens, drives the rerun handler and asserts a new run id whose `runs/` file exists next to the old one, an unknown-repository toast, and the settings template validation (the `previousRunId` chain is covered by the real-git unit test in 1.2)
