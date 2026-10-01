# Design

## Context

See proposal.md - Why. `getWorkingDiff` in `src/main/git/diff.ts` returns per-file hunks; `buildStagePatch(src, selector)` in `src/shared/diff/patch.ts` produces a patch for selected hunks or lines, and `createCommit` in `src/main/git/commit.ts` applies `CommitOptions.partialPatches` with `git apply --cached` (atomic per patch) before committing. Untracked files are staged whole via `stageFiles`.

## Goals / Non-Goals

**Goals:**
- Reuse the manual partial-commit path exactly, so the split is as safe as committing by hand.
- Plan integrity enforced in code, independent of the model.
- Every step reversible immediately after.

**Non-Goals:**
- Sub-hunk (line-level) splitting.
- Verifying intermediate commits build or pass tests.
- Splitting existing commits in History (see `add-ai-rebase-assistant`).

## Decisions

- **Hunk identity computed in main.** `hunkId = sha1(path + '\n' + hunk.header + '\n' + lines.join('\n')).slice(0, 12)` in a new `src/main/ai/splitter.ts`; ids are stable across whitespace-only header differences. Alternative: index-based ids; rejected because the model may reorder and indices shift when files change.
- **Application via `createCommit`.** For each planned commit, build `partialPatches[path]` by concatenating `buildStagePatch(src, selectHunk(i))` for its hunks (or a combined selector) and `files` for whole-file assignments; call `createCommit` sequentially. Alternative: drive `git add -p`; rejected as interactive and non-portable.
- **Whole-file-only cases.** Untracked, renamed, deleted and typechange entries are assigned whole because a partial patch cannot represent them safely.
- **Staleness and undo.** Record `git rev-parse HEAD` and `git hash-object` per included file at plan time; Apply refuses on mismatch. Undo runs `git reset --soft <startSha>` then unstages all. Alternative: `reset --hard` with a stash; rejected as riskier.
- **Ordering.** Commits are applied in the returned order; dependency cycles are not detected, a non-applying patch fails loudly and stops.
- **Dialog.** `xwide` dialog: commit cards with drag handles on the left, read-only `TextDiff` preview on the right, footer with Re-propose, Apply N commits, Cancel; non-dismissible while applying.

Types, IPC and event:

```ts
export interface SplitHunk { id: string; path: string; hunkIndex: number; header: string; additions: number; deletions: number }
export interface SplitPlanCommit { id: string; summary: string; description: string; hunkIds: string[]; wholeFiles: string[]; rationale: string }
export interface SplitPlan { id: string; startSha: string; fileHashes: Record<string, string>; hunks: SplitHunk[]; commits: SplitPlanCommit[]; unassigned: string[]; warnings: string[]; model: string }
export interface SplitApplyProgress { planId: string; index: number; total: number; sha: string | null; phase: 'staging' | 'committing' | 'done' | 'error'; message: string }
// ApiMethods
'ai.split.plan': (repoPath: string, files: string[]) => Promise<SplitPlan>;
'ai.split.apply': (repoPath: string, plan: SplitPlan) => Promise<{ shas: string[] }>;
'ai.split.undo': (repoPath: string, startSha: string) => Promise<void>;
// EventPayloads
'ai.split.progress': SplitApplyProgress;
```

Output schema:

```json
{
  "type": "object",
  "properties": {
    "commits": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "summary": { "type": "string" },
          "description": { "type": "string" },
          "hunkIds": { "type": "array", "items": { "type": "string" } },
          "wholeFiles": { "type": "array", "items": { "type": "string" } },
          "rationale": { "type": "string" }
        },
        "required": ["summary", "description", "hunkIds", "wholeFiles", "rationale"],
        "additionalProperties": false
      }
    }
  },
  "required": ["commits"],
  "additionalProperties": false
}
```

Prompt intent: smallest number of coherent commits grouped by purpose, dependent hunks together, imperative summaries ≤ 72 chars, one-sentence rationale; untracked files marked as unsplittable. Inputs: branch, hunks with id, path, header, annotated body, language, `truncated` flag. Budget 150,000 bytes; above it, headers and stats only.

## Risks / Trade-offs

- [Intermediate commit does not compile] → out of scope to verify; the rationale and preview let the user reorder before applying.
- [Working tree edited during planning] → hashes recorded at plan time; Apply refuses on mismatch.
- [Patch fails mid-sequence] → `git apply --cached` is atomic per patch, so nothing is staged for the failed commit; earlier commits remain and the dialog names the failure.
- [Hooks reject a commit] → sequence stops, hook output shown.
- [CRLF and no-newline-at-EOF] → handled by `buildStagePatch` today; covered by existing tests.
- [Windows] → patch text via stdin to `git apply --cached`, as today; no shell.

## Migration Plan

Additive; no data migration. Rollback removes the entry points.
