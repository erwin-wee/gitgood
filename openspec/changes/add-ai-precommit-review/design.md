# Design

## Context

See proposal.md - Why. `add-ai-pr-review` introduces the finding engine: `ReviewFinding`, `ReviewRun`, per-file prompts with `[new:N]` line annotation, output validation (line exists on the new side, dedupe, size caps, fence stripping), skip rules, strictness and the max-files setting, in `src/main/ai/review.ts` and `review-core.ts`, with gutter markers in `TextDiff.tsx`. The Changes tab already builds the exact patch to commit through `buildStagePatch` (`src/shared/diff/patch.ts`) and `CommitOptions.partialPatches`.

## Goals / Non-Goals

**Goals:**
- Reuse the PR review engine unchanged; add only a worktree target and a commit-message input.
- Findings map to the patch that will land, not to the whole file.
- Any write to the working tree is a separate explicit action guarded by a content hash.

**Non-Goals:**
- Running linters or tests as part of the review.
- One-click fixing of all findings.
- Team rule sharing beyond the shared `.gitgood/review.md` guideline file.

## Decisions

- **Worktree target on `ReviewRun`.** Extend `ReviewRun.target` with `{ kind: 'worktree'; paths: string[]; partialPaths: string[]; indexSha: string }` where `indexSha` is the tree hash of a temporary index (`git write-tree` with `GIT_INDEX_FILE`) for whole-run staleness, plus per-file `git hash-object` hashes. Alternative: a separate run type; rejected because the panel, persistence and dismiss logic are shared.
- **Patch source.** Extend `getPatchForFiles` in `src/main/git/diff.ts` to accept `partialPatches: Record<string, string>` and to synthesize added-file patches for untracked files, so the model sees exactly what `createCommit` will apply. Alternative: review the whole file; rejected because findings would point at lines that will not be committed.
- **Context excerpt.** Export the private `readWorktree` helper in `diff.ts` and send up to 400 lines around the hunks.
- **Nearby tests hint.** `git ls-files -- '**/*test*' '**/*spec*'` filtered to directories of changed files, capped at 200 paths, passed as a list so the model can flag test gaps.
- **Schema.** The PR review per-file schema plus top-level `commitMessageMatches: boolean` and `commitMessageNote: string`. Validation is the shared `review-core` pipeline; untracked files use file line numbers as the new side.
- **Apply to file.** New `ai.review.applySuggestion(repoPath, runId, findingId)` in the main process: re-hash the file, compare with the recorded hash, split lines with the shared `splitLines`/`joinLines` to keep EOL, replace `[line, endLine]`, write, then let the watcher refresh status. Disabled for partially selected files because the file's lines differ from the patch's lines.
- **Gate.** `reviewBeforeCommit` on `AiSettings`; the Commit action in `state/actions.ts` runs the review first and opens a confirm dialog listing findings. Go back is a no-op.

Types and IPC:

```ts
// ReviewRun.target gains
| { kind: 'worktree'; paths: string[]; partialPaths: string[]; indexSha: string }
// ApiMethods
'ai.review.startWorktree': (repoPath: string, opts: { files: string[]; partialPatches: Record<string, string>; summary: string; description: string }) => Promise<ReviewRun>;
'ai.review.applySuggestion': (repoPath: string, runId: string, findingId: string) => Promise<void>;
// AiSettings
reviewBeforeCommit: boolean; // default false
```

Progress uses the existing `ai.review.progress` event; cancellation uses `ai.cancel`.

## Risks / Trade-offs

- [Partial-patch numbering differs from the file] → annotate from the patch, disable Apply for partial files, unit-test that numbering equals `buildStagePatch` output.
- [Model comments on lines outside the diff] → shared validation drops them and counts them.
- [Secrets sent to the provider] → shared first-use disclosure; prompt asks for security blockers on keys and tokens.
- [Hash race between review and Apply] → hash re-checked immediately before writing; refuse on mismatch.
- [CRLF files] → line numbers from the shared parser; writes use the file's detected EOL.
- [Merge commit must include everything] → review the index during a merge instead of the selection.

## Migration Plan

Additive. New setting defaults to off; no data migration. Rollback removes the entry point and setting.
