# Proposal

## Why

Reading unfamiliar diffs is the main time sink in code review and repository archaeology, and GitHub Desktop offers nothing beyond the diff and the message. GitGood already loads commit details, per-file diffs and full file content, which is exactly the context a plain-language explanation needs.

## What Changes

- Add an **Explain** action for a commit in History, for the selected file's diff in History or Changes, and for a selected line range in the diff.
- Show the explanation in a side panel next to the diff with sections for what changed, inferred intent, impact and things to double-check, with clickable references back to lines in the diff.
- Allow up to five follow-up questions about the same change in the panel.
- Provide Copy as Markdown including the commit SHA and paths.
- Read-only: no repository writes and no GitHub calls.

## Capabilities

### New Capabilities
- `ai-explain-diff`: plain-language AI explanation of a commit, a file diff or a selected range, with validated line references and follow-up questions.

### Modified Capabilities
<!-- none -->

## Impact

- Git commands: `git show --no-color --format= -M <sha> -- <path>` per file (byte-capped), `git log --max-count=5 --format=%h %s <sha>~1 -- <path>` for recent history per file; existing commit and diff wrappers for file and range scopes.
- AI backend: one structured call per explanation plus one per follow-up through the shared backend; new schema and prompt in `src/main/ai/prompts.ts`.
- Code touched: `src/main/git/log.ts` (commit patch helper, shared with `add-ai-rebase-assistant`), `src/main/ai/` (new explain service), `src/main/ipc.ts`, `src/shared/types.ts`, `src/shared/ipc.ts`, `src/renderer/src/components/HistoryTab.tsx`, `components/diff/DiffPane.tsx`, `components/diff/TextDiff.tsx`.
- No new runtime dependencies; no new settings.
