# Design

## Context

See proposal.md. GitGood never runs a shell for git: `exec.ts` spawns `git` with argv arrays and `GIT_TERMINAL_PROMPT=0`, and every operation has a typed wrapper reachable through `ApiMethods`. Destructive actions already have dialogs (`DiscardDialog`, force-push confirm, undo confirm). The palette must reuse those, and the model output must be treated as untrusted input.

## Goals / Non-Goals

**Goals:**
- Policy in code decides what runs; the model only proposes.
- Execution goes through existing wrappers so classification, confirmations and Recycle Bin behaviour apply unchanged.
- One request at a time per repository.

**Non-Goals:**
- Multi-turn conversation beyond one clarifying question.
- Executing `gh` commands.
- Learning user aliases.

## Decisions

1. **Policy module `src/main/ai/nlPolicy.ts` is pure and unit-tested.** It parses `argv`, strips a leading `git`, rejects shell metacharacters (`; | & > < \` $(`), matches allowlist shapes as a small grammar per family, applies the denylist, recomputes risk and maps the step to an `ApiMethods` name (`mappedAction`). Alternative: asking the model for the action id directly, rejected because it would let the model choose the executor.
2. **Allowlist shapes and mapping** (executed via wrapper when listed, else `git.tryRun` read-only for inspect):
   - Inspect: `status`, `log …`, `show …`, `diff …`, `branch -a`, `stash list`, `reflog`, `rev-parse …` → read-only `tryRun`.
   - Branch: `switch|checkout <b>`, `checkout -b <b> [start]`, `branch -m <a> <b>`, `branch -d <b>` → `git.checkout`, `git.branch.create`, `git.branch.rename`, `git.branch.delete`.
   - Commit: `commit --amend`, `reset --soft <ref>`, `revert <sha>`, `cherry-pick <sha…>` → `git.undoCommit`, `git.revert`, `git.cherryPick`.
   - Stash: `stash push [-u] [-m]`, `stash pop|apply|drop` → `git.stash.*`.
   - Sync: `fetch`, `pull`, `push`, `push -u origin <b>`, `push --force-with-lease` → `git.fetch/pull/push`.
   - Integrate: `merge <b>`, `rebase <b>`, `merge --abort`, `rebase --abort|--continue` → `git.merge`, `git.rebase`, aborts/continue.
   - Discard: `restore <paths>`, `checkout -- <paths>`, `clean -fd <paths>`, `reset --hard <ref>` → `git.discard`, `git.discardAll`, reset behind confirm.
   - Tags: `tag <name> [sha]`, `tag -d <name>`, `push origin <tag>` → `git.tag.*`.
3. **Previews are a fixed table in the planner**: `reset` → `git log --oneline <target>..HEAD`; `checkout/restore/clean` → status filtered to paths; `branch -d` → `git log -1` plus `git branch --merged`; `rebase` → `git log --oneline <onto>..HEAD`; `push --force-with-lease` → `git rev-list --left-right --count @{u}...HEAD`. Refs verified with `git rev-parse --verify` before preview.
4. **Execution is orchestrated in the renderer** (`ai.nl.run` per confirmed step ids) so existing dialogs open as they do for manual actions; the main process emits `ai.nl.progress` with `awaiting-confirmation` for destructive steps. Alternative: running the whole plan in main, rejected because dialogs live in the renderer.
5. **Prompt inputs**: request, prior question/answer, repository context (status, branches ≤100, last 30 commits, stashes, remotes, tags ≤50), allowlist and denylist summaries, platform note. Branch names and subjects are data; the policy layer ensures injected text cannot widen the allowlist.

Schema:

```json
{ "type": "object",
  "properties": {
    "clarifyingQuestion": { "type": ["string", "null"] },
    "steps": { "type": "array", "items": { "type": "object",
      "properties": { "argv": { "type": "array", "items": { "type": "string" } },
                      "explanation": { "type": "string" },
                      "risk": { "enum": ["safe", "changes-history", "discards-work", "touches-remote"] } },
      "required": ["argv", "explanation", "risk"], "additionalProperties": false } } },
  "required": ["clarifyingQuestion", "steps"], "additionalProperties": false }
```

Types and IPC:

```ts
type NlRisk = 'safe' | 'changes-history' | 'discards-work' | 'touches-remote';
interface NlStep { id; argv: string[]; display; explanation; risk: NlRisk; executable: boolean; refusalReason: string | null; preview: { title; lines: string[] } | null; mappedAction: string | null }
interface NlPlan { id; request; steps: NlStep[]; clarifyingQuestion: string | null; model }
interface NlRunResult { planId; completed: string[]; failedStep: string | null; error: GitErrorInfo | null }
'ai.nl.plan'(repoPath, request, priorQuestion | null) → NlPlan
'ai.nl.preview'(repoPath, step) → NlStep
'ai.nl.run'(repoPath, plan, confirmedStepIds) → NlRunResult
event 'ai.nl.progress': { planId; stepId; phase: 'running' | 'done' | 'error' | 'awaiting-confirmation' }
AiSettings.nlPaletteEnabled: boolean (default true); menu action 'command-palette' on Ctrl+K
```

## Risks / Trade-offs

- [Prompt injection via repo data] → executability and risk decided in code; model output never reaches a shell.
- [Detached HEAD or in-progress operation] → policy refuses push without a branch and limits families during merge/rebase.
- [Windows paths] → paths validated as repo-relative POSIX; argv passed to `exec` without a shell.
- [User trusts the explanation over the preview] → previews shown by default and destructive steps still open dialogs.
- [Ctrl+K collision] → the shortcut is currently unbound in `menu.ts`; verify against the README shortcut list before wiring.

## Open Questions

- Whether `clean -fd` should be offered at all or always copy-only; safe to decide during implementation since both satisfy the spec.
