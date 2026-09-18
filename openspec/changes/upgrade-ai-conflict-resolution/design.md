# Design

## Context

See proposal.md for motivation. The resolver (`src/main/ai/resolver.ts`) already parses blocks with `parseConflicts`, requests `RESOLUTION_SCHEMA` output and applies it with `applyResolutions` from `src/shared/diff/conflicts.ts`, returning `ConflictResolutionResult` with per-block `rationale` and `confidence` and the `original` content for undo. The renderer shows a toast in `handleResolution` and reloads the working diff. Nothing today knows which lines each resolved block occupies, and `applyResolutions` does not return ranges.

## Goals / Non-Goals

**Goals:**
- Surface existing per-block data (rationale, confidence) in the diff pane without a second model call.
- Make a failed resolution visible immediately through a user- or repo-configured check.
- Reuse the user's own manual resolutions as few-shot examples inside the existing prompt builder.

**Non-Goals:**
- Learning across repositories or sessions.
- AST-based semantic merging.
- Running the check after manual resolutions (possible later toggle).

## Decisions

1. **Ranges come from `applyResolutions`, not from re-diffing.** Extend `applyResolutions` to return `{ content, ranges: Map<id, {start, end}> }` (0-based line indices in the resolved file). Alternative: diff the original and resolved text in the renderer, which is ambiguous when blocks resolve to identical text. `ConflictBlockResolution` gains `range`.
2. **Tints are a decoration layer in `TextDiff.tsx` keyed by new-side line number**, the same mechanism the review feature uses for gutter markers, so the renderer needs no new diff mode. Tints are cleared on `repo.changed` for that path because ranges drift once the file is edited.
3. **Per-block side selection rewrites from the `original` snapshot.** New IPC `ai.resolve.useSideForBlock(repoPath, path, original, blockId, side)` re-parses `original`, replaces one block, keeps the AI text for the others, and refuses if the on-disk content differs from the AI output (same guard as the resolver's concurrent-edit check). Alternative: editing the file in place by ranges, rejected because ranges become stale.
4. **Check runner uses `exec.ts` through the platform shell** (`sh -c` on POSIX, `cmd.exe /d /s /c` on Windows) because check commands are user-authored strings such as `npm run typecheck`. This is the only place GitGood runs a shell; it inherits `GIT_TERMINAL_PROMPT=0`, cwd = repo root, 5-minute timeout, and output tail capped at 4,000 chars. New `PostResolveCheckResult { command, ok, exitCode, outputTail, durationMs }` attached to `ConflictResolutionResult.check`.
5. **Repo config and trust.** New `src/main/repo/config.ts` reads `.gitgood/config.json` (`{ "postResolveCheck": string }`). Trust is a `trustedRepoConfigs: string[]` list in `state.json`, exposed as `repo.trustConfig(repoPath, trusted)`. Repo value wins over the setting only when `postResolveCheckFromRepo` is on and the repo is trusted.
6. **Examples live in the resolver instance, keyed by repo path and operation.** Captured in the `git.conflict.markResolved` IPC handler by reading the current file content and pairing it with the `original` the renderer already holds. `buildResolvePrompt` gains `examples?: ManualResolutionExample[]` and `checkOutput?: { command, tail }`; the system prompt is unchanged. New IPC `ai.resolveAllGuided(repoPath)`, `ai.resolve.examples`, `ai.resolve.clearExamples`. Cleared when `getStatus` reports `operation.kind === 'none'`.
7. **Ask AI to fix is a single retry** through the existing `resolveFile` path with `checkOutput` set; a second failure ends in the banner.

Types and IPC additions:

```ts
interface ConflictBlockResolution { id; rationale; confidence; range: { start: number; end: number } }
interface ConflictResolutionResult { /* existing */ check: PostResolveCheckResult | null; guidedBy: string[] }
interface ManualResolutionExample { path: string; original: string; resolved: string }
'ai.resolve.useSideForBlock', 'ai.resolve.runCheck', 'ai.resolve.examples', 'ai.resolve.clearExamples', 'ai.resolveAllGuided', 'repo.trustConfig'
AiSettings.postResolveCheck: string | null; AiSettings.postResolveCheckFromRepo: boolean
```

## Risks / Trade-offs

- [Running repo-authored shell commands] → per-repo trust confirmation showing the verbatim command; no elevation; timeout; declining disables the repo command.
- [Range drift after edits] → tints cleared on file change; side selection refuses when on-disk content differs.
- [Examples enlarge the prompt] → cap 3 examples, 12,000 bytes, trimmed to blocks plus 20 lines of context.
- [Check output may contain secrets] → only the tail is sent, and only on the explicit Ask AI to fix action.
- [Windows quoting for cmd.exe] → the command string is passed as a single argument with `/d /s /c`; documented in settings help.

## Migration Plan

Additive settings with defaults (`null`, `true`); existing `ConflictResolutionResult` consumers tolerate the new optional fields. No data migration.
