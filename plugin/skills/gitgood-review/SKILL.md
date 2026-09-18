---
name: gitgood-review
description: Fix the AI review findings that the GitGood desktop client exported for this repository. Use when the user asks to fix, address or work through GitGood review findings, mentions .git/gitgood/review or latest.md, or when a session-start note reports open GitGood findings.
---

# Fix GitGood review findings

GitGood (a desktop Git client) reviews pull requests, branches and pending commits with AI and exports the result for you into the repository's git directory. This skill walks through those findings and hands the result back to GitGood for verification. No CLI, MCP server or network access is needed: everything is plain files.

## Where the findings are

Run `git rev-parse --git-dir` from the repository (linked worktrees have their own git directory). Under it:

- `gitgood/review/latest.json` — the most recently finished review run, machine-readable. Read this one.
- `gitgood/review/latest.md` — the same run as Markdown with an instruction block, for humans and for agents started with a plain prompt.
- `gitgood/review/runs/<runId>.json|.md` — one immutable pair per run, kept for the last few runs.

If `latest.json` is missing, tell the user that GitGood has not exported a review for this repository yet and stop; do not invent findings.

## What is in `latest.json`

```jsonc
{
  "version": 1,
  "runId": "…",            // changes on every run
  "previousRunId": "…",    // earlier run for the same target, or null
  "repoPath": "…",         // native path of the repository
  "target": { "kind": "worktree" | "pr" | "branch", … },
  "verdict": "approve" | "comment" | "request-changes" | null,
  "summary": "…",
  "files": [{ "path": "src/app.ts", "status": "reviewed" | "skipped" | "failed", "reason": null }],
  "findings": [{
    "id": "…", "path": "src/app.ts", "line": 12, "endLine": null,
    "severity": "blocker" | "warning" | "nit",
    "category": "bug" | "security" | "performance" | "test-gap" | "readability" | "docs" | "style" | "intent-mismatch",
    "title": "…", "detail": "…",
    "suggestion": "replacement lines or null",
    "confidence": "high" | "medium" | "low",
    "dismissed": false     // true = the user dismissed it; skip these
  }],
  "rerun": { "url": "gitgood://review/rerun?repo=…", "command": "xdg-open '…'" }  // null for a pull request or branch review
}
```

Findings are already sorted blocker → warning → nit, then by path and line. Paths use forward slashes relative to the repository root.

## Procedure

1. Read `latest.json`. Note `runId` and `target`. Ignore findings with `"dismissed": true`.
2. Summarise to the user what you are about to fix: counts by severity and the files involved.
3. Work **one file at a time**, in the order the findings appear (severity first). For each finding:
   - Line numbers describe the file as it was when the review ran. **Once you have edited a file, trust the finding's `title` and `detail` over its `line`**, and locate the code by content.
   - Apply `suggestion` only when it still fits the surrounding code; otherwise fix the issue in your own way. Low-confidence findings deserve a second look before changing anything; skip one and say why if it is wrong.
   - Keep edits minimal and scoped to the finding.
4. **Do not commit, stage, stash, amend, rebase or push.** The user commits from GitGood. Read-only git commands are fine.
5. What to do when you are done depends on `rerun`:
   - **`rerun` is an object** (a pre-commit review, `target.kind` is `worktree`): run the command in `rerun.command`. It opens the `gitgood://review/rerun?repo=…` URL — `xdg-open` on Linux, `open` on macOS, `Start-Process` in PowerShell, `start "" "<url>"` in Command Prompt. GitGood must be running with this repository in its list; if the command errors or nothing happens within a few seconds, tell the user to press Re-review in GitGood.
   - **`rerun` is null** (a pull request or branch review): do **not** try to trigger a re-review. That review reads committed history, so it would report the same findings however much you fixed. List what you changed per finding and tell the user to commit in GitGood and press Re-review. You are done.
6. After triggering a re-review, poll `latest.json` every few seconds for up to two minutes, until `runId` differs from the one you started with and `finishedAt` is not null.
7. **Re-read `latest.json`.** Finding ids are not stable across runs, so compare by `path` and `title`, not by `id`. Report which of the original findings are gone, which remain (and why, if you skipped them), and anything new the re-review raised. If the new run's `target` differs from the one you started with (for example GitGood ran a pull request review in between), say so instead of comparing.

## Notes

- Never edit the files under `gitgood/review/` yourself; GitGood owns them and rewrites them on every run and on every dismissal.
- The export contains only what the reviewer produced: paths, line ranges, titles, details and suggested replacements. It never contains credentials.
- A `files[]` entry with `status: "skipped"` was not reviewed (lockfile, generated, over the size or file limit); do not treat those as clean.
