# Proposal

## Why

The pull request list shows title, author, checks and review decision, but deciding where to spend attention still means opening each PR. The metadata GitGood already fetches is enough for a one-line triage that says what a PR does, who it is waiting on and what to do next.

## What Changes

- Each PR row gains a cached **triage line**: one-sentence summary, a state chip (waiting on you, waiting on author, waiting on others, checks failing, ready to merge, draft, stale, conflicts) and a suggested next action.
- A **Summarize N pull requests** button generates lines for PRs lacking a fresh cache entry, batched, with progress and cancellation.
- A **Waiting on you** filter and a toolbar badge with the count.
- Deterministic state rules in code override the model where metadata is decisive; lines are cached per PR `updatedAt` and evicted for closed or merged PRs.
- Next actions only open existing dialogs; nothing is merged, reviewed or commented automatically.

## Capabilities

### New Capabilities

- `ai-pr-triage`: per-PR AI triage lines, deterministic state classification, caching, waiting-on-you filter and badge.

### Modified Capabilities

_None._

## Impact

- Main process: extend `PR_FIELDS` in `src/main/gh/gh.ts` with `commits`, `files`, `reviews`, `latestReviews`, `comments` (counts and latest author/state), `headRefOid`; triage service next to `src/main/ai/resolver.ts` with prompt and schema in `src/main/ai/prompts.ts`; `src/main/ipc.ts` methods `ai.triage.get`, `ai.triage.run`, `ai.triage.clear`, event `ai.triage.progress`; persistence under `userData/triage/<repoId>.json`.
- Commands: `gh pr list --json <fields>` (existing), `gh pr checks` for failing check names only, signed-in login from `ToolsState` or `gh api user`.
- Renderer: PR list rows and header in `GitHubDialogs.tsx`, toolbar PR button badge in `Toolbar.tsx`, settings `AiSettings.triageAutoRefresh` and `triageIncludeDiffStat`.
- No new runtime dependencies.
