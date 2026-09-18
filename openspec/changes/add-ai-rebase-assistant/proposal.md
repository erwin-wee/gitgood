# Proposal

## Why

Branches reach the pull request stage carrying "wip", "fix typo" and "address review" commits. GitGood already automates interactive rebase, but the user still decides every step. The model is good at spotting fixups and writing messages; the app keeps every step reviewable and reversible.

## What Changes

- Add **Tidy up branch with AI** to the Branch menu and the History context menu (for a multi-selection).
- The model proposes an interactive-rebase plan for the commits ahead of the base branch: squash fixups into their parent, reword uninformative messages, reorder to group related work, drop empty or revert-pair commits. Default is to keep a commit as is.
- The plan is shown as an editable todo list with a preview of the resulting history; the user approves before anything is rewritten.
- Apply runs the existing squash, reword, reorder and drop operations in a computed order; conflicts use the standard banner; Undo restores the recorded start commit.
- Pushed commits are allowed but flagged, with a reminder that a force push with lease will be needed. The action is unavailable on the default branch and when merge commits are in range.

## Capabilities

### New Capabilities
- `ai-rebase-assistant`: AI-proposed branch cleanup plan (squash, reword, reorder, drop) applied through user-approved history rewriting with preview, conflict handling and undo.

### Modified Capabilities
<!-- none: existing squash/reword/reorder/drop operations are reused; their requirements do not change -->

## Impact

- Git commands: `git log <base>..HEAD`, `git show --no-color --format= --stat=120 <sha>`, `git show --no-color --format= -M <sha>` (byte-capped), `git rev-parse HEAD`, `git reset --hard <startSha>` for undo; the existing interactive-rebase automation through the sequence-editor shim.
- AI backend: one structured call through the shared backend; new schema and prompt in `src/main/ai/prompts.ts`.
- Code touched: `src/main/git/log.ts` (commit patch helper shared with `add-ai-explain-diff`, pushed detection), `src/main/git/operations.ts` (step applier and SHA remapping), `src/main/ipc.ts`, `src/shared/types.ts`, `src/shared/ipc.ts`, `src/main/menu.ts`, `src/renderer/src/components/HistoryTab.tsx`, new plan dialog.
- New progress event. No new settings; the existing force-push confirmation governs the later push. No new runtime dependencies.
