# GitGood

A GitHub Desktop–style Git client for Windows (and macOS/Linux) built with Electron. Instead of bundling its own Git and GitHub API client, GitGood drives the **`git`** and **`gh`** command-line tools you already have. Signing in once with the GitHub CLI's OAuth device flow is all that is needed to clone, fetch, pull, push and manage pull requests — `gh auth setup-git` wires Git's credential helper so HTTPS remotes just work.

It also adds **one-click AI merge conflict resolution** powered by Claude: pick a conflicted file (or all of them) and GitGood asks the model to reconcile both sides of every conflict block, writes the result, marks the file resolved, and lets you review or undo it.

## Features

Everything you expect from GitHub Desktop, mapped onto `git`/`gh`:

- **Repositories**: clone from your GitHub repositories (personal, collaborator and organization repos) or any URL, create new repositories with README/.gitignore/license templates, add existing ones, aliases, remove (optionally to the Recycle Bin), grouped repository list with ahead/behind indicators.
- **Changes**: working-tree file list with include/exclude checkboxes, **partial commits by selecting individual lines or hunks**, discard files or selected lines (moved to the Recycle Bin), ignore file/extension, stash and restore, commit form with summary/description, co-authors, amend, 72-character warning, and **AI-generated commit messages**.
- **History**: searchable commit list (message, author, SHA), commit details with per-file stats, revert, cherry-pick to another branch, create branch/tag from commit, checkout commit, **squash**, **reorder by drag and drop**, edit message (reword), drop commit, undo last commit, amend.
- **Branches**: create (based on default or current branch), rename, delete (with remote), switch with stash-or-carry handling of uncommitted changes, merge, squash merge, rebase, compare, update from default branch, publish, force push with lease (with confirmation), background fetch.
- **Pull requests** (via `gh`): list open PRs with check status, check out a PR (including forks), create PRs (with template pre-fill, draft, or on GitHub.com), view checks, approve/comment/request changes, mark ready, merge (merge/squash/rebase), close/reopen.
- **Diffs that are easy to read**: unified or side-by-side, syntax highlighting for ~50 languages, word-level change highlighting inside modified lines, expandable context, hide whitespace, line wrapping, adjustable font size, image diffs (2-up, swipe, onion skin, difference), binary and submodule summaries.
- **Conflicts**: banner and dialog listing conflicted files, per-block **Accept ours / theirs / both / base**, whole-file ours/theirs, open in editor, mark resolved, continue/abort merge, rebase (with skip), cherry-pick and revert — plus **Resolve with AI** per file or for all files at once.
- **Integrations**: open in VS Code, Cursor, Sublime, Notepad++, Visual Studio, JetBrains IDEs and more; open in Windows Terminal, PowerShell, Command Prompt or Git Bash; show in Explorer; view on GitHub; create issue.
- Light/dark/system theme, keyboard shortcuts mirroring GitHub Desktop, native menus.

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
npm run dev        # electron-vite dev server with hot reload
npm test           # vitest unit tests (diff parser, patch builder, git output parsers, ...)
npm run typecheck  # main + renderer TypeScript
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

## Signing in to GitHub

**Options → Accounts → Sign in to GitHub.com** runs `gh auth login --web`. GitGood shows the one-time code, opens `github.com/login/device` in your browser and waits for approval. When it completes, GitGood runs `gh auth setup-git`, so Git pushes and pulls to GitHub over HTTPS use the same token. Nothing else is stored by the app.

## AI conflict resolution

Configure under **Options → AI**:

- **Provider**
  - *Anthropic API*: paste an API key. It is stored encrypted with the operating system's credential store (DPAPI on Windows, Keychain on macOS) via Electron `safeStorage`. Without a stored key, the SDK falls back to the `ANTHROPIC_API_KEY` environment variable or an `ant auth login` profile.
  - *Claude Code CLI*: reuses your existing `claude` sign-in and plan; no key required. Runs `claude -p` headless with tools disabled and a JSON schema for the output.
- **Model**: defaults to `claude-opus-5`. Claude Fable 5.1, Sonnet 5, Opus 4.8 and Haiku 4.5 are offered as presets; any model ID can be typed.
- **Effort**: `low` … `max` (default `high`).

How a resolution works: GitGood parses the conflict markers (including `diff3`/`zdiff3` base sections), sends each conflict block with 40 lines of surrounding context, the merge/rebase context and the recent commit subjects on both sides, and requests a structured JSON answer with one resolution and a one-sentence rationale per block. It validates that no markers remain, rewrites the file preserving line endings, and (by default) runs `git add`. Low-confidence blocks are flagged in the toast, and **Undo** restores the original conflicted content via `git update-index --unresolve`.

For `claude-opus-5` and Claude Fable models the request also enables Anthropic's server-side refusal fallback, so a false-positive safety decline is retried automatically on a fallback model within the same call.

## Architecture

```
src/
  main/           Electron main process
    exec.ts       child-process runner (no shell, cancellable, progress streaming)
    tools.ts      locate git / gh / claude, read gh auth status, login-shell PATH on macOS/Linux
    git/          git wrappers: status (porcelain v2), log, branches, diffs, commits,
                  transfers with progress, merge/rebase/cherry-pick/revert, interactive-rebase
                  automation (squash/reorder/reword/drop) via a GIT_SEQUENCE_EDITOR shim, stash, tags
    gh/           GitHub CLI wrapper: device-flow login, repos, pull requests, checks, avatars
    ai/           Anthropic SDK + Claude CLI backends, prompts, conflict resolver
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

Ctrl+1 Changes · Ctrl+2 History · Ctrl+T repositories · Ctrl+B branches · Ctrl+Enter commit · Ctrl+P push · Ctrl+Shift+P pull · Ctrl+Shift+T fetch · Ctrl+Shift+N new branch · Ctrl+R create pull request · Ctrl+Shift+D toggle split diff · Ctrl+` open terminal · Ctrl+Shift+A open in editor · Ctrl+/ all shortcuts.

## License

MIT
