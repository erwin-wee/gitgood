# Proposal

## Why

A working session often ends with one large working tree mixing a refactor, a bug fix and formatting. Splitting it by hand means many rounds of hunk selection. GitGood already has hunk-level staging and AI commit messages; proposing the split is the missing step.

## What Changes

- Add **Split into commits with AI** to the Changes tab commit form and the Repository menu.
- The model proposes an ordered set of commits, each with a message and the hunks or whole files it contains; the proposal opens as an editable plan (drag hunks, reorder, merge, edit messages, delete).
- Apply creates the commits in order through the existing partial-patch commit path; nothing touches the index before Apply.
- Apply refuses when the working tree changed since the plan was made; a failing patch stops the sequence leaving earlier commits intact and nothing staged.
- Undo all restores the pre-split HEAD while keeping the changes in the working tree.

## Capabilities

### New Capabilities
- `ai-commit-splitting`: AI-proposed grouping of pending hunks into ordered commits with an editable plan, safe sequential application and undo.

### Modified Capabilities
<!-- none: the existing commit path is reused as-is -->

## Impact

- Git commands: per-file working diffs (existing), `git apply --cached` via the existing partial-patch path, `git add -- <path>` for untracked whole files, `git rev-parse HEAD` and `git hash-object` for staleness, `git reset --soft <startSha>` for undo.
- AI backend: one structured call through the shared backend; new schema and prompt in `src/main/ai/prompts.ts`; new `src/main/ai/splitter.ts`.
- Code touched: `src/shared/diff/patch.ts` (combined hunk selectors), `src/main/git/commit.ts`, `src/main/ipc.ts`, `src/shared/types.ts`, `src/shared/ipc.ts`, `src/renderer/src/components/ChangesTab.tsx`, new plan dialog, `src/main/menu.ts`.
- New event for apply progress. No new settings or runtime dependencies.
