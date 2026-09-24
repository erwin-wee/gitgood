# GitGood

A GitHub Desktop–style Git client for Windows (and macOS/Linux) built with Electron. Instead of bundling its own Git and GitHub API client, GitGood drives the **`git`** and **`gh`** command-line tools you already have. Signing in once with the GitHub CLI's OAuth device flow is all that is needed to clone, fetch, pull, push and manage pull requests — `gh auth setup-git` wires Git's credential helper so HTTPS remotes just work.

It also adds **one-click AI merge conflict resolution** powered by Claude: pick a conflicted file (or all of them) and GitGood asks the model to reconcile both sides of every conflict block, writes the result, marks the file resolved, and lets you review or undo it.

## Features

Everything you expect from GitHub Desktop, mapped onto `git`/`gh`:

- **Repositories**: clone from your GitHub repositories (personal, collaborator and organization repos) or any URL, create new repositories with README/.gitignore/license templates, add existing ones, aliases, remove (optionally to the Recycle Bin), grouped repository list with ahead/behind indicators.
- **Watched folders** (Options → Git): register the folders you keep your clones in and every Git repository inside them is added for you, instead of adding each one by hand. Each folder has its own scan depth (default 3, so `~/Projects/<org>/<repo>` is found), and scans skip `node_modules`, `vendor`, `dist`, dot-directories and symlinks, never descend into a repository, and ignore bare repositories. Folders are scanned when GitGood starts, when you change them, and on **Rescan now** (File → Rescan Watched Folders) — there is no continuous watching, so a repository cloned from a terminal appears after the next scan. Discovered repositories that vanish from disk drop off the list; removing a repository that lives in a watched folder remembers it so scans do not add it back, with the remembered paths listed and clearable. Watched folders stay on the machine and are never part of a settings export.
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
- **Pull requests** (via `gh`): list open PRs with check status, check out a PR (including forks), create PRs (with template pre-fill, draft, or on GitHub.com — or **drafted with AI** from the branch's commits and diff), view checks, approve/comment/request changes, mark ready, merge (merge/squash/rebase), close/reopen, and **review with AI**: findings anchored to diff lines, shown as gutter markers and a findings panel, optionally posted to GitHub as a review with inline comments. The same review runs locally on the current branch against its base, without GitHub. The list also carries an **AI triage** line per pull request (state chip, one-sentence summary and a suggested next action).
- **Fix with agent** (on pull request, branch and pre-commit review findings): hands the findings to a terminal coding agent. GitGood writes every finished review to `.git/gitgood/review/latest.json` and `latest.md` (with instructions for the agent) and opens your terminal running Claude Code, Codex, omp or a custom command on that file; when the agent is done it opens a `gitgood://review/rerun` link and GitGood re-reviews so you can see what was fixed. A `gitgood-review` plugin in this repository adds a `/gitgood-review` slash command and a session-start reminder for all three agents.
- **AI release notes** (Repository menu, or a tag's context menu in History): pick a commit range and generate a categorized, reference-checked changelog — every bullet cites a pull request or commit in the range, with an unreferenced-items review list — then copy it, insert it into `CHANGELOG.md`, or publish a GitHub release (draft by default). Works as a plain commit-list export even with AI turned off.
- **Notifications inbox** (the toolbar bell, View menu, or `Ctrl+Shift+J`): polls your GitHub notifications — review requests, failing checks, mentions, assignments, comments and state changes — grouped by repository with a reason chip, honouring the server's own poll interval and conditional requests so quota is never wasted, and pausing while the window has been unfocused for 30 minutes. Click a pull request notification from a repository already in GitGood to open it in place (anything else opens on github.com); mark items read, mark all read (confirmed once), unsubscribe, filter to review requests/failures/mentions or only your own repositories, and refresh. Shows a taskbar/dock/launcher badge with the unread count, and desktop alerts for enabled categories while the window is unfocused. Explains itself and offers a one-click fix when the token is missing notifications access, you're signed out, rate-limited, or offline (showing the last cached list).
- **Issues** (Repository menu, `Ctrl+Shift+L`, or the commit form's `#` button): browse, search and filter (state, assigned/created/mentioned, labels, milestone — remembered per repository) the current repository's issues; view an issue's labels, milestone, assignees, body and latest comments (rendered as plain text with clickable links, never Markdown or HTML); **Reference in commit** appends `Fixes #N`/`Refs #N`/`Closes #N` to the commit description, **Create branch for issue** pre-fills the new-branch dialog with a slug like `123-fix-login-timeout`; close (with a one-time confirmation) or reopen, comment, and create issues from the repository's `.github/ISSUE_TEMPLATE` templates. Forks offer a toggle to browse the parent repository's issues instead. Explains itself when issues are disabled, you're signed out, or GitHub rate-limits the request.
- **Diffs that are easy to read**: unified or side-by-side, syntax highlighting for ~50 languages, word-level change highlighting inside modified lines, expandable context, hide whitespace, line wrapping, adjustable font size, image diffs (2-up, swipe, onion skin, difference), binary and submodule summaries.
- **Explain with AI**: plain-language explanation of a commit (History header/context menu), a file's diff (Changes/History diff pane), or a selected range of lines (right-click a diff selection) — what changed, the inferred intent, its impact, and things to double-check, with clickable references that scroll the diff to the cited line, up to five follow-up questions, and **Copy as Markdown**. Read-only: nothing is written to the repository or GitHub.
- **AI error explanation**: the error dialog's collapsible **Explain with AI** row turns a failed git/gh command into a plain-language cause and up to three fixes, each either a one-click action GitGood already exposes (with its usual confirmation) or a copy-only command with **Run in terminal**; tokens and credentials are scrubbed before anything is sent.
- **AI command palette** (`Ctrl+K`, or Repository → **Ask GitGood…**): fuzzy-matches GitGood's own menu actions first, or turns a plain-language request into a previewed, numbered plan of exact `git` commands that only runs after confirmation, behind a strict allowlist policy that decides executability and risk independently of the model.
- **Conflicts**: banner and dialog listing conflicted files (sorted with any low-confidence resolution first, and a per-file confidence/check summary), per-block **Accept ours / theirs / both / base**, whole-file ours/theirs, open in editor, mark resolved, continue/abort merge, rebase (with skip), cherry-pick and revert — plus **Resolve with AI** per file or for all files at once, confidence-tinted results with an explain-why popover per block, an optional post-resolution check, and **Resolve remaining like `<file>`** once you've resolved one by hand.
- **Integrations**: open in VS Code, Cursor, Sublime, Notepad++, Visual Studio, JetBrains IDEs and more; open in Windows Terminal, PowerShell, Command Prompt or Git Bash; show in Explorer; view on GitHub; create issue.
- **Portable settings** (Options → Advanced, or File → Export/Import Settings…): export preferences, the repository list and integration choices to one JSON file, with a section checklist and an import preview (adds/changes/unchanged per section, merge or replace) — timestamped backups are kept before a replace. Optional **sync through a secret GitHub gist** (created or reused via the signed-in GitHub CLI): the sync card always shows which side changed since the last sync and lets you upload or download, never merging silently; disconnect keeps or deletes the gist. The export never includes your API key, saved GitHub credentials, tool paths or window position.
- **Updates** (Help → Check for Updates…, or Options → Advanced): checks the GitHub releases feed (via `electron-updater`) on launch and every 6 hours for a newer stable or (on the beta channel) prerelease version — never a downgrade — then downloads it in the background and offers **Restart to update** from a banner, the Help menu and the About dialog; automatic checking, automatic download and the release channel are configurable. Installing is blocked while a git operation or AI task is running, and reopens the same repository afterwards. Disabled in development builds, portable Windows builds, unsigned macOS builds and a read-only AppImage, which show *Updates unavailable in this build* instead.
- Light/dark/system theme, keyboard shortcuts mirroring GitHub Desktop, native menus.

See [docs/AI-FEATURES.md](docs/AI-FEATURES.md) for a deep dive into how each AI feature works, what it sends and what stays local.

## Download

Grab the latest release for your platform from the [Releases page](https://github.com/erwin-wee/gitgood/releases/latest):

- **Windows**: `GitGood-Setup-<version>.exe` (NSIS installer)
- **macOS**: `GitGood-<version>.dmg` (unsigned — see note below)
- **Linux**: `GitGood-<version>.AppImage` — `chmod +x` and run, or use the install script:
  ```bash
  curl -fsSL https://raw.githubusercontent.com/erwin-wee/gitgood/main/scripts/install-linux.sh | bash
  ```
  It detects your distro (Debian/Ubuntu, Fedora/RHEL, Arch, openSUSE), installs `git`/`gh`/the AppImage runtime dependency via your package manager, and installs the latest AppImage to `~/.local/share/GitGood` with a `gitgood` command and a desktop menu entry. Run it with `--help` to see options (a specific version, a custom install path, skipping the prerequisite install).

Releases are unsigned. Windows will show a SmartScreen "unknown publisher" prompt (**More info → Run anyway**) the first time you launch a new version. macOS Gatekeeper may refuse to open the `.dmg` outright; if so, download the `.zip` instead and right-click → **Open** on the extracted app. See [docs/RELEASING.md](docs/RELEASING.md#signing) for the plan to fix this.

Once installed, GitGood checks for updates automatically, downloads them in the background, and offers **Restart to update** (Help → Check for Updates…, or Options → Advanced to configure).

## Prerequisites

| Tool | Why | Windows install |
| --- | --- | --- |
| [Git](https://git-scm.com) 2.30+ | All repository operations | `winget install --id Git.Git -e` |
| [GitHub CLI](https://cli.github.com) 2.40+ | Sign-in, credential helper, pull requests, repository listing | `winget install --id GitHub.cli -e` |
| [Claude Code CLI](https://docs.anthropic.com/claude-code) (optional) | AI features without an API key, using your Claude sign-in | `npm install -g @anthropic-ai/claude-code` |

GitGood looks for the tools on `PATH` and in the usual install locations; you can also point it at specific executables under **Options → Advanced**. The Linux install script above installs Git and the GitHub CLI for you.

## Signing in to GitHub

**Options → Accounts → Sign in to GitHub.com** runs `gh auth login --web`. GitGood shows the one-time code, opens `github.com/login/device` in your browser and waits for approval. When it completes, GitGood runs `gh auth setup-git`, so Git pushes and pulls to GitHub over HTTPS use the same token. Nothing else is stored by the app.

## Server mode (web access over your tailnet)

GitGood can also run **headless as a web server** so you can reach it from a browser on another device — e.g. your desktop's GitGood open on a laptop or phone — over your [Tailscale](https://tailscale.com) tailnet. The same UI and the same `git`/`gh` backend run; only the transport changes (HTTP + WebSocket instead of Electron IPC).

It executes `git`, `gh`, shell and AI-CLI commands **as the host user**, so it is locked down by default:

- **Loopback only.** The server binds `127.0.0.1` and never `0.0.0.0`; `tailscale serve` is the only way in. Public exposure (`tailscale funnel`) is never enabled. It also only answers to `127.0.0.1`/`localhost` and `*.ts.net` host names, so a web page can't reach it through DNS rebinding.
- **Bearer token.** A 256-bit token is generated on first start, stored `0600` in the user-data directory, and printed once. It is required on `/invoke` and the `/events` WebSocket.
- **Tailscale identity.** Every request that comes through `tailscale serve`, including the page itself, must carry the allowed `Tailscale-User-Login`. By default that is the owner of this tailnet node (from `tailscale status`); set `GITGOOD_ALLOWED_LOGIN` to override. Other users and tagged devices are refused, and if no login can be determined nothing from the tailnet gets in.
- **Path confinement.** Paths are restricted to the server user's home directory, the registered repositories, watched folders, the default clone directory and `GITGOOD_ALLOWED_ROOTS`; a path outside them is refused before any command runs. The web folder picker browses the same locations and accepts a typed path (absolute or `~/…`).

### Run it

```bash
npm run build          # builds the app, including the renderer (out/renderer) and the headless server (out/server)
npm run start:server   # data lives in ~/.config/gitgood-server

# Then expose the loopback port on your tailnet (default port 4600):
tailscale serve --bg 4600
# GitGood is now at https://<your-host>.<tailnet>.ts.net
```

To keep it running on Linux, `npm run install:service` installs and starts a systemd user service (`gitgood-server`) for this checkout; set environment variables with `systemctl --user edit gitgood-server`, and re-run it after moving the checkout. To start from your desktop's repositories and settings, copy `settings.json`, `repositories.json` and `state.json` into `~/.config/gitgood-server` once, with the server stopped.

Installed copies of GitGood ship the server too; run it with the app's own runtime, e.g. `ELECTRON_RUN_AS_NODE=1 /path/to/gitgood /path/to/resources/app.asar/out/server/index.mjs` (for the Linux AppImage, `--appimage-extract` it first and use `squashfs-root/`).

Environment variables: `GITGOOD_SERVER_PORT` (default `4600`), `GITGOOD_USER_DATA` (default `~/.config/gitgood-server`), `GITGOOD_ALLOWED_LOGIN` (Tailscale login to allow; defaults to this node's owner), `GITGOOD_ALLOWED_ROOTS` (extra filesystem roots the client may reach, `PATH`-separated), `GITGOOD_RENDERER_DIR` (defaults to the bundled `out/renderer`).

### Web-mode differences

Because the browser is not the host machine, desktop-only actions degrade gracefully: **Copy** uses the browser clipboard and **external links** open in a new tab, while **open-in-editor/terminal** are disabled in the browser (they would run on the server's machine) and the folder picker browses the server's allowed locations. Anything moved to the trash (discarded changes, removed repositories) goes to `trash/` in the server's data directory (`~/.config/gitgood-server/trash`). Several clients can be connected at once, each with its own open repository and live updates; changes to the same repository are serialized.

### Phones and tablets

On a phone the web UI switches to a one-pane-at-a-time layout: a bottom tab bar (Changes, History, Stashes, More), tap a file or commit to drill in, and the in-app back button or the system back gesture to return. The repository and branch pickers, dialogs and right-click menus open as bottom sheets; long-press anything that has a context menu. Portrait tablets keep the two-pane layout with the same tab bar and touch-sized controls. Use your browser's **Add to Home Screen** / **Install app** to run it full-screen like a native app.

### Desktop app as a client

To have one set of settings and repositories everywhere, point the desktop app at the server instead of its own data: put the server URL in `~/.config/gitgood/server-url` (or set `GITGOOD_SERVER_URL`), e.g. `http://127.0.0.1:4600`, and restart GitGood. The window then runs the server's UI, so changes made on the desktop, in a browser, or on another machine show up everywhere. The desktop keeps native clipboard, links, zoom, the unread badge and OS notifications; with a server on the same machine (`127.0.0.1`/`localhost`) it also keeps native file dialogs, reveal/open/trash and open-in-editor/terminal. For a remote server those fall back to the web behavior. Remove the file to run standalone again; the desktop's own settings are left untouched while in client mode.

If the desktop app and the server run different versions, the desktop warns once after connecting; update or rebuild whichever is behind.

## Documentation

- [docs/AI-FEATURES.md](docs/AI-FEATURES.md) — how each AI feature works, in depth.
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — code layout and how the main/renderer processes talk to each other.
- [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) — running the app and its test suites locally.
- [docs/RELEASING.md](docs/RELEASING.md) — building installers, cutting a release, and the plan for code signing.
- [docs/CONTRIBUTING.md](docs/CONTRIBUTING.md) — how to propose and submit a change.

## Keyboard shortcuts

Ctrl+K command palette (Ask GitGood) · Ctrl+1 Changes · Ctrl+2 History · Ctrl+Shift+S stashes · Ctrl+Shift+W worktrees · Ctrl+Shift+K repository health · Ctrl+Shift+L issues · Ctrl+Shift+J notifications inbox · Ctrl+T repositories · Ctrl+B branches · Ctrl+Enter commit · Ctrl+P push · Ctrl+Shift+P pull · Ctrl+Shift+T fetch · Ctrl+Shift+N new branch · Ctrl+R create pull request · Ctrl+Shift+R review pull request with AI · Ctrl+Shift+D toggle split diff · Alt+B toggle blame · Ctrl+` open terminal · Ctrl+Shift+A open in editor · Ctrl+/ all shortcuts.

## License

MIT
