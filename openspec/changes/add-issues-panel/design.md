# Design

## Context

See proposal.md for motivation. The `GhClient` in `src/main/gh/gh.ts` already runs `gh` with JSON output (`json()` helper used by `prList`) and stdin bodies (`prComment`). `gh.issue.createUrl` exists but only opens the browser. `GitHubRepoDetails` exposes `hasIssuesEnabled`, `isFork` and `parent`. The PR dialog already has a sign-in card and rate-limit handling to reuse.

## Goals / Non-Goals

**Goals:**
- Reuse the `gh` runner and the existing dialog shell; no new runtime dependencies.
- Keep everything the model of "list → detail → action" that the PR dialog uses.

**Non-Goals:**
- Editing issue title or body, reactions, projects, Markdown rendering with images, issue notifications (see the notifications inbox change).

## Decisions

- **Use `gh issue` subcommands rather than `gh api`.** `gh issue list --json` handles pagination, `@me` filters and search syntax; `gh api` would need manual GraphQL. Milestones have no `gh` subcommand, so `gh api repos/{o}/{r}/milestones` is the one REST call.
- **Bodies via `--body-file -`.** Avoids Windows command-line length and quoting limits; the runner already passes stdin for PR comments.
- **Plain-text body rendering with linkified URLs.** Rendering Markdown/HTML from user content inside an Electron renderer is an XSS surface; text plus links is enough for finding the right issue.
- **Per-repository filter persistence in the app state file** (`issueFilters: Record<repoId, IssueFilter>`), matching how other per-repo preferences are stored.
- **Load more via search cursor.** `gh issue list` caps at 100; further pages use `--search "… sort:updated-desc updated:<<oldest seen>"`.

Commands:

| Purpose | Command |
| --- | --- |
| List | `gh issue list --repo owner/repo --state <s> --limit 100 --search "<q>" [--assignee @me] [--author @me] [--mention @me] [--label a,b] [--milestone m] --json number,title,state,author,labels,assignees,milestone,createdAt,updatedAt,commentsCount,url,body` |
| View | `gh issue view N --repo owner/repo --json …,comments` |
| Create | `gh issue create --repo owner/repo --title t --body-file - [--label …] [--assignee …]` |
| Close / reopen | `gh issue close|reopen N --repo owner/repo` |
| Comment | `gh issue comment N --repo owner/repo --body-file -` |
| Labels / milestones | `gh label list --repo … --json name,color,description --limit 200`; `gh api repos/{o}/{r}/milestones` |
| Templates | read `.github/ISSUE_TEMPLATE/*.md` and `.github/ISSUE_TEMPLATE.md`, parse YAML front matter |

Types and IPC (in `src/shared/types.ts` / `src/shared/ipc.ts`):

```ts
interface Issue { number; title; url; state: 'OPEN' | 'CLOSED'; author; labels: { name; color }[]; assignees: string[]; milestone: string | null; createdAt; updatedAt; commentsCount; body }
interface IssueComment { author; createdAt; body; url }
interface IssueFilter { search; state: 'open' | 'closed' | 'all'; assignee: 'any' | 'me'; author: 'any' | 'me'; mentioned: boolean; labels: string[]; milestone: string | null }
interface IssueTemplate { name; about: string | null; title: string | null; labels: string[]; body }

'gh.issue.list': (repoPath, filter: IssueFilter) => Promise<Issue[]>
'gh.issue.view': (repoPath, number) => Promise<Issue & { comments: IssueComment[] }>
'gh.issue.create': (repoPath, opts: { title; body; labels; assignees }) => Promise<{ number; url }>
'gh.issue.setState': (repoPath, number, state: 'open' | 'closed') => Promise<void>
'gh.issue.comment': (repoPath, number, body) => Promise<void>
'gh.labels': (repoPath) => Promise<{ name; color; description }[]>
'gh.milestones': (repoPath) => Promise<{ number; title }[]>
'gh.issue.templates': (repoPath) => Promise<IssueTemplate[]>
```

Renderer: `DialogState` gains `{ kind: 'issues'; number?: number }` and `{ kind: 'new-issue' }`; the commit-form store gets `appendDescription(text)`. Label chips use the GitHub colour with contrast-adjusted text in dark theme. Entry points: Repository menu, `Ctrl+Shift+I`, commit-form footer `#` button, branch dialog *Pick an issue…* link.

Branch slug: lowercase, replace non `[a-z0-9]` runs with `-`, trim hyphens, cap 60 chars, prefix `N-`.

## Risks / Trade-offs

- [Shortcut `Ctrl+Shift+I` may collide with an existing binding] → verify against `menu.ts` during implementation; fall back to another chord.
- [Rate limiting from frequent list refreshes] → classify HTTP 403 with `X-RateLimit-Reset`, show reset time, back off refreshes.
- [Large issue bodies or comment threads] → cap comments at the latest 20 and truncate body display with *Show more*.
- [Template front matter variations (YAML forms, `.yml` form templates)] → support `.md` templates only in this change; `.yml` issue forms are listed by name but open on GitHub.
