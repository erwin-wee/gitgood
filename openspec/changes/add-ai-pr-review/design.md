# Design

## Context

See proposal.md for motivation. Constraints that shape the approach: AI calls go through `AiBackend.complete({ system, prompt, schema, model, effort })` in `src/main/ai/backends.ts` (Anthropic SDK or Claude Code CLI) and must return schema-validated JSON; the diff viewer renders parsed hunks from `src/shared/diff/parse.ts`; pull request data comes from `gh` in `src/main/gh/gh.ts`; there is no GitHub REST client library and no new runtime dependency is allowed.

## Goals / Non-Goals

**Goals:**
- Reuse the existing backend, prompt and error-classification plumbing; add one service, one pure helper module and one renderer view.
- Make every displayed finding provably anchored to a real line in the reviewed diff.
- Keep GitHub writes to a single, user-confirmed REST call.

**Non-Goals:**
- Agentic review where the model requests more files or runs tests (would change the backend contract to a tool loop).
- Replying to existing review threads or resolving conversations.
- Applying a suggestion directly to the working tree.

## Decisions

- **Per-file requests with a final summary call, concurrency 3.** Alternative: one request for the whole PR. Rejected because large PRs exceed the 64k output ceiling and a single failure would lose everything; per-file also gives natural progress and cancellation units.
- **Annotate every diff line with `[new:N]` prefixes** rather than asking the model to count. Alternative: send raw diff and trust line arithmetic. Rejected; models miscount, and the annotation makes validation exact.
- **Validation lives in a pure module** (`src/main/ai/review-core.ts`) with no Electron or git imports so it is unit-testable: annotation, new-side index, deleted-line remap within 3 lines, limits, fence stripping, marker rejection, duplicate merge, strict-mode low-confidence drop, skip rules, REST payload builder, linked-issue parsing.
- **Prefer local `git diff base...head` and `git show head:path`, fall back to `gh pr diff` and the contents API.** Local data allows context expansion and works for branch mode; `gh pr diff` output is parsed by `src/main/gh/prdiff.ts` into per-file entries with hunks when the commits are not present locally.
- **Backend factory extracted to `src/main/ai/provider.ts`** shared by the conflict resolver and the review service so both honour the same settings and cancellation.
- **Finding ids are a stable non-cryptographic hash** of path, line and title. Alternative: sha1 via Node crypto. Rejected to keep the helper module dependency-free; stability across runs is the only property needed.
- **`ai.review.start(repoPath, target, opts)` takes `files` (from the pre-flight) and `rereviewOf` (previous run id)** instead of separate methods. Re-review hashes each file's hunks and carries findings over for unchanged files.
- **`ai.review.get` returns the latest run for the target regardless of head SHA**; staleness is computed in the renderer by comparing the run's head SHA with `PullRequest.headSha` (new field from `headRefOid`) or the branch tip. Hiding the old run would hide the stale banner.
- **Runs persist under `userData/reviews/<repoId>/`**, latest five per repository, dismissals stored in the run file.
- **Posting uses `gh api -X POST repos/{o}/{r}/pulls/N/reviews --input -`** with `{ commit_id, event, body, comments: [{ path, line, side: "RIGHT", body }] }`, `start_line` only for ranges. Own-PR detection compares `gh api user` login with the PR author and restricts the event to COMMENT. A 422 triggers one retry with the failing comments folded into the body.
- **Native menu items are always present** because Electron menus cannot react to settings cheaply; choosing one with the provider disabled shows a toast. In-app buttons are hidden as the spec requires.
- **Review view replaces the main content area** (PR file list, diff, collapsible findings panel) while the Changes/History sidebar stays; column widths are clamped so the diff keeps room at narrow widths.
- **Cancellation reuses `ai.cancel`**, which aborts both the conflict resolver and the review service through the existing AbortController plumbing.

### Types and IPC

Types in `src/shared/types.ts`: `ReviewSeverity`, `ReviewCategory`, `ReviewFinding`, `ReviewRun` (with `cancelled`, `ownPullRequest`, `strictness`, per-file `hash`, full `CommitFile` per file, PR `title` and `url`), `ReviewTarget` (`{ kind: 'pr', number }` | `{ kind: 'branch', base }`), `ReviewPlan`, `PostReviewOptions`, `AiReviewProgressEvent`; `AiSettings.reviewStrictness`, `reviewMaxFiles`, `reviewPostFooter`; `PullRequest.headSha`.

Methods in `src/shared/ipc.ts`: `ai.review.plan`, `ai.review.start`, `ai.review.get`, `ai.review.dismiss`, `ai.review.post`, `gh.pr.diff`, `gh.pr.fileDiff`, `repo.diff.range`; event `ai.review.progress`.

### Schemas

Per-file output: `{ findings: [{ line, endLine, severity, category, title, detail, suggestion, confidence }], fileSummary }` with enums for severity (blocker, warning, nit), category (bug, security, performance, test-gap, readability, docs, style, intent-mismatch) and confidence (high, medium, low); all properties required, no additional properties. Summary output: `{ summary, verdict }` with verdict in approve, comment, request-changes; the blocker floor is enforced in code.

### Skip rules

Binary, image and submodule entries; files over 1,500 changed lines; lockfiles (`package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`, `Cargo.lock`, `go.sum`, `poetry.lock`, `Gemfile.lock`); `linguist-generated=true` paths from `.gitattributes`; `*.min.js`, `*.min.css`; `dist/`, `out/`, `build/`, `vendor/`.

## Risks / Trade-offs

- [False positives erode trust] → default strictness `strict`, low-confidence findings dropped, dropped count shown so the user sees the filter working.
- [Diff-only context misses cross-file breakage] → 400-line head-side excerpt per file; agentic follow-up deferred to a later change.
- [Secrets in diffs reach the provider] → first-run data notice on the pre-flight; the prompt asks the model to flag secrets as security blockers.
- [GitHub 422 on comment positions] → validation guarantees lines are in the diff; one retry folds comments into the body.
- [Large PRs cost and latency] → `reviewMaxFiles` cap, per-file skip rules, pre-flight shows the plan before sending.
- [Occluded window never paints in smoke tests] → the smoke harness paint wait has a 1.5 s timeout.

## Open Questions

- Whether posted inline comments should also carry the suggestion as a GitHub suggestion block (```suggestion fences) so reviewers can apply them in one click. Deferrable; does not change the specs.
