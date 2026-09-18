# GitGood

A GitHub Desktop–style Git client for Windows (and macOS/Linux) built with Electron. Instead of bundling its own Git and GitHub API client, GitGood drives the **`git`** and **`gh`** command-line tools you already have. Signing in once with the GitHub CLI's OAuth device flow is all that is needed to clone, fetch, pull, push and manage pull requests — `gh auth setup-git` wires Git's credential helper so HTTPS remotes just work.

It also adds **one-click AI merge conflict resolution** powered by Claude: pick a conflicted file (or all of them) and GitGood asks the model to reconcile both sides of every conflict block, writes the result, marks the file resolved, and lets you review or undo it.

## Features

Everything you expect from GitHub Desktop, mapped onto `git`/`gh`:

- **Repositories**: clone from your GitHub repositories (personal, collaborator and organization repos) or any URL, create new repositories with README/.gitignore/license templates, add existing ones, aliases, remove (optionally to the Recycle Bin), grouped repository list with ahead/behind indicators.
- **Worktrees** (Repository menu or `Ctrl+Shift+W`): list every worktree of the current repository with badges for main/locked/prunable and uncommitted changes; add one for an existing branch, a new branch, or a detached commit; open, show in the file manager, open in editor/terminal, lock/unlock, remove (with a second confirmation for dirty worktrees) and prune stale entries. Worktrees appear nested under their main repository in the repository list, each with its own ahead/behind indicator; checking out a branch already active in another worktree offers to open it instead.
- **Submodules** (Repository menu): a dialog lists every submodule (including nested ones) with its state — up to date, not initialized, modified, differs from recorded, conflicted or missing — plus recorded/checked-out commits and resolved URL; initialize and update all, update or open an individual submodule as its own nested repository, sync URLs, and show in the file manager. A banner after cloning or opening a repository offers to initialize any uninitialized submodules, and the diff pane's submodule summary gains **Update to recorded commit** and **Open submodule**.
- **Git LFS**: pointer files are labelled with a chip in the Changes and History file lists, and the diff pane shows the object size and both object identifiers (with an image diff when both versions are downloaded locally) instead of a binary placeholder, offering **Download** when the object is missing. A banner explains when a repository uses LFS but the extension isn't installed. The **Git LFS** dialog (Repository menu) shows install/hook status, tracked patterns, lets you track/untrack patterns, fetch all or pull objects with progress, and prune unreferenced local objects after a dry-run confirmation.
- **Changes**: working-tree file list with include/exclude checkboxes, **partial commits by selecting individual lines or hunks**, discard files or selected lines (moved to the Recycle Bin), ignore file/extension, stash selected files or all changes, commit form with summary/description, co-authors, amend, 72-character warning, **AI-generated commit messages**, **AI review of the pending commit** before it exists, and **AI commit splitting** to turn one mixed working tree into an ordered, editable set of coherent commits.
- **Stashes**: a dedicated view (Changes tab, Repository menu, or Ctrl+Shift+S) lists every stash — including ones created from the terminal — with file counts and an untracked-files indicator; inspect a stash's files (including untracked ones) and diffs, apply, pop, drop with confirmation, create a branch from a stash, or stash just the selected files. Stash actions are addressed by commit SHA, so dropping one entry always targets the right one even after others are dropped.
- **History**: searchable commit list (message, author, SHA) with a **content/regex search syntax** (`content:`, `regex:`, `path:`, `author:`, `after:`, `before:`, `all:`, freely combined with plain text and a filter popover that stays in sync with it) to find when a piece of code was added, changed or removed — matching commits' file list narrows to the files that matched and the diff pane highlights the first matching line; searches are cancellable, debounced, and report invalid regexes inline. Commit details with per-file stats, revert, cherry-pick to another branch, create branch/tag from commit, checkout commit, **squash**, **reorder by drag and drop**, edit message (reword), drop commit, undo last commit, amend. **File history** scopes the commit list to one file and follows renames; from a commit you can view the file as it was, blame it, or restore that version to the working tree (with a stash-first offer if it has uncommitted changes). Select text in a diff and choose **Search history for selection** (`Ctrl+Alt+F`) to jump straight to its `content:` search.
- **Blame**: toggle a per-line blame gutter (`Alt+B`, the diff pane's person icon, or a file's context menu) for any text file in Changes or History — coloured by commit age, with a card per block for the commit summary, author, **Open commit**, **Copy SHA** and **Blame at parent** (re-blames before that commit, following renames). Hidden for binary, image, submodule and too-large files.
- **Branches**: create (based on default or current branch), rename, delete (with remote), switch with stash-or-carry handling of uncommitted changes, merge, squash merge, rebase, compare, update from default branch, publish, force push with lease (with confirmation), background fetch, and **Tidy up branch with AI** to squash fixups, reword and reorder commits before opening a pull request.
- **Commit signing** (Options → Git): configure GPG or SSH commit/tag signing at repository or global scope, with key detection (GPG keyring or `~/.ssh`), a **Test signing** action, and a commit-form indicator when the effective config signs. A failed signing attempt shows a dialog with **Retry**, **Commit unsigned this time** and **Open signing settings** — including while a squash or reword is paused mid-rebase; GitGood never reads or stores a passphrase. History can optionally verify and show good/bad/unknown-key/expired/revoked signature badges per commit (opt-in, since verification slows large histories).
- **Repository health** (Repository menu or `Ctrl+Shift+K`): four independently loading cards. **Large files** lists the 25 largest blobs in history (path, size, first commit, HEAD presence, whether LFS would apply) with copy-path, add-to-.gitignore and track-with-LFS actions. **Stale branches** flags merged, inactive (configurable) and upstream-gone local branches for bulk deletion — current/default/protected branches are never selectable — with per-branch failure reporting and an Undo toast. **Unpushed work** lists, across every repository on disk, branches ahead of their upstream, unpublished branches, stashes and uncommitted changes, with one click to jump to a repository and branch; the same data drives a Welcome-screen card and an opt-in warning dot on repository rows. **Housekeeping** shows `.git` size, loose/pack/garbage object counts and last gc time, with two-step-confirmed gc, remote-tracking prune and reflog expiry (disabled mid-operation).
- **Pull requests** (via `gh`): list open PRs with check status, check out a PR (including forks), create PRs (with template pre-fill, draft, or on GitHub.com — or **drafted with AI** from the branch's commits and diff), view checks, approve/comment/request changes, mark ready, merge (merge/squash/rebase), close/reopen, and **review with AI**: findings anchored to diff lines, shown as gutter markers and a findings panel, optionally posted to GitHub as a review with inline comments. The same review runs locally on the current branch against its base, without GitHub. The list also carries an **AI triage** line per pull request (state chip, one-sentence summary and a suggested next action) — see below.
- **AI release notes** (Repository menu, or a tag's context menu in History): pick a commit range and generate a categorized, reference-checked changelog — every bullet cites a pull request or commit in the range, with an unreferenced-items review list — then copy it, insert it into `CHANGELOG.md`, or publish a GitHub release (draft by default). Works as a plain commit-list export even with AI turned off.
- **Notifications inbox** (the toolbar bell, View menu, or `Ctrl+Shift+J`): polls your GitHub notifications — review requests, failing checks, mentions, assignments, comments and state changes — grouped by repository with a reason chip, honouring the server's own poll interval and conditional requests so quota is never wasted, and pausing while the window has been unfocused for 30 minutes. Click a pull request notification from a repository already in GitGood to open it in place (anything else opens on github.com); mark items read, mark all read (confirmed once), unsubscribe, filter to review requests/failures/mentions or only your own repositories, and refresh. Shows a taskbar/dock/launcher badge with the unread count, and desktop alerts for enabled categories while the window is unfocused. Explains itself and offers a one-click fix when the token is missing notifications access, you're signed out, rate-limited, or offline (showing the last cached list).
- **Issues** (Repository menu, `Ctrl+Shift+L`, or the commit form's `#` button): browse, search and filter (state, assigned/created/mentioned, labels, milestone — remembered per repository) the current repository's issues; view an issue's labels, milestone, assignees, body and latest comments (rendered as plain text with clickable links, never Markdown or HTML); **Reference in commit** appends `Fixes #N`/`Refs #N`/`Closes #N` to the commit description, **Create branch for issue** pre-fills the new-branch dialog with a slug like `123-fix-login-timeout`; close (with a one-time confirmation) or reopen, comment, and create issues from the repository's `.github/ISSUE_TEMPLATE` templates. Forks offer a toggle to browse the parent repository's issues instead. Explains itself when issues are disabled, you're signed out, or GitHub rate-limits the request.
- **Diffs that are easy to read**: unified or side-by-side, syntax highlighting for ~50 languages, word-level change highlighting inside modified lines, expandable context, hide whitespace, line wrapping, adjustable font size, image diffs (2-up, swipe, onion skin, difference), binary and submodule summaries.
- **Explain with AI**: plain-language explanation of a commit (History header/context menu), a file's diff (Changes/History diff pane), or a selected range of lines (right-click a diff selection) — what changed, the inferred intent, its impact, and things to double-check, with clickable references that scroll the diff to the cited line, up to five follow-up questions, and **Copy as Markdown**. Read-only: nothing is written to the repository or GitHub.
- **AI error explanation**: the error dialog's collapsible **Explain with AI** row turns a failed git/gh command into a plain-language cause and up to three fixes, each either a one-click action GitGood already exposes (with its usual confirmation) or a copy-only command with **Run in terminal**; tokens and credentials are scrubbed before anything is sent.
- **AI command palette** (`Ctrl+K`, or Repository → **Ask GitGood…**): fuzzy-matches GitGood's own menu actions first, or turns a plain-language request into a previewed, numbered plan of exact `git` commands that only runs after confirmation, behind a strict allowlist policy that decides executability and risk independently of the model — see below.
- **Conflicts**: banner and dialog listing conflicted files (sorted with any low-confidence resolution first, and a per-file confidence/check summary), per-block **Accept ours / theirs / both / base**, whole-file ours/theirs, open in editor, mark resolved, continue/abort merge, rebase (with skip), cherry-pick and revert — plus **Resolve with AI** per file or for all files at once, confidence-tinted results with an explain-why popover per block, an optional post-resolution check, and **Resolve remaining like `<file>`** once you've resolved one by hand.
- **Integrations**: open in VS Code, Cursor, Sublime, Notepad++, Visual Studio, JetBrains IDEs and more; open in Windows Terminal, PowerShell, Command Prompt or Git Bash; show in Explorer; view on GitHub; create issue.
- **Portable settings** (Options → Advanced, or File → Export/Import Settings…): export preferences, the repository list and integration choices to one JSON file, with a section checklist and an import preview (adds/changes/unchanged per section, merge or replace) — timestamped backups are kept before a replace. Optional **sync through a secret GitHub gist** (created or reused via the signed-in GitHub CLI): the sync card always shows which side changed since the last sync and lets you upload or download, never merging silently; disconnect keeps or deletes the gist. The export never includes your API key, saved GitHub credentials, tool paths or window position.
- **Updates** (Help → Check for Updates…, or Options → Advanced): checks the GitHub releases feed (via `electron-updater`) on launch and every 6 hours for a newer stable or (on the beta channel) prerelease version — never a downgrade — then downloads it in the background and offers **Restart to update** from a banner, the Help menu and the About dialog; automatic checking, automatic download and the release channel are configurable. Installing is blocked while a git operation or AI task is running, and reopens the same repository afterwards. Disabled in development builds, portable Windows builds, unsigned macOS builds and a read-only AppImage, which show *Updates unavailable in this build* instead — see `openspec/changes/add-auto-update`.
- Light/dark/system theme, keyboard shortcuts mirroring GitHub Desktop, native menus.

## Download

Grab the latest release for your platform from the [Releases page](https://github.com/erwin-wee/gitgood/releases/latest):

- **Windows**: `GitGood-Setup-<version>.exe` (NSIS installer)
- **macOS**: `GitGood-<version>.dmg` (unsigned — see note below)
- **Linux**: `GitGood-<version>.AppImage` — `chmod +x` and run

Releases are unsigned. Windows will show a SmartScreen "unknown publisher" prompt (**More info → Run anyway**) the first time you launch a new version. macOS Gatekeeper may refuse to open the `.dmg` outright; if so, download the `.zip` instead and right-click → **Open** on the extracted app. Signing/notarization is a planned follow-up, not yet set up.

Once installed, GitGood checks for updates automatically, downloads them in the background, and offers **Restart to update** (Help → Check for Updates…, or Options → Advanced to configure) — see **Updates** above.

## Prerequisites

| Tool | Why | Windows install |
| --- | --- | --- |
| [Git](https://git-scm.com) 2.30+ | All repository operations | `winget install --id Git.Git -e` |
| [GitHub CLI](https://cli.github.com) 2.40+ | Sign-in, credential helper, pull requests, repository listing | `winget install --id GitHub.cli -e` |
| [Claude Code CLI](https://docs.anthropic.com/claude-code) (optional) | AI features without an API key, using your Claude sign-in | `npm install -g @anthropic-ai/claude-code` |

GitGood looks for the tools on `PATH` and in the usual install locations; you can also point it at specific executables under **Options → Advanced**.

## Getting started (development)

```bash
npm install
npm run dev          # electron-vite dev server with hot reload
npm test             # vitest: pure unit tests plus fixture tests against real temp git repos
npm run test:unit    # just the pure unit tests (diff parser, patch builder, git output parsers, ...)
npm run test:fixture # git/gh wrapper tests against real temporary repos and a stub gh/claude on PATH
npm run test:smoke   # builds the app and drives it offscreen (no visible window) through real user flows; GITGOOD_SMOKE_SHOW=1 to watch
npm run typecheck    # main + renderer TypeScript
```

## Building for Windows

```bash
npm run dist:win   # produces release/<version>/GitGood-Setup-<version>.exe (NSIS installer)
```

`npm run dist:linux` builds an AppImage and `npm run dist:mac` a dmg/zip. Builds are unsigned; add your certificate configuration to `electron-builder.yml` for signed releases.

Packaging notes:

- Build the Windows installer on Windows (`npm run dist:win`). Cross-building it from Linux/macOS also works but needs `wine` installed for electron-builder's NSIS step; without it you still get `release/<version>/win-unpacked/` (a runnable portable folder) but no `Setup.exe`.
- A `.deb` target can be added back to `linux.target` in `electron-builder.yml`, but electron-builder's `fpm` needs `libcrypt.so.1` (`libxcrypt-compat` on Arch-based systems) on the build machine.
- The installer registers the `gitgood://` and `x-github-client://` URL schemes, so GitHub's "Open with GitHub Desktop" buttons open the repository in GitGood (or offer to clone it).

### Cutting a release

Bump `version` in `package.json`, merge to `main`, then push a tag matching it (`git tag v0.2.0 && git push origin v0.2.0`). `.github/workflows/release.yml` builds Windows/macOS/Linux in parallel and publishes the artifacts to a **draft** GitHub Release (`electron-builder.yml`'s `publish` block) — review the draft, add notes, and publish it manually from the Releases page.

## Signing in to GitHub

**Options → Accounts → Sign in to GitHub.com** runs `gh auth login --web`. GitGood shows the one-time code, opens `github.com/login/device` in your browser and waits for approval. When it completes, GitGood runs `gh auth setup-git`, so Git pushes and pulls to GitHub over HTTPS use the same token. Nothing else is stored by the app.

## AI conflict resolution

Configure under **Options → AI**:

- **Provider**
  - *Anthropic API*: paste an API key. It is stored encrypted with the operating system's credential store (DPAPI on Windows, Keychain on macOS) via Electron `safeStorage`. Without a stored key, the SDK falls back to the `ANTHROPIC_API_KEY` environment variable or an `ant auth login` profile.
  - *Claude Code CLI*: reuses your existing `claude` sign-in and plan; no key required. Runs `claude -p` headless with tools disabled and a JSON schema for the output.
- **Model**: defaults to `claude-opus-5`. Claude Fable 5.1, Sonnet 5, Opus 4.8 and Haiku 4.5 are offered as presets; any model ID can be typed.
- **Effort**: `low` … `max` (default `high`).

How a resolution works: GitGood parses the conflict markers (including `diff3`/`zdiff3` base sections), sends each conflict block with 40 lines of surrounding context, the merge/rebase context and the recent commit subjects on both sides, and requests a structured JSON answer with one resolution and a one-sentence rationale per block. It validates that no markers remain, rewrites the file preserving line endings, and (by default, and only when any configured post-resolution check passes) runs `git add`. **Undo** restores the original conflicted content via `git update-index --unresolve`.

For `claude-opus-5` and Claude Fable models the request also enables Anthropic's server-side refusal fallback, so a false-positive safety decline is retried automatically on a fallback model within the same call.

**Confidence, explain-why and per-block fixes.** Each resolved block's line range is tinted by confidence (high/medium/low) directly in the diff pane, with a legend matching the toast's low-confidence count and next/previous navigation between low-confidence blocks. Clicking a tinted block's gutter badge opens a popover with the model's rationale and the original ours/theirs/base text, plus **Accept**, **Use ours**, **Use theirs**, **Use base** and **Edit in editor** — choosing a side rewrites only that block (refused if the file changed on disk since it was resolved) and leaves the file modified but unresolved until you confirm it.

**Post-resolution check.** Set a command under Options → AI → *Post-resolution check* (or **Test command** to try it first) to run a formatter or type checker in the repository root after each successful resolution; a repository can also provide one via `.gitgood/config.json` (`{ "postResolveCheck": "..." }`), which requires a one-time trust confirmation showing the verbatim command and repository path before it ever runs, and stays disabled if you decline. A failing or timed-out check blocks auto-staging (the resolved content stays on disk, unstaged) and shows a banner with **Show output** and a single **Ask AI to fix** retry that feeds the failure back to the model.

**Resolve remaining like `<file>`.** Once you resolve a file by hand (editing it, or picking a side per block) in the current merge/rebase/cherry-pick/revert, the conflicts dialog offers to resolve the rest guided by that worked example — the manual before/after pairing (trimmed to the conflict and a little context) is sent along with each remaining request and the result is labelled *guided*. Examples live only in memory for the current operation and are discarded when it ends.

## AI pull request review

**Review with AI** is available from the pull request list, the pull request details dialog, the *Branch* menu (*Review Pull Request with AI…*, `Ctrl+Shift+R`, and *Review Branch with AI…*) and the create-PR dialog. It is hidden when the AI provider is set to *Disabled*.

1. A pre-flight card lists the files that will be reviewed and the ones skipped (binaries, lockfiles, generated or vendored code, files over 1,500 changed lines, files beyond the *Review file limit*), the model and effort in use, and lets you deselect files.
2. Each file is reviewed in its own request (three in parallel) with the pull request title, description, linked issues, commit subjects, failing checks and any repository guidelines (`.gitgood/review.md`, `CONTRIBUTING.md`, the PR template). The diff is sent with every new-side line prefixed `[new:N]` so the model cites real lines; up to 400 lines of surrounding code are included for context.
3. Findings are validated against the diff: lines must exist on the new side (a citation of a deleted line is moved to the next new-side line within three lines), ranges must stay inside one hunk, code fences are stripped from suggestions, duplicates are merged and, in *strict* mode, low-confidence findings are dropped. Rejected candidates are counted in the panel footer.
4. A final request writes the summary and suggests a verdict; the code enforces that a blocker never yields *approve*.
5. Findings appear as gutter markers in the diff and in a side panel. Click one to jump to the line and open its card with the suggestion, **Dismiss**, **Copy** and **Open in editor**. Dismissals are saved with the run.
6. **Post review…** (pull requests only) lets you choose the verdict, edit the body, pick which findings become inline comments, and creates one GitHub review through the REST API. Posting is refused when the pull request moved since the review ran; on your own pull request only *Comment* is allowed. An *AI-assisted* footer is appended unless turned off.

Runs are stored per head commit under the user data folder (`reviews/`, last five per repository). When the pull request or branch gets new commits the panel shows a *stale* banner; **Re-review** sends only files whose diff changed and keeps the other findings. Strictness (`strict`, `balanced`, `thorough`), the file limit and the footer are under **Options → AI → Pull request review**.

Branch mode (no GitHub remote or not signed in) works offline: it diffs the current branch against the base branch's merge-base with `git diff base...HEAD` and offers *Open in editor* instead of posting.

## AI pre-commit review

The commit form's **Review changes** action (next to the AI commit-message sparkle, hidden when the provider is *Disabled*) runs the same review engine against the exact patch `git commit` would apply — whole files, only the selected lines for a partial commit, the full content of untracked files, `HEAD~1` while amending, or the index during a merge in progress — plus the commit summary/description typed so far. Findings show as gutter markers and inline cards in the diff (with **Dismiss**, **Copy**, **Open in editor** and, for a whole-file suggestion on a file that isn't partially selected, **Apply to file**, guarded by a content hash so it refuses if the file changed since the review) and as a collapsible strip above the commit form with counts by severity. A blocker highlights the **Commit** button with a tooltip, but never blocks committing; the review also flags when the typed commit message doesn't seem to match the diff. Editing a reviewed file afterwards greys its findings as stale; **Re-review** re-sends only the stale files. Turning on **Review before every commit** (Options → AI → Pre-commit review) runs the review automatically on Commit and, if it finds anything, asks **Commit anyway** or **Go back** before creating the commit.

## AI commit splitting

**Split into commits with AI**, in the commit form's overflow menu (next to the sparkle and review icons) or the Repository menu, groups the pending changes into an ordered, editable set of commits — for a working tree that mixes a refactor, a fix and formatting into one pile. It's hidden when the AI provider is *Disabled*, while a merge is in progress, or with **Amend** checked, and shown but not actionable (with a tooltip) below two changed files. A pre-flight card shows the file and hunk counts and anything that can only be committed whole (untracked, renamed, deleted, mode-changed or binary/image files) before any AI call; a large change set (over 150,000 bytes) offers a file-only proposal that sends headers and line-count stats instead of code.

The proposal opens as an editable board of commit cards: drag a hunk or a whole file between commits or into **Not included**, edit a summary or description in place, merge a card into the one before it, delete a card (its changes move to Not included rather than vanishing), and preview any hunk's diff read-only. A proposal that comes back as a single commit is reported as already coherent, with nothing left to do but use the normal commit form. Every hunk and whole-file change is accounted for in exactly one commit or in Not included — nothing is ever committed silently.

**Apply** creates the commits in order through the exact same partial-patch path a manual partial commit uses; nothing is staged before Apply runs. It re-checks every included file's content against what was recorded when the plan was made and refuses (offering **Re-propose**) on any change since; if a patch fails partway through, the commits already created stay, nothing is left staged for the one that failed, and the dialog names it. Right after a successful apply, the completion toast offers **Undo all**, which restores the pre-split HEAD with every change back in the working tree, unstaged — available only while nothing already applied has been pushed.

## AI rebase assistant

**Tidy up branch with AI** (Branch menu, or the History context menu for a multi-selection of commits) proposes an interactive-rebase cleanup of the commits ahead of the base branch: squashing clear fixups into their parent, rewording uninformative messages (keeping issue references and trailers), reordering to group related work, and dropping empty or exact-revert-pair commits. It is hidden when the AI provider is *Disabled* and not actionable on the default branch or when a merge commit is in range; a dirty working tree is stashed first. The pre-flight shows the (editable) base, how many commits are in range, how many are already pushed, and a signing warning when commit signing is on.

The plan opens as an editable, oldest-first list — change any row's action, edit its message, drag to reorder, or reset a row to its original — with a **Preview result** showing the resulting history exactly as it will apply; a plan the model returns unchanged is reported as already tidy. Every commit in the range is guaranteed to appear exactly once (an omission comes back as pick in its original position), an invalid squash target or an unsafe drop is repaired with a warning rather than trusted. **Apply** runs the existing squash/reword/reorder/drop operations in a computed order (drops, then rewords, then reorders, then squashes); a conflict surfaces the standard conflicts banner, and choosing Abort there restores the branch to its state before Apply. The completion toast offers **Undo** for ten minutes and, when a rewritten commit was already pushed, reminds you that a force push with lease will be needed — nothing is pushed automatically.

## AI pull request draft

**Draft with AI**, next to the title field in the Create pull request dialog (also the *Branch* menu's *Draft Pull Request with AI…*, which opens the dialog and starts drafting immediately), fills the title and body from the commits and diff ahead of the base branch, entirely from local refs — GitHub is only used to fetch up to five linked issues' titles when you're signed in. It is hidden when the AI provider is *Disabled*, and shown but disabled with an explanatory tooltip when there are no commits ahead of the base branch or the base branch has not been fetched locally (GitGood never fetches it automatically).

When the repository has a PR template, every one of its headings is guaranteed to survive in order — if the model's draft drops or reorders one, GitGood rebuilds the body around the template and shows a *Template structure restored* callout instead. Checkboxes are only ticked when their label matches a changed file. Issue references (`#N`, `Fixes #N`, `owner/repo#N`) are taken only from the commit messages (and the existing body), never invented by the model; a reference only carries a closing keyword when a commit actually used one. If the title or body already has content you typed, a **Replace / Keep mine / Append** prompt appears before anything changes. The draft never creates the pull request — the existing **Create pull request** button is the only write path — and shows an **AI drafted, review before creating** callout until you edit the body or create the PR; an *AI-drafted* footer is appended on create when the same footer setting used by AI review is on.

## AI release notes

**Release notes…** (Repository menu, or a tag's *Release notes since \<tag\>…* in History) turns a commit range into a categorized, reference-checked changelog: pick a From (defaults to the latest reachable tag, or the root commit when there are none) and To, a version (suggested as the From tag's next patch when it's semver), an audience (users or developers), and whether to include pull request titles. **Generate** is hidden when the AI provider is *Disabled*; **Export commit list** still produces a plain, un-grouped list without AI.

Every bullet the model writes must cite a pull request number or a commit SHA in the range — GitGood strips any reference that isn't, drops an item left with none into an **unreferenced** review list (with an **Add** button for a plain bullet), and lists every commit or merged pull request that no item cites, so nothing merged is silently left out. Sections (*Breaking changes*, *Features*, *Fixes*, *Performance*, *Docs*, *Internal*) always render in that fixed order; GitGood assembles the heading, section and bullet Markdown itself, never the model. The result is editable with a preview toggle, **Copy Markdown**, **Insert into CHANGELOG.md** (prepended under the file's top heading, or creating it, preserving line endings, and selecting the file in Changes to commit), and **Create GitHub release…** (draft by default, detects an existing release for the tag, and is unavailable with a reason when not signed in); an *AI-drafted* footer is appended to a published release body when the same footer setting used by AI review is on.

## AI pull request triage

Each pull request row in the pull request list gets a cached triage line — a state chip (*waiting on you*, *waiting on author*, *waiting on others*, *checks failing*, *ready to merge*, *draft*, *stale* or *conflicts*), a one-sentence summary and a suggested next action — so you can see what's worth opening without clicking into every PR. Hidden entirely when the AI provider is *Disabled*.

**Summarize N pull requests** (shown above the list) requests lines only for open pull requests without a fresh cached line, in batches of at most 15, with progress and cancellation between batches; a pull request missing from a batch's response is retried once alone before being left unsummarized. Requests carry metadata only — title, body (capped at 1,500 characters), labels, review state, failing check names, mergeability and, optionally, per-file change counts (**Options → AI → Pull request triage**) — never a diff. Deterministic rules in code cross-check the model's state (draft, conflicting, your own pull request with failing checks, an explicit review request for you, or 14 days without activity) and always win when they apply; a suggested *Merge* action is downgraded to nothing unless the pull request is actually mergeable, its checks passed and it is approved. A **Waiting on you** toggle filters the list, and the same count badges the toolbar's branch/pull-request button.

Lines are cached per repository and pull request number, keyed by the pull request's `updatedAt`; a line dims when the pull request changes underneath it and refreshes on the next Summarize (or automatically with **Refresh stale triage lines automatically**). Entries for closed or merged pull requests, and anything older than 30 days, are dropped. Clicking a suggested next action only opens the matching existing flow (review, checkout, checks, merge, rebase, or copying an @-mention) — nothing is merged, reviewed or commented on automatically.

## AI diff explanation

**Explain** turns a commit, a file's diff, or a selected range of lines into a plain-language write-up, so you (or a teammate) can understand a change without having written it. It is hidden wherever the AI provider is *Disabled*.

- **Entry points**: the Explain button/context-menu item on a commit in History, the sparkle icon in the diff pane header for the file shown in Changes or History, and *Explain N selected lines*/*Explain this line* on a text diff's right-click menu (drag to select a range first, or right-click a single line).
- **What it sends**: for a commit, the message, author, changed files, per-file patches (byte-capped at 120 KB, largest files truncated first with the rest listed as omitted) and up to five recent commits per file; merge commits are diffed against their first parent and root commits against nothing, both stated in the explanation. For a file or a range, the loaded diff plus (for a range) 40 lines of surrounding file content.
- **Output**: four sections — *What changed*, *Why (inferred)*, *Impact* and *Watch out for* — with intent visibly separated from what the diff actually shows, plus references that link back to a line in the diff (clicking one scrolls to it); references to a path or line not in the diff are dropped and counted in the panel.
- **Follow-ups**: ask up to five questions about the same explanation, each reusing the original context and prior answers.
- **Copy as Markdown** formats the explanation (with the commit SHA and file paths) for pasting into a pull request comment. The panel is resizable (width remembered) and collapsible, and the last 20 explanations per repository are cached in memory for the session.

## AI error explanation

The error dialog gains a collapsed **Explain with AI** row (hidden for errors with their own guided flow — conflicts, sign-in, AI not configured, cancelled — and wherever the AI provider is *Disabled*) that turns a failed git/gh command into a **What happened**, a **likely cause**, and up to three suggested fixes.

- **Fixes are never free-form**: each one either names an action from a fixed set GitGood already exposes elsewhere — fetch, pull, publish/set upstream, force push with lease, stash or discard and retry, remove a stale lock file, abort/continue an in-progress operation, sign in, open remote/identity settings, rename branch, open a terminal — and runs through the same action and confirmation the menus use, or is a single copy-only `git`/`gh` command with **Copy** and **Run in terminal** (which opens a shell without executing anything). A fix is dropped when it doesn't fit the repository's current state (e.g. *continue rebase* with no rebase in progress) or names anything outside that set with no safe command to fall back to.
- **Diagnostics are scrubbed** (GitHub/Anthropic tokens, bearer tokens, URL credentials) and capped to the last 4,000 characters of stderr/stdout before anything leaves the process; only remote names and hosts are sent, never full URLs.
- **Explain unclassified errors automatically** (Options → AI) loads the explanation as soon as the dialog opens, but only for errors GitGood couldn't classify — a classified error always requires the click.

## AI command palette

`Ctrl+K` (or Repository → **Ask GitGood…**) opens a command palette that fuzzy-matches GitGood's own menu actions first — no AI call needed for "push", "new branch", and the rest. Typing a plain-language request and choosing **Ask AI** (hidden when the AI provider is disabled or the setting below is off) sends only repository metadata — branch state, branch/tag names, the last 30 commits, stash messages, remotes — never file contents, and gets back a numbered plan of exact `git` commands, each with an explanation and a risk chip (safe, changes history, discards work, touches remote).

- **A strict allowlist policy decides what runs, never the model.** `src/main/ai/nlPolicy.ts` is a pure module: it strips a leading `git`, rejects any argument containing a shell metacharacter, matches a small grammar per family (inspect, branch, commit, stash, sync, integrate, discard, tags), and denylists force-push-without-lease, config/submodule/remote-URL writes, `git rm`, maintenance commands, `-c`/`--exec`/`--git-dir`/`--work-tree`/`-C`, `!` aliases and any non-`git` command outright. `git clean` is always shown copy-only, never run. A step outside the allowlist, or naming a branch/tag/commit that doesn't exist, is shown greyed out with the reason and a **Copy** action instead.
- **Risk is recomputed, never trusted from the model.** The risk chip is the more severe of the model's own guess and the policy's independent classification of the actual command.
- **Previews before you run anything**: a reset shows the commits that would be uncommitted, a discard shows the affected files, a branch delete shows whether it's merged, a rebase shows what would be replayed, and a force-with-lease push shows the ahead/behind count — each recomputed against the live repository, with references re-verified immediately before showing.
- **Nothing runs before you click Run plan**, and destructive steps still open GitGood's normal confirmation dialogs; cancelling stops the plan and keeps whatever already completed. Every executed step is written to the application log with its arguments and exit code.
- One clarifying question is allowed when a request is ambiguous; the session keeps the last 20 plans (with a **Copy commands** action) in memory only.

## Architecture

```
src/
  main/           Electron main process
    exec.ts       child-process runner (no shell, cancellable, progress streaming)
    tools.ts      locate git / gh / claude, read gh auth status, login-shell PATH on macOS/Linux
    git/          git wrappers: status (porcelain v2), log (history, file history via --follow),
                  branches, diffs, blame (porcelain parser, file-at-commit), commits,
                  transfers with progress, merge/rebase/cherry-pick/revert, interactive-rebase
                  automation (squash/reorder/reword/drop) via a GIT_SEQUENCE_EDITOR shim, stash, tags,
                  worktrees (list/add/remove/lock/prune, main-worktree resolution)
    gh/           GitHub CLI wrapper: device-flow login, repos, pull requests, checks, avatars
    ai/           Anthropic SDK + Claude CLI backends, prompts, conflict resolver,
                  pull request AND pre-commit review service (review.ts, worktree target) and its
                  pure validation helpers (review-core.ts, shared by both),
                  diff explanation service (explain.ts) and its pure validation helpers (explain-core.ts)
    repo/         repository list, file-system watcher (recursive fs.watch with polling fallback)
    integrations/ external editors and terminals per platform
    ipc.ts        typed request handlers for every API method
  preload/        contextBridge exposing a single typed invoke/on bridge
  renderer/       React UI (no UI framework dependencies)
  shared/         types, IPC contract, pure diff logic (unified diff parser, partial-patch
                  builder, intraline word diff, conflict marker parser)
```

Renderer and main process communicate over one typed channel (`src/shared/ipc.ts`). All git commands run with `GIT_TERMINAL_PROMPT=0`, so nothing ever blocks on a hidden prompt; errors are classified (auth, network, non-fast-forward, conflicts, protected branch, …) to drive the right dialog.

## Keyboard shortcuts

Ctrl+K command palette (Ask GitGood) · Ctrl+1 Changes · Ctrl+2 History · Ctrl+Shift+S stashes · Ctrl+Shift+W worktrees · Ctrl+Shift+K repository health · Ctrl+Shift+L issues · Ctrl+Shift+J notifications inbox · Ctrl+T repositories · Ctrl+B branches · Ctrl+Enter commit · Ctrl+P push · Ctrl+Shift+P pull · Ctrl+Shift+T fetch · Ctrl+Shift+N new branch · Ctrl+R create pull request · Ctrl+Shift+R review pull request with AI · Ctrl+Shift+D toggle split diff · Alt+B toggle blame · Ctrl+` open terminal · Ctrl+Shift+A open in editor · Ctrl+/ all shortcuts.

## License

MIT
