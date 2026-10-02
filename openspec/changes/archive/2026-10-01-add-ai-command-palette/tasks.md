# Tasks

## 1. Policy layer

- [x] 1.1 Implement `src/main/ai/nlPolicy.ts` with `git` prefix stripping, shell metacharacter rejection, allowlist grammar per family, denylist, risk recomputation and wrapper mapping; verify with a positive/negative table in `test/nl-policy.test.ts`
- [x] 1.2 Add step-count cap, clarifying-question precedence, path containment and in-progress-operation family restriction to the policy; verify unit tests for each rule

## 2. Planner service

- [x] 2.1 Add `NlStep`, `NlPlan`, `NlRunResult`, the `ai.nl.*` IPC methods, the `ai.nl.progress` event and `AiSettings.nlPaletteEnabled` to `src/shared/types.ts` and `src/shared/ipc.ts`; verify `npm run typecheck`
- [x] 2.2 Add the palette schema and prompt builder to `src/main/ai/prompts.ts` and a planner service that gathers repository context (status, branches, last 30 commits, stashes, remotes, tags) and runs the policy on the response; verify a test with a stubbed backend produces a plan with recomputed risk
- [x] 2.3 Implement `ai.nl.preview` with the fixed preview table and `git rev-parse --verify` ref checks; verify in a temp repo that a reset preview lists the right commits and an unknown ref marks the step non-executable
- [x] 2.4 Implement `ai.nl.run` executing confirmed steps through mapped wrappers, emitting `awaiting-confirmation` for destructive steps and logging argv and exit code; verify in a temp repo that a plan step runs and a denylisted step does nothing even if a tampered plan object claims it is executable

## 3. Renderer

- [x] 3.1 Add `CommandPalette.tsx` with built-in fuzzy matching, Ask AI row (hidden when provider disabled or setting off), loading and Escape cancel; bind `Ctrl+K` in `src/main/menu.ts`; verified via the `ai-command-palette` smoke scenario (palette opens, built-in list renders) and manual code review (no automated test drives the raw keypress, since smoke scripts talk to `window.__gitgood` directly)
- [x] 3.2 Render the plan card with risk chips, previews, greyed copy-only steps with reasons, clarifying question with one answer round, and Run plan wiring through existing dialogs; verified end-to-end via the `ai-command-palette` smoke scenario (confirm dialog opens and runs the step)
- [x] 3.3 Add in-memory history of the last 20 plans with Copy commands; the history array lives only in `nlPalette` store state (never persisted), so it is empty again after a restart by construction
- [x] 3.4 Add the palette toggle to `SettingsDialog.tsx` and expose `openCommandPalette` on `window.__gitgood.actions`; verified via code review and the smoke scenario (`window.__gitgood.actions.openCommandPalette` is what the scenario calls)

## 4. Verification

- [x] 4.1 Run `npm run typecheck` and `npm test`; both pass (see report)
- [x] 4.2 Smoke pass: open the palette via `window.__gitgood.actions.openCommandPalette('undo last commit keep changes')` with the AI stub, screenshot the plan card, confirm, and dump history; verify HEAD moved and changes are present — implemented as `test/smoke/scenarios/30-ai-command-palette.json`, passing (HEAD moves to "Initial commit", `src/util.ts` reappears as an uncommitted change)
