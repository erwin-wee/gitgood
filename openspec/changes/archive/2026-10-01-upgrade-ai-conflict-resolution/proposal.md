# Proposal

## Why

The AI conflict resolver already returns a rationale and a confidence per block, but the UI reduces that to a toast count, so users cannot see where to look. A wrong resolution is only discovered when the user builds, and in a rebase touching the same pattern across many files the model repeats work the user just did by hand.

## What Changes

- Show a per-block **confidence heatmap** in the diff pane after an AI resolution, with a legend and next/previous low-confidence navigation.
- Add an **explain-why popover** per resolved block showing the model's rationale and the original ours/theirs/base text, with per-block Accept / Use ours / Use theirs / Use base actions.
- Add an optional **post-resolution check** (formatter or type checker) configured in Options → AI or by the repository in `.gitgood/config.json`; a failed check blocks auto-staging and offers one AI retry with the check output.
- Add **Resolve remaining like `<file>`**: the user's manual resolutions in the current operation are fed to the model as worked examples for the remaining files.
- Repository-provided check commands require a one-time, per-repository trust confirmation and are shown verbatim before the first run (user-confirmed action).

## Capabilities

### New Capabilities

_None._

### Modified Capabilities

- `ai-conflict-resolution`: staging after resolution becomes conditional on the post-resolution check; result reporting gains per-block confidence display and per-block side selection; the resolution request gains worked examples and check output; new requirements for the check runner, trust gate and example capture.

## Impact

- Main process: `src/main/ai/resolver.ts` and `src/main/ai/prompts.ts` (examples and check output in the prompt), `src/shared/diff/conflicts.ts` (block ranges from `applyResolutions`), new `src/main/repo/config.ts` (reads `.gitgood/config.json`), `src/main/exec.ts` reused for the check command with `GIT_TERMINAL_PROMPT=0` and a 5-minute timeout, `src/main/ipc.ts` (new methods and manual-resolution capture on mark-resolved).
- Renderer: `DiffPane.tsx` and `TextDiff.tsx` (tint layer, gutter badges, legend), new `ResolutionPopover.tsx`, `ConflictsDialog.tsx` (confidence chips, sort, Resolve remaining like…, check status), `SettingsDialog.tsx` (check command, test button, repo-command toggle), a check-failed banner.
- Settings: `AiSettings.postResolveCheck`, `AiSettings.postResolveCheckFromRepo`; per-repo trust list in `state.json`.
- Commands: `git add` (existing mark-resolved), `git update-index --unresolve` (existing undo); the check command itself runs through the platform shell (`sh -c` or `cmd.exe /d /s /c`).
- No new runtime dependencies.
