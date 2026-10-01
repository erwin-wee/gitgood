# Tasks

## 1. Data and types

- [x] 1.1 Extend `PR_FIELDS` and `PullRequest` parsing in `src/main/gh/gh.ts` with commits, files, reviews, latest reviews, comment counts and `headRefOid`; verify new cases in `test/main-parsers.test.ts`
- [x] 1.2 Add `TriageState`, `PrTriage`, the `ai.triage.*` IPC methods, the progress event and the two `AiSettings` fields with defaults; verify `npm run typecheck`

## 2. Triage service

- [x] 2.1 Implement the deterministic rules (`draft`, `conflicts`, own PR with failing checks, explicit review request, 14-day stale) and the merge downgrade; verify `test/triage.test.ts` covers each rule and the override precedence
- [x] 2.2 Add the schema and batched prompt builder (15 PRs, 1,500-char bodies, optional file stats, failing check names, signed-in login) to `src/main/ai/prompts.ts`; verify a prompt test respects the caps and the diff-stat toggle
- [x] 2.3 Implement `ai.triage.run` with sequential batches, cancellation between batches, single-item retry for missing numbers, caps on summary and reason, and progress events; verify with a stubbed backend that a 40-PR run yields three batches and a cancelled run keeps the first batch
- [x] 2.4 Implement the cache under `userData/triage/<repoId>.json` with `updatedAt` keys, eviction for closed/merged PRs and 30-day age, and `ai.triage.get` / `ai.triage.clear`; verify eviction unit tests

## 3. Renderer

- [x] 3.1 Render triage lines with state chips, hover details, dimmed stale rows and next-action links to existing dialogs in `GitHubDialogs.tsx`, hidden when the provider is disabled; verify the smoke screenshot shows chips and lines
- [x] 3.2 Add the Summarize N button with progress toast and cancel, the Waiting on you toggle with count in the title, and the offline tooltip; verify N equals the number of PRs without a fresh cache entry
- [x] 3.3 Add the toolbar PR badge fed by the poller and the two settings in `SettingsDialog.tsx`; verify the badge count equals the filter count
- [x] 3.4 Expose `summarizePullRequests` on `window.__gitgood.actions`; verify the smoke script can trigger it

## 4. Verification

- [x] 4.1 Run `npm run typecheck` and `npm test`; verify both pass
- [x] 4.2 Smoke pass with a stub `gh` on PATH returning a fixture PR list and the AI stub: open the PR dialog, run summarize, screenshot, dump the store; verify the waiting-on-you count matches the fixture
