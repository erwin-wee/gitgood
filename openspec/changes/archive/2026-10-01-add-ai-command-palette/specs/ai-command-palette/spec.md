# Spec Delta

## Purpose

Lets the user describe a git task in plain language and get back an exact, previewed plan of git commands that GitGood runs only after confirmation and only within a strict allowlist.

## ADDED Requirements

### Requirement: Palette opens with built-in actions and optional AI
A command palette SHALL open with `Ctrl+K` or Repository → Ask GitGood…, over the current repository. It SHALL first fuzzy-match built-in actions (push, pull, new branch, and the other menu actions) without any AI call. An **Ask AI** row SHALL send the text to the model when the user selects it or when no built-in action matches well. The Ask AI row SHALL be absent when the AI provider is `disabled` or the palette AI setting is off; built-in matching SHALL still work.

#### Scenario: Built-in match
- **WHEN** the user types "push"
- **THEN** the Push action is listed and can be run without contacting the model

#### Scenario: Provider disabled
- **WHEN** the AI provider is `disabled`
- **THEN** the palette shows built-in actions only and no Ask AI row

#### Scenario: Cancel while asking
- **WHEN** the user presses Escape while a plan request is in flight
- **THEN** the request is cancelled and the palette returns to its input state

### Requirement: Plans are made of exact git commands with explanations and risk
A plan SHALL consist of at most 8 numbered steps, each showing the exact git command, a one-line explanation and a risk classification of safe, changes history, discards work or touches remote. Steps that GitGood will not execute SHALL be shown greyed with the reason and a copy action. The request context sent to the model SHALL be limited to repository metadata (branch state, branch names, last 30 commits, stash messages, remote names, tags) and SHALL NOT include file contents.

#### Scenario: Plan rendered
- **WHEN** the model returns two executable steps
- **THEN** the palette shows both commands in monospace with explanations and risk chips

#### Scenario: Too many steps
- **WHEN** the model returns more than 8 steps
- **THEN** the plan is rejected with a message asking the user to split the request

### Requirement: Executability is decided by an allowlist policy, not by the model
Every step SHALL be matched against an allowlist of git command shapes covering inspect, branch, commit, stash, sync, integrate, discard and tag families. A step that does not match, that contains any shell metacharacter, that is on the denylist (force push without lease, history-rewriting maintenance commands, global config, remote URL changes, submodule or worktree writes, clean with `-x`, any non-git command, pipes, redirects, chaining or environment assignments), or that references a ref that does not exist SHALL be marked non-executable with a reason. A leading `git` token SHALL be stripped. Discard steps SHALL name paths inside the repository that exist in the current status.

#### Scenario: Denylisted command
- **WHEN** a step is `push --force`
- **THEN** it is shown copy-only with the reason that force pushes without lease are not run by GitGood

#### Scenario: Shell operator
- **WHEN** a step contains `&&` or `|`
- **THEN** the step is non-executable and the reason names the shell operator

#### Scenario: Unknown reference
- **WHEN** a step refers to a branch that does not exist in the repository
- **THEN** the step is non-executable with an unknown reference reason

#### Scenario: Operation in progress
- **WHEN** a merge or rebase is in progress
- **THEN** only abort, continue, status, diff and log families are executable and other steps are refused with that reason

### Requirement: Risk is recomputed by policy
The risk shown for a step SHALL be the higher of the model's classification and the policy's own classification derived from the command, so a step the model calls safe SHALL still be treated as destructive when the command is.

#### Scenario: Model understates risk
- **WHEN** the model labels `reset --hard HEAD~1` as safe
- **THEN** the step is shown and treated as discards work

### Requirement: Previews show the effect before confirmation
For steps with a known preview, GitGood SHALL run a read-only command and show the affected items before the user runs the plan: commits that a reset or rebase would rewrite, files a restore or clean would discard, whether a branch to delete is merged, and ahead/behind counts for a force push with lease.

#### Scenario: Reset preview
- **WHEN** the plan contains `reset --soft HEAD~2`
- **THEN** the preview lists the two commits that will be uncommitted

#### Scenario: Discard preview
- **WHEN** the plan contains `restore src/`
- **THEN** the preview lists the changed files under that path from the current status

### Requirement: Execution requires confirmation and honours existing safeguards
No step SHALL run before the user clicks **Run plan**. Steps SHALL run sequentially through GitGood's existing operations; steps that change history or discard work SHALL open the existing confirmation dialogs (including the force-push and discard dialogs and Recycle Bin behaviour), and cancelling a dialog SHALL stop the plan. A failing step SHALL stop the plan and the completed steps SHALL be listed. Every executed step SHALL be written to the application log with its arguments and exit code. Denylisted steps SHALL never run.

#### Scenario: Destructive step confirmed
- **WHEN** a plan reaches a `reset --hard` step
- **THEN** the existing confirmation dialog opens and nothing happens until the user confirms

#### Scenario: Confirmation cancelled
- **WHEN** the user cancels the confirmation for step 2 of 3
- **THEN** step 2 and 3 do not run and step 1 is listed as completed

#### Scenario: Audit log
- **WHEN** any step is executed
- **THEN** the log contains the step's arguments and exit code

### Requirement: Ambiguous requests produce a clarifying question
When the request is ambiguous, the model MAY return a single clarifying question. When a question is present, any steps returned alongside it SHALL be discarded and only the question shown; the user's answer SHALL be sent with the original request for one further round.

#### Scenario: Which commit
- **WHEN** the user asks to "branch from the logging commit" and several commits mention logging
- **THEN** the palette shows a question listing the candidates and no steps

#### Scenario: Answer round
- **WHEN** the user answers the question
- **THEN** a plan is requested with the original text, the question and the answer, and no further question is accepted

### Requirement: Palette keeps a session history
The palette SHALL keep the last 20 plans and results in memory for the session with a **Copy commands** action, and SHALL discard them when the app exits.

#### Scenario: History entry
- **WHEN** a plan has run
- **THEN** it appears in the palette history with its commands and outcome and can be copied
