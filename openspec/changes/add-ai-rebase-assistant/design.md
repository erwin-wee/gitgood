# Design

## Context

See proposal.md - Why. `compareRefs` in `src/main/git/log.ts` returns the commits ahead of a ref; `isCommitPushed` reports remote reachability. `src/main/git/operations.ts` already implements `squashCommits`, `reorderCommits`, `rewordCommit` and `dropCommit` through the sequence-editor shim, and `listTodo` throws on merge commits. Each operation rewrites SHAs, so a multi-step plan needs remapping between steps. `getCommitPatch` is introduced by `add-ai-explain-diff` and shared here.

## Goals / Non-Goals

**Goals:**
- Reuse the four existing rewrite operations unchanged.
- Validity of the plan guaranteed in code (completeness, squash targets, trailers).
- Every apply is previewable and reversible.

**Non-Goals:**
- Splitting a commit (see `add-ai-commit-splitting` for the working-tree case).
- Rebasing across merge commits.
- Suggesting a different base branch.

## Decisions

- **Step ordering: drops, then rewords, then reorders, then squashes.** This minimizes remapping: drops and rewords do not change relative order, reorders happen before squashes so squash targets are adjacent. Alternative: one generated todo file for the whole plan; rejected for now because the existing shim only handles single-operation todos and a single todo makes partial failure harder to report.
- **SHA remapping between steps.** After each step re-read `git log <base>..HEAD` and match commits by (author date, full message), falling back to position. Alternative: parse `git rebase`'s rewritten-list; rejected because the existing operations do not expose it.
- **Validation in a pure module** (`src/main/ai/rebasePlan.ts`): completeness, duplicates, squash target rules, trailer preservation (regex on `^[A-Za-z-]+: .+$` trailer lines), drop downgrade, caps, nothing-to-do detection.
- **Undo** records `git rev-parse HEAD` before the first step and resets hard when clean; the toast expires after ten minutes and is not offered if the start SHA is no longer reachable.
- **Dialog**: `xwide`, todo list on the left with action selector, message editor (summary and body), drag handle and rationale; preview on the right reusing History commit rows; non-dismissible while applying; conflicts hand off to the existing banner.

Types, IPC and event:

```ts
export type RebasePlanAction = 'pick' | 'squash' | 'reword' | 'drop';
export interface RebasePlanRow { sha: string; action: RebasePlanAction; squashInto: string | null; originalMessage: string; message: string; rationale: string; pushed: boolean }
export interface RebasePlan { id: string; base: string; startSha: string; rows: RebasePlanRow[]; warnings: string[]; model: string }
export interface RebaseApplyProgress { planId: string; step: number; total: number; phase: 'drop' | 'reword' | 'reorder' | 'squash' | 'done' | 'error' | 'conflicts'; message: string }
// ApiMethods
'ai.rebase.plan': (repoPath: string, base: string, shas: string[] | null) => Promise<RebasePlan>;
'ai.rebase.apply': (repoPath: string, plan: RebasePlan) => Promise<OperationOutcome>;
'ai.rebase.undo': (repoPath: string, startSha: string) => Promise<void>;
// EventPayloads
'ai.rebase.progress': RebaseApplyProgress;
```

Output schema:

```json
{
  "type": "object",
  "properties": {
    "rows": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "sha": { "type": "string" },
          "action": { "enum": ["pick", "squash", "reword", "drop"] },
          "squashInto": { "type": ["string", "null"] },
          "message": { "type": "string" },
          "rationale": { "type": "string" }
        },
        "required": ["sha", "action", "squashInto", "message", "rationale"],
        "additionalProperties": false
      }
    }
  },
  "required": ["rows"],
  "additionalProperties": false
}
```

Prompt intent: minimal, safe cleanup; squash only clear fixups; reword only uninformative or wrong messages keeping the author's voice, issue references and trailers; reorder only to bring a fixup next to its target or tests next to code; drop only empty commits or exact revert pairs; default pick. Inputs: base and branch names, commits oldest-first with sha, author, date, message, stat, patch excerpt (8,000 bytes each, 120,000 total, 60 commits), pushed flag, `truncated` flag.

## Risks / Trade-offs

- [Remapping by (date, message) mismatches identical commits] → fall back to position; abort the apply and restore start SHA if a step's expected commit cannot be found.
- [Conflicts mid-apply] → standard banner; Abort resets to start SHA.
- [Rewriting pushed commits] → flagged in pre-flight and toast; the later push goes through the existing force-push-with-lease confirmation.
- [Signatures lost] → warning when `commit.gpgsign` is true.
- [commit-msg hooks reject rewords] → stop and show output.
- [Windows] → reuses the sequence-editor shim; message files written with LF.

## Migration Plan

Additive; no data migration. Rollback removes the entry points; the existing operations are untouched.
