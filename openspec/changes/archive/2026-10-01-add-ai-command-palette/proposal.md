# Proposal

## Why

Many users know what they want ("undo the last two commits but keep the changes") but not the git incantation, and GitHub Desktop-style clients offer no path from intent to action beyond their buttons. A palette that translates plain language into exact, previewed git commands teaches the user and keeps execution behind the app's safety rules.

## What Changes

- Add a `Ctrl+K` command palette that fuzzy-matches built-in actions first and, on request, sends the text to the model.
- The model returns a plan of exact git commands (argv, explanation, risk); a policy layer recomputes risk, matches each step against a strict allowlist and marks everything else copy-only.
- Read-only previews (affected commits, files, ahead/behind counts) are shown before the user confirms.
- **Run plan** executes steps sequentially through existing wrappers; history-changing or work-discarding steps go through the existing confirmation dialogs (user-confirmed action); denylisted commands are never executed.
- One clarifying-question round when the request is ambiguous.

## Capabilities

### New Capabilities

- `ai-command-palette`: natural-language to git plan translation, allowlist/denylist policy, previews, confirmed execution and palette history.

### Modified Capabilities

_None._

## Impact

- Main process: new `src/main/ai/nlPolicy.ts` (allowlist grammar, denylist, risk recomputation), new planner service next to `src/main/ai/resolver.ts`, prompt and schema in `src/main/ai/prompts.ts`, `src/main/ipc.ts` methods `ai.nl.plan`, `ai.nl.preview`, `ai.nl.run`, event `ai.nl.progress`, `src/main/menu.ts` (`Ctrl+K`), executed steps logged via `src/main/logger.ts`.
- Commands: context gathering with `git status`, `git branch`, `git log`, `git stash list`, `git remote`, `git tag`; ref checks with `git rev-parse --verify`; previews with `git log --oneline <a>..<b>`, `git status --porcelain`, `git branch --merged`, `git rev-list --left-right --count @{u}...HEAD`; execution through existing wrappers (`git.checkout`, `git.branch.*`, `git.undoCommit`, `git.revert`, `git.cherryPick`, `git.stash.*`, `git.fetch/pull/push`, `git.merge`, `git.rebase`, `git.discard*`, `git.tag.*`) or `git.tryRun` for inspect commands.
- Renderer: new `CommandPalette.tsx`, plan card, risk chips, progress; setting `AiSettings.nlPaletteEnabled`.
- No new runtime dependencies; no shell is ever used for execution.
