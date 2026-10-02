# Design

## Context

See proposal.md - Why. The Create pull request dialog already pre-fills the body from the PR template via `gh.pr.template`, knows base and head, and the AI backend (`AiBackend.complete` in `src/main/ai/backends.ts`) already produces schema-validated JSON for commit messages. `compareRefs` in `src/main/git/log.ts` returns the commits ahead of a ref with summary and body. The `reviewPostFooter` setting and the first-use disclosure notice are introduced by `add-ai-pr-review` and are reused here.

## Goals / Non-Goals

**Goals:**
- One structured AI call per draft, reusing the existing backend, prompt module and error classification.
- Template headings are guaranteed in code, not only by prompt.
- Works offline against local refs; GitHub access only enriches the draft with issue titles.

**Non-Goals:**
- Suggesting reviewers or labels.
- Re-drafting after new commits with a diff of the description.
- Localized templates.

## Decisions

- **Data gathering in the main process.** A new `getRangePatch(git, repoPath, base, head, maxBytes)` in `src/main/git/diff.ts` (sibling of `getPatchForFiles`) runs `git diff --stat=120` and `git diff` against the merge base (new `mergeBase` helper in `log.ts`). Alternative: build the diff in the renderer from per-file `FileDiff`s; rejected because the renderer would need every file loaded and the byte cap is easier to apply on raw output.
- **Issue references are parsed in the app, then filtered against the model output.** A pure helper extracts `#N`, `Fixes #N`, `owner/repo#N` from commit messages (skipping code spans) and records which ones carry a closing keyword. The model's `linkedIssues` are intersected with that set and `closes` is downgraded to `refs` when no commit used a closing keyword. Alternative: trust the model; rejected because invented or wrongly closing references are a real cost on GitHub.
- **Template integrity enforced post hoc.** Headings (`#`/`##`) are extracted from the template; if the body does not contain them in order, the body is rebuilt (model paragraphs under the first heading, rest of template verbatim) and the callout changes. Alternative: split the call per section; rejected as slower and no more reliable.
- **Issue titles via `gh issue view`.** New `GhClient.issueView(ref, number)` (also needed by `add-ai-pr-review`), capped at 5 issues, skipped when unauthenticated.
- **Result lands in existing editable fields.** No new dialog; the Replace / Keep mine / Append prompt is a small confirm dialog inside `CreatePullRequestDialog`.

Types and IPC (in `src/shared/types.ts` and `src/shared/ipc.ts`):

```ts
export interface PrDraftInput { base: string; head: string; existingTitle: string; existingBody: string }
export interface PrDraft {
  title: string;
  body: string;
  linkedIssues: { number: number; keyword: 'closes' | 'refs' }[];
  templateSectionsFilled: string[];
  truncated: boolean;
  model: string;
}
// ApiMethods
'ai.prDraft': (repoPath: string, input: PrDraftInput) => Promise<PrDraft>;
```

`ai.progress` is reused with `path` set to `<pull request>`; `ai.cancel` aborts.

Output schema:

```json
{
  "type": "object",
  "properties": {
    "title": { "type": "string" },
    "body": { "type": "string" },
    "linkedIssues": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": { "number": { "type": "integer" }, "keyword": { "enum": ["closes", "refs"] } },
        "required": ["number", "keyword"], "additionalProperties": false
      }
    },
    "templateSectionsFilled": { "type": "array", "items": { "type": "string" } }
  },
  "required": ["title", "body", "linkedIssues", "templateSectionsFilled"],
  "additionalProperties": false
}
```

Prompt inputs: branch name, base, commit subjects and bodies (cap 100; subjects only above 400), stat, diff (cap 120,000 bytes, `truncated` flag), template text or null (cap 6,000 chars, normalized to LF), linked issues with titles and state, existing title/body when Append was chosen. Body capped at 60,000 characters; a code fence wrapping the whole body is stripped.

## Risks / Trade-offs

- [Model rewrites template checkboxes] → checkbox lines are compared to the template and unticked unless the model ticked them and the diff touches matching paths; otherwise restored.
- [Huge branches blow the byte budget] → stat always sent in full, diff truncated with flag, commits summarized to subjects above 400.
- [Fork PRs where base is a remote-tracking ref] → merge base computed against the fetched ref; missing ref disables the action with a "fetch first" hint instead of fetching implicitly.
- [Secrets in the diff reach the provider] → shared first-use disclosure notice; no automatic drafting.
- [Windows argv handling] → branch names passed as separate argv entries; no shell.

## Migration Plan

Additive feature; no data migration. Rollback is removing the entry points; the setting shared with PR review stays.
