# Design

## Context

See proposal.md. `GhClient.prList` already fetches `PR_FIELDS` and the renderer polls PRs on the auto-fetch interval. The triage service reuses that list, adds one `gh pr checks` call per PR with failures, and sends batches to `AiBackend.complete` with a JSON schema.

## Goals / Non-Goals

**Goals:**
- Zero cost on repeat opens through an `updatedAt` cache.
- Deterministic states where metadata is decisive; the model adds only the summary and judgment calls.

**Non-Goals:**
- Cross-repository inbox (see `add-notifications-inbox`).
- Reading diffs for summaries (later opt-in for small PRs).
- Team dashboards.

## Decisions

1. **Extend `PR_FIELDS`** with `commits`, `files`, `reviews`, `latestReviews`, `comments`, `headRefOid`; parse counts and latest author/state only into `PullRequest`. Alternative: a separate `gh pr view` per PR, rejected for rate-limit cost.
2. **Rules engine in code** (`classifyTriageState(pr, login)`) runs before and after the model call: before, to compute the decisive states; after, to override. Merge downgrade uses `mergeable === 'MERGEABLE'`, checks passed and `reviewDecision === 'APPROVED'`.
3. **Batching**: 15 PRs per call, sequential batches so cancellation is clean between them; missing numbers retried individually once.
4. **Persistence** in `userData/triage/<repoId>.json` as `Record<number, PrTriage>`; eviction on list refresh (closed/merged) and by `generatedAt` age > 30 days.
5. **Badge** reuses the existing PR poller: after each refresh the renderer recomputes the waiting-on-you count from cached lines plus the deterministic rules.

Schema:

```json
{ "type": "object",
  "properties": { "items": { "type": "array", "items": { "type": "object",
    "properties": { "number": { "type": "integer" }, "summary": { "type": "string" },
      "state": { "enum": ["waiting-on-you", "waiting-on-author", "waiting-on-others", "checks-failing", "ready-to-merge", "draft", "stale", "conflicts"] },
      "reason": { "type": "string" },
      "nextAction": { "enum": ["review", "checkout", "view-checks", "merge", "rebase", "ping-author", "none"] } },
    "required": ["number", "summary", "state", "reason", "nextAction"], "additionalProperties": false } } },
  "required": ["items"], "additionalProperties": false }
```

Types and IPC:

```ts
type TriageState = 'waiting-on-you' | 'waiting-on-author' | 'waiting-on-others' | 'checks-failing' | 'ready-to-merge' | 'draft' | 'stale' | 'conflicts';
interface PrTriage { number; updatedAt; headSha; summary; state: TriageState; reason; nextAction; model; generatedAt }
'ai.triage.get'(repoPath) → Record<number, PrTriage>
'ai.triage.run'(repoPath, numbers: number[]) → Record<number, PrTriage>
'ai.triage.clear'(repoPath) → void
event 'ai.triage.progress': { repoPath; done; total }
AiSettings.triageAutoRefresh: boolean (default false); AiSettings.triageIncludeDiffStat: boolean (default true)
```

## Risks / Trade-offs

- [PR bodies contain sensitive text] → same first-use data notice as other AI features; bodies capped at 1,500 chars.
- [Many open PRs] → batches of 15 with progress and cancel; a 100-PR repo is 7 calls.
- [gh rate limits] → reuse the list call; `checks` only for PRs with failures.
- [Timezone drift in staleness] → computed in main from ISO timestamps.
- [Model contradicts metadata] → deterministic override rules.
