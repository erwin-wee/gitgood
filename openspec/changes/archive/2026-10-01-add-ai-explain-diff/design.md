# Design

## Context

See proposal.md - Why. `getCommit` and `getCommitFiles` in `src/main/git/log.ts` provide commit metadata and files; `getCommitFileDiff` and `getWorkingDiff` in `diff.ts` provide `FileDiff` with hunks and `newContent`/`oldContent`; the renderer already has a line-selection mechanism used for partial commits. The shared AI backend returns whole JSON, not streamed tokens. The PR review change introduces `[new:N]` line annotation in `review-core.ts`.

## Goals / Non-Goals

**Goals:**
- One explanation call per target, one call per follow-up, all through the shared backend.
- References are validated against parsed hunks so every link works.
- Same panel for commit, file and range scopes.

**Non-Goals:**
- Explaining an entire branch or PR (the PR review summary covers that).
- Token streaming.
- Persisting explanations across sessions.

## Decisions

- **Targets as a discriminated union.**

```ts
export type ExplainSource = { kind: 'commit'; sha: string } | { kind: 'working' } | { kind: 'stash'; ref: string };
export type ExplainTarget =
  | { kind: 'commit'; sha: string }
  | { kind: 'file'; source: ExplainSource; path: string }
  | { kind: 'range'; source: ExplainSource; path: string; hunkIndex: number; startLine: number; endLine: number };
export interface ExplainReference { path: string; line: number | null; label: string }
export interface Explanation { whatChanged: string; why: string; impact: string; watchOutFor: string[]; references: ExplainReference[]; truncated: boolean; model: string }
export interface ExplainFollowUp { question: string; answer: string }
// ApiMethods
'ai.explain': (repoPath: string, target: ExplainTarget) => Promise<Explanation>;
'ai.explain.followUp': (repoPath: string, target: ExplainTarget, history: ExplainFollowUp[], question: string) => Promise<string>;
```

- **Commit patch helper in main.** New `getCommitPatch(git, repoPath, sha, maxBytes)` runs `git show --no-color --format= -M <sha> -- <path>` per file, orders by change size, truncates largest first and returns the omitted list; shared with `add-ai-rebase-assistant`. Merge commits use the first parent (existing `parentOrEmptyTree` logic), root commits the empty tree. Alternative: one `git show` for the whole commit; rejected because per-file output makes the byte cap and omitted-file list straightforward.
- **Range scope built in the renderer.** The renderer passes the hunk subset and 40 lines of context from `newContent`/`oldContent`, avoiding a second diff read.
- **Recent history per file.** `git log --max-count=5 --format=%h %s <sha>~1 -- <path>` for up to 5 files, via `tryRun` so failures are non-fatal.
- **Reference validation reuses `review-core`.** The annotated diff gives new-side line numbers; references are filtered to known paths and existing new-side lines (or null line).
- **Follow-ups append Q/A pairs** to the same prompt with a `{ "answer": string }` schema; limit 5 enforced in the renderer and main.
- **In-memory cache** of the last 20 explanations per repo keyed by target and SHA; not persisted.
- **Panel placement.** Right side of `DiffPane.tsx`, resizable, width remembered in `localStorage` wrapped in try/catch.

Output schema:

```json
{
  "type": "object",
  "properties": {
    "whatChanged": { "type": "string" },
    "why": { "type": "string" },
    "impact": { "type": "string" },
    "watchOutFor": { "type": "array", "items": { "type": "string" } },
    "references": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": { "path": { "type": "string" }, "line": { "type": ["integer", "null"] }, "label": { "type": "string" } },
        "required": ["path", "line", "label"], "additionalProperties": false
      }
    }
  },
  "required": ["whatChanged", "why", "impact", "watchOutFor", "references"],
  "additionalProperties": false
}
```

Prompt inputs: scope description, commit metadata (commit scope), annotated diffs, file excerpts, recent history, branch name and cached PR title, `truncated` flag; follow-ups add prior Q/A pairs.

## Risks / Trade-offs

- [Model hallucinates references] → validate against parsed hunks; drop silently, no link rendered.
- [Huge commits] → byte cap with largest-first truncation and an omitted-file list; partial badge in the panel.
- [Inferred intent presented as fact] → the schema separates why from what and the prompt asks for hedged wording; the panel labels the section "Why (inferred)".
- [CRLF numbering] → numbering comes from the shared parser.
- [Panel crowding the diff] → resizable and collapsible; width persisted per viewer.

## Migration Plan

Additive; no data migration. Rollback removes the entry points and panel.
