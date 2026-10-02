# Proposal

## Why

GitGood already classifies git and gh failures and picks a dialog, but for unknown and many classified cases the user still reads raw stderr. The model is good at turning that output into a next step, and a fixed action map means an explanation can never trigger anything the app would not otherwise offer.

## What Changes

- The error dialog gains a collapsible **Explain with AI** section that returns what happened, the likely cause and up to three suggested fixes.
- Fixes are either one-click actions from a fixed action map (fetch and pull, publish branch, stash and retry, abort or continue an operation, open sign-in or settings…) that run through the normal operation path with its confirmations, or copy-only single git/gh commands with a **Run in terminal** shortcut that opens the shell without executing anything.
- stderr and stdout are scrubbed of tokens and URL credentials before leaving the process.
- Optional setting to load the explanation automatically for unclassified errors only.

## Capabilities

### New Capabilities

- `ai-error-explanation`: AI explanation of failed operations with policy-validated fix suggestions.

### Modified Capabilities

_None._

## Impact

- Main process: new `src/main/ai/fixActions.ts` (action map, applicability rules, risk), explanation service next to `src/main/ai/resolver.ts`, secret scrubber, prompt and schema in `src/main/ai/prompts.ts`, `src/main/ipc.ts` method `ai.explainError`.
- Commands: context from `RepositoryStatus`, `getRemotes` (names and hosts only), `git reflog --format=%h %gs -n 10`, tool versions from `ToolsState`; the lock-file fix inspects running git processes (`pgrep -x git` / `tasklist`) and the lock file age before deleting `.git/index.lock` behind a confirmation.
- Renderer: `ErrorDialog` in `CommitDialogs.tsx` gains the section; fixes dispatch to existing actions (`git.fetch`, `git.pull`, `git.push` with set-upstream or force-with-lease dialog, `git.stash.push`, discard dialog, abort/continue methods, sign-in dialog, repository settings, identity settings, rename branch dialog, `app.openInShell`).
- Settings: `AiSettings.explainErrorsAutomatically` (default off). Local helpful/not-helpful counts only; nothing is sent anywhere.
- No new runtime dependencies.
