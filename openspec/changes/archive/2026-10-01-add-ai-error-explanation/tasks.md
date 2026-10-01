# Tasks

## 1. Types, action map and scrubber

- [x] 1.1 Add `FixActionId`, `ErrorFix`, `ErrorExplanation`, `ai.explainError` and `AiSettings.explainErrorsAutomatically` (default false) to `src/shared/types.ts` and `src/shared/ipc.ts`; verify `npm run typecheck`
- [x] 1.2 Implement `src/main/ai/fixActions.ts` with the action table, applicability rules and risk; verify unit tests in `test/error-explain.test.ts` for the applicability filter and risk override
- [x] 1.3 Implement the secret scrubber and 4,000-char tails; verify unit tests mask `ghp_`, `github_pat_`, `Bearer`, URL user info and `ANTHROPIC_API_KEY` values

## 2. Explanation service

- [x] 2.1 Add the schema and prompt builder to `src/main/ai/prompts.ts` and the service gathering status, remotes (names and hosts), reflog tail and tool versions; verify a stubbed-backend test returns a validated explanation
- [x] 2.2 Implement fix validation (unknown action → copy-only or drop, shell operators → drop, `retryAfter` downgrade, max 3, 500-char caps); verify the validation table test
- [x] 2.3 Implement the remove-lock-file guard (running git process, lock younger than 10 seconds) behind confirmation; verify a test that a fresh lock is refused

## 3. Renderer

- [x] 3.1 Add the collapsible Explain with AI section to `ErrorDialog` in `CommitDialogs.tsx` with loading, result, error/Retry and offline states, hidden for codes with dedicated flows and when the provider is disabled; verify the row appears for an unknown error and not for conflicts
- [x] 3.2 Dispatch action fixes to the existing action functions with their confirmations and `retryAfter` handling; render copy-only fixes with copy and Run in terminal via `app.openInShell`; verify a `fetch-and-pull` fix calls both operations in order
- [x] 3.3 Add the automatic-explanation toggle to `SettingsDialog.tsx`, applied only to unclassified errors, and the local helpful/not-helpful counters; verify the toggle does not auto-load for a classified error

## 4. Verification

- [x] 4.1 Run `npm run typecheck` and `npm test`; verify both pass
- [x] 4.2 Smoke pass: force a no-upstream push failure in a fixture repo, open the error dialog with the AI stub returning push-set-upstream, click the fix via `window.__gitgood.actions`; verify the branch now has an upstream
