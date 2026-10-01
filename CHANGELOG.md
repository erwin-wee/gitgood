# Changelog

All notable changes to GitGood. Versions follow [semver](https://semver.org); release notes for each version are also on the [Releases page](https://github.com/erwin-wee/gitgood/releases).

## Unreleased

A security, privacy and robustness pass over the whole app, plus the features that came out of it.

### Security

- **Repository files can no longer leak through symlinks.** Every repo-controlled file that feeds the AI, templates or configuration (review guidelines, PR and issue templates, `.gitgood/config.json`, untracked files in diffs, conflict reads) is read through one helper that refuses symlinks and checks the real path stays inside the repository. A symlinked file diffs as its link text, like git. AI-written files (conflict resolutions, applied suggestions) go through a matching safe write.
- **Secrets are protected at rest and in logs.** `secrets.json` and every other store file are written `0600` in a `0700` directory (POSIX); the log file is `0600` and scrubs tokens and credentials from every line, including git argv; the server token is never logged (printed once on a TTY at first start, otherwise only its file path). A corrupt store file is renamed to `<file>.corrupt-<timestamp>` instead of being silently reset.
- **Server mode.** `repo.readFile`/`repo.writeFile` and every path argument reject absolute and `../` paths (including through symlinked parents); `/gitgood-bridge.js` is refused to cross-origin requests and sent with `Cross-Origin-Resource-Policy: same-origin`.
- **AI privacy.** Secret-shaped files (`.env*`, `*.pem`, `*.key`, `id_rsa*`, `.netrc`, credential-bearing `.npmrc`, …) are never uploaded, known token shapes are masked in the text of every read-only feature, and error explanation scrubs the failing command. AI can be switched off per repository, on your machine or for everyone via `.gitgood/config.json`.
- **Settings sync** uses secret gists only: it refuses to upload to (or adopt) a public gist, re-checks visibility before every upload, and keeps `agentCustomCommand` machine-local. A settings file that changes the OpenAI-compatible base URL deletes the stored API key so it can't be redirected.
- **Prompt-injection and confused-deputy hardening.** The repository check-command trust prompt binds to the exact command shown; the `gitgood://review/rerun` link needs a per-run one-time token, otherwise it asks for confirmation before anything is sent to an AI provider; custom agent commands must quote every `{file}`; the natural-language palette allows only an explicit option list per inspect command (and disables external diff and textconv drivers); branch, tag and remote names starting with `-` are rejected.
- **Electron.** IPC is accepted only from the app's own main frame, and navigation is limited to the exact entry document.
- **Release pipeline.** GitHub Actions are pinned by commit SHA, workflows run read-only with credentials not persisted, builds use `--publish never` and a separate publish job holds `contents: write`; the Linux installer fails closed when it cannot verify the download's SHA-512 (`--insecure-skip-verify` overrides); `release:prepare` refuses to continue when the CI check can't be confirmed (`--skip-ci-check` overrides). Code signing and notarization are wired to repository secrets and stay inactive until configured. Dependabot watches npm and GitHub Actions. See [SECURITY.md](SECURITY.md).

### Added

- **Commit graph** in History with coloured branch lanes, merges and octopus merges, computed incrementally.
- **Multiple GitHub accounts**, with a per-repository account whose token is used for that repository's `gh` calls and network git commands.
- **Multiple windows** (File → New Window, Open in New Window), each with its own repository and live updates.
- **Undo history** (reflog browser with restore, create-branch and checkout) and **Undo Last Git Operation**.
- **Bisect** from the History context menu, with a progress banner.
- **Stacked branches**: stack markers, `--update-refs` on rebase and **Push stack**.
- **Rebindable keyboard shortcuts**, included in exported and synced settings.
- **MCP server** for coding agents (`gitgood_latest_review`, `gitgood_request_rereview`, `gitgood_open_repository`), registered by the `gitgood-review` plugin.
- **Clone options**: depth, single branch, blobless, sparse directories and a submodules toggle.
- **Pinned repositories and custom groups** in the repository list.
- **PR auto-merge** (`gh pr merge --auto`) and a **Files changed** view in Compare.
- **Commit options**: sign-off per repository, skip hooks for one commit, and `commit.template` prefill.
- **External diff and merge tools** (`git difftool`/`git mergetool`).
- **AI**: an OpenAI-compatible provider (OpenAI, OpenRouter, Ollama, LM Studio, …), per-feature model overrides, a monthly token-usage view, and prompt caching for Anthropic requests.
- **`gitgood <path>`** opens a folder as a repository, and dropping a folder on the window adds it.
- **Managed background server on macOS and Windows** (LaunchAgent and a per-user login item; not yet verified on real machines), a "Reload to update" banner when the server was upgraded, and a "Reconnecting…" banner with exponential backoff for browser tabs.
- **Accessibility**: an error boundary with Reload and Copy details, forced-colors / high-contrast styles, and a resizable History file pane.
- Minimum tool versions (Git 2.30, gh 2.40) are checked, with a dismissible banner when one is older.
- Installer: `install-linux.sh --uninstall`. Packaging: macOS universal, Windows x64 + ARM64, Linux AppImage and `.deb`.
- Lint: ESLint with the React hooks rules, run in CI.

### Changed

- `ai.cancel` now cancels one feature, and only the calling window or web client's job, instead of every AI service.
- The renderer is code-split (heavy dialogs and syntax-highlighting grammars load on demand); the main chunk is about 30% smaller.
- Startup no longer makes git wait for the `gh`, `claude` and `gpg` probes; each tool appears as soon as its own probe finishes.
- Repository indicators use a light `git status --porcelain=v2 --branch` parse with bounded concurrency.
- The web folder picker is a regular dialog (keyboard, ARIA and theme aware).
- `.deb` installs are treated as unable to self-update, matching how `electron-updater` behaves on Debian.
- CI runs on Node 24; `engines.node` is `^20.19.0 || >=22.12.0`. Electron 44.5.1 and `@anthropic-ai/sdk` 0.131.
- Unit, fixture and Electron smoke suites are enabled on Linux, Windows and macOS; the Test workflow also supports manual dispatch and `ci/**` validation branches.
- Neutral wording in shared AI backend messages (they used to read like conflict-resolution copy for every feature).

### Fixed

- The diff line-number gutter now meets contrast guidelines.
- Several AI services shared one cancel controller, so cancelling one (or, in server mode, another client's job) could abort an unrelated request; each now cancels only its own.
- Git commands stayed blocked for several seconds after launch on machines where `claude --version` or `gh --version` is slow.
- Windows batch-file arguments survive both `cmd.exe` parsing passes; Git worktree and MCP repository paths use native separators.
- Smoke fixtures use canonical paths (including Windows 8.3 aliases) and wait for asynchronous dialog content rather than fixed loading delays.
- Settings export no longer carries machine-local custom agent commands; repository pins, groups and AI opt-outs also stay out of it.

## 0.3.2 — 2026-09-25

- Opening an AI review comment, following a link in an AI explanation, expanding hunk context, blame cards and History search matches no longer make the diff flash or jump, including across files and after a save reloads it.
- The History list on phones no longer jumps when more commits load.

## 0.3.1 — 2026-09-24

- The web app loads far faster from the server (about 2.8 s instead of 12.7 s on a slow mobile connection) via compression, caching and a service worker; the installed phone app shows a "Can't reach your GitGood server" page with Retry.
- Large diffs and merge conflicts are cheaper to deliver and render; the app appears before git and gh are located; saves made elsewhere show up almost instantly; no spinner flash for quick diffs.

## 0.3.0 — 2026-09-24

- **File → Run GitGood server in the background…** (Linux) installs a service running the server bundled with the app, copies settings and repositories into it the first time, and keeps it on the desktop's version.
- A desktop connected to a server checks for and installs its own updates.
- The version-mismatch warning offers Restart server, Copy command, Reload or Check for updates.

## 0.2.0 — 2026-09-24

- **Server mode:** run GitGood headless and use it from a browser on your Tailscale tailnet, locked to your Tailscale login.
- **Desktop as a client** of a server; **phone and tablet layout** for the web UI (installable to the home screen).
- In-app help, a condensed toolbar, two-line commit rows, searchable shortcuts and clearer discard wording.
- Push progress shows pre-push hook output; watched folders are scanned correctly at launch; the pull request list stays within GitHub's API limits.

## 0.1.5 — 2026-09-22

- Fixed History and pull request state not refreshing after ref changes while another tab was showing.

## 0.1.4 — 2026-09-21

- Performance: repository watching and word-level diffs kept off hot paths.

## 0.1.3 — 2026-09-19

- Fixes for `release:tag` opening an unreachable editor, the Linux installer's `--version` handling, `cmd.exe` quoting and the gh stub on Windows.
- UI/UX audit fixes: keyboard access, dialog focus, labels, contrast and safety guards.
- Snappier lists, diffs and repository opens.

## 0.1.2 — 2026-09-18

- The setup screen no longer flashes on every launch.
- Added the release script (`npm run release:prepare` / `release:tag`); real-git test suites get enough time on Windows.

## 0.1.1 — 2026-09-18

- **Watched folders** that auto-discover repositories.
- **Fix with agent**: hand AI review findings to a terminal coding agent.
- Linux install script that detects the distro; documentation split into `docs/`.
- Fixed first-sync notification flood, the commit button label and blame gutter contrast; release assets are no longer silently skipped.

## 0.1.0 — 2026-09-18

- First release: a GitHub Desktop–style client driving `git` and `gh`, with AI conflict resolution, pull request review and the other AI features, release CI and automatic updates through `electron-updater`.
- Fixed process cancellation and Windows CLI spawning, and an unconfirmed-git-command path in the AI palette.
