# Proposal

## Why

The cheapest moment to catch a leftover debug print, a pasted token or a commit that does not match its message is before the commit exists. GitGood already computes the exact patch that will be committed, including partial line selections, so an AI review of precisely that patch is one structured call away.

## What Changes

- Add a **Review changes** action to the Changes tab commit form that runs the AI finding engine (introduced by `add-ai-pr-review`) against the changes that would be committed, honouring partial selections.
- Show findings as gutter markers in the diff pane and in a findings strip above the commit form, with Dismiss, Copy suggestion, Open in editor and an explicit Apply to file for whole-line suggestions.
- Flag blockers on the Commit button without ever blocking the commit.
- Mark findings stale when a reviewed file changes and offer Re-review of only the stale files.
- Add an optional **Review before every commit** setting that runs the review on Commit and asks Commit anyway / Go back.
- Report when the typed commit summary contradicts the diff.

## Capabilities

### New Capabilities
- `ai-precommit-review`: AI review of the pending commit's patch with anchored findings, staleness tracking, optional suggestion application and an optional pre-commit gate.

### Modified Capabilities
<!-- none: the finding format and validation are defined by ai-pr-review and reused unchanged; the commit flow keeps its requirements and only gains an optional confirmation step -->

## Impact

- Git commands: `git diff --no-color --no-ext-diff -M HEAD -- <paths>` (or `HEAD~1` when amending, `--cached` during a merge), `git hash-object <path>` for staleness, `git ls-files -- '**/*test*' '**/*spec*'` for nearby-test hints; partial patches come from the existing partial-patch builder.
- AI backend: per-file structured calls through the shared backend with the PR review schema plus a commit-message match flag; reuses the review validation, skip rules and strictness setting from `add-ai-pr-review`.
- Code touched: `src/main/git/diff.ts` (partial-patch aware patch builder, exported worktree reader), `src/main/ai/review.ts` and `review-core.ts` (worktree target), `src/main/ipc.ts`, `src/shared/types.ts`, `src/shared/ipc.ts`, `src/renderer/src/components/ChangesTab.tsx`, `components/diff/TextDiff.tsx`, `components/dialogs/SettingsDialog.tsx`.
- New setting `reviewBeforeCommit` (default off). No new runtime dependencies. Depends on `add-ai-pr-review` being present.
