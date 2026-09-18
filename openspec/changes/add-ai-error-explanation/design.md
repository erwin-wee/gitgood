# Design

## Context

See proposal.md. `src/main/exec.ts` classifies failures into `GitErrorInfo { code, command, exitCode, stderr, stdout }` and `showError` in the renderer routes codes to dialogs (`ErrorDialog`, conflicts, sign-in). Operations are launched via `runOperation` in `src/renderer/src/state/actions.ts`, some with a `retry` callback. The multi-step palette (`add-ai-command-palette`) covers free-form recovery; this change is deliberately a fixed-action variant.

## Goals / Non-Goals

**Goals:**
- One click from error to the existing action that fixes it, with all existing confirmations.
- Zero new execution surface: only actions already reachable from the UI.

**Non-Goals:**
- Explaining errors from external editors or shells.
- Sending error statistics anywhere.
- Multi-step recovery plans.

## Decisions

1. **Fixed action map in `src/main/ai/fixActions.ts`.** `FixActionId` union plus a table `{ id, label, risk, appliesTo(status): boolean, run: ApiMethods name(s) }`. The model may only name ids; validation maps unknowns to copy-only or drops them. Alternative: free-form commands executed via the palette policy, rejected to keep this feature minimal and safe.
2. **Applicability filter runs in main against `RepositoryStatus`** (`continue-rebase` needs `operation.kind === 'rebase'`; `push-set-upstream` needs no upstream; abort-X needs operation X). Risk is `max(model, map)`.
3. **Renderer executes fixes** by dispatching to the same action functions the menu uses, so `DiscardDialog`, force-push confirm and sign-in open unchanged. `retryAfter` invokes the original operation's `retry` callback.
4. **Scrubber is a pure function** masking `ghp_…`, `github_pat_…`, `Bearer …`, URL user info and `ANTHROPIC_API_KEY=` values; applied to stderr, stdout and command before prompt assembly; tails capped at 4,000 chars.
5. **Lock-file fix** checks `pgrep -x git` (POSIX) or `tasklist` (Windows) and the lock mtime before a `ConfirmDialog`; the deletion itself is the only filesystem write this feature adds.
6. **Automatic mode** (`AiSettings.explainErrorsAutomatically`, default false) only for `code === 'unknown'` to limit cost.

Prompt inputs: `code`, `command`, `exitCode`, scrubbed stderr/stdout tails, branch state (name, upstream, ahead/behind, upstream gone, detached), operation kind, changed and conflicted counts, remote names and hosts (≤10), last 10 reflog lines, platform and tool versions, the action map with one-line descriptions, `retryable`.

Schema:

```json
{ "type": "object",
  "properties": {
    "whatHappened": { "type": "string" }, "likelyCause": { "type": "string" },
    "fixes": { "type": "array", "items": { "type": "object",
      "properties": { "label": { "type": "string" }, "detail": { "type": "string" },
                      "action": { "type": ["string", "null"] }, "command": { "type": ["string", "null"] },
                      "retryAfter": { "type": "boolean" },
                      "risk": { "enum": ["safe", "changes-history", "discards-work", "touches-remote"] } },
      "required": ["label", "detail", "action", "command", "retryAfter", "risk"], "additionalProperties": false } } },
  "required": ["whatHappened", "likelyCause", "fixes"], "additionalProperties": false }
```

Types and IPC:

```ts
type FixActionId = 'fetch' | 'pull' | 'fetch-and-pull' | 'push-set-upstream' | 'force-push-with-lease' | 'stash-and-retry' | 'discard-and-retry' | 'remove-lock-file' | 'abort-merge' | 'abort-rebase' | 'abort-cherry-pick' | 'abort-revert' | 'continue-rebase' | 'open-sign-in' | 'open-remote-settings' | 'open-identity-settings' | 'rename-branch' | 'open-in-terminal';
interface ErrorFix { label; detail; action: FixActionId | null; command: string | null; retryAfter: boolean; risk }
interface ErrorExplanation { whatHappened; likelyCause; fixes: ErrorFix[]; model }
'ai.explainError'(repoPath: string | null, error: GitErrorInfo, retryable: boolean) → ErrorExplanation
AiSettings.explainErrorsAutomatically: boolean (default false)
```

## Risks / Trade-offs

- [Secrets in diagnostics] → scrubber unit-tested against token and URL patterns; only tails sent.
- [Fix suggested for wrong state] → applicability filter in main using live status.
- [Model recommends `--force`] → system prompt forbids it and the action map only has force-with-lease behind its dialog.
- [No repository context (clone failures)] → `repoPath` null limits fixes to sign-in, terminal and copy-only.
- [Windows shell for Run in terminal] → uses the configured shell via `app.openInShell`; displayed paths use forward slashes.
