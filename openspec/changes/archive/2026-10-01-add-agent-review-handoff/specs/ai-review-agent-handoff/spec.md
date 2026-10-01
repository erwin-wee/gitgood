# Spec Delta

## Purpose

Hands completed AI review findings to a terminal coding agent (Claude Code, Codex, omp or a custom command) through files in the repository's git directory, lets the agent ask GitGood for a re-review through a deep link, and packages the workflow as an installable agent plugin.

## ADDED Requirements

### Requirement: Review runs are exported to the repository
When a review run finishes (complete, cancelled or failed) or a finding's dismissal changes, GitGood SHALL write the run to `<git-dir>/gitgood/review/` where `<git-dir>` is the repository's git directory as reported by git, so linked worktrees get their own export. The export SHALL consist of `runs/<runId>.json`, `runs/<runId>.md`, and copies at `latest.json` and `latest.md` reflecting the most recently finished run for the repository regardless of target; re-exporting an older run (for example when one of its findings is dismissed) SHALL refresh that run's own files without replacing the newer `latest.*`. `previousRunId` SHALL name the newest earlier exported run of the same target, and MUST NOT name a run that finished later. Each file SHALL be written to a temporary name and renamed into place. Runs beyond the review store's per-repository cap SHALL be pruned oldest first. Export failures SHALL be logged and MUST NOT fail the review.

#### Scenario: Pre-commit review completes
- **WHEN** a pre-commit review finishes with two findings
- **THEN** `latest.json` exists under the repository's git directory with both findings and `runs/<runId>.json` holds the same content

#### Scenario: Linked worktree
- **WHEN** the reviewed repository is a linked git worktree whose `.git` is a file
- **THEN** the export lands under that worktree's own git directory, not the main repository's

#### Scenario: Export directory not writable
- **WHEN** the git directory cannot be written
- **THEN** the review still completes and shows its findings, and a warning is logged

#### Scenario: Dismissal updates the export
- **WHEN** the user dismisses a finding of the exported run
- **THEN** the run's JSON and Markdown are rewritten with that finding marked dismissed

#### Scenario: Dismissal on a superseded run
- **WHEN** a newer run of another target has been exported and the user then dismisses a finding on the older run
- **THEN** the older run's own files are rewritten and `latest.*` still describe the newer run

### Requirement: Export content
`latest.json` and each `runs/<runId>.json` SHALL contain a `version` number, the run id, the previous run id for the same target or null, the repository path, the target (pull request number and SHAs, branch names and SHAs, or the pre-commit paths), the provider and model, start and finish times, the verdict and summary, the per-file review status, the count of findings dropped by validation, and every finding with its id, path, line range, severity, category, title, detail, suggestion, confidence and dismissed flag. Paths SHALL use forward slashes. The Markdown twin SHALL open with an instruction block for an agent, then list non-dismissed findings grouped by file and ordered blocker, warning, nit, each with its id, line range, title, detail and suggestion in a fenced block. The instruction block SHALL name the exact re-review command for the current platform for a pre-commit run, and for a pull request or branch run SHALL instead tell the agent not to request a re-review and to report its changes for the user to commit; the JSON's `rerun` field SHALL be null for those targets. Dismissed findings SHALL appear in the JSON with `dismissed: true` and SHALL be omitted from the Markdown.

#### Scenario: Ordering
- **WHEN** a run has a nit at line 3 and a blocker at line 40 in the same file
- **THEN** the Markdown lists the blocker before the nit

#### Scenario: Suggestion with CRLF content
- **WHEN** a finding's suggestion contains CRLF line endings
- **THEN** the Markdown fenced block preserves the suggestion text and the JSON keeps it byte for byte

#### Scenario: Windows repository path
- **WHEN** the repository is at `C:\work\app` on Windows
- **THEN** the JSON `repoPath` is the native path and every finding path uses forward slashes

#### Scenario: Instruction block
- **WHEN** an agent reads `latest.md` for a pre-commit run
- **THEN** the first section tells it to fix findings in severity order file by file, to trust title and detail over line numbers once a file changed, not to commit, and how to request a re-review

#### Scenario: Pull request run cannot be verified by a re-review
- **WHEN** an agent reads the export of a pull request or branch run
- **THEN** `rerun` is null and the instruction block tells it not to request a re-review because that review reads committed history, and to report its changes for the user to commit

### Requirement: Re-review deep link
GitGood SHALL accept `gitgood://review/rerun?repo=<percent-encoded path>`. When the path matches a repository in the repository list (case-insensitively on Windows and macOS), GitGood SHALL bring its window to the front and open that repository. When the most recent finished run was a pre-commit run it SHALL re-run the pre-commit review over the currently included files. When it was a pull request or branch run GitGood MUST NOT start a review, because that review reads committed history and would repeat its findings; it SHALL show a toast saying the fixes must be committed first, offering to review the pending changes instead. A run already in progress SHALL be left alone and a toast SHALL say so. When no repository matches, no run exists, or the AI provider is disabled, GitGood SHALL show a toast explaining why nothing ran and MUST NOT start a review.

#### Scenario: Rerun after agent edits
- **WHEN** an agent has edited two reviewed files and opens the rerun link for the repository
- **THEN** GitGood focuses, re-runs the latest review, and the new export replaces `latest.json` with a new run id whose `previousRunId` is the old run id

#### Scenario: Unknown repository
- **WHEN** the link names a path that is not in the repository list
- **THEN** a toast reads that the repository is not open in GitGood and nothing runs

#### Scenario: Run in progress
- **WHEN** a review is already running for that repository
- **THEN** the link is ignored with a toast and the running review continues

#### Scenario: Latest run is a pull request review
- **WHEN** the most recent finished run for the repository is a pull request or branch review
- **THEN** no review is started and a toast explains that the fixes must be committed first, with an action that reviews the pending changes

#### Scenario: Malformed link
- **WHEN** the URL has no `repo` parameter or a different path segment
- **THEN** the URL is ignored without an error dialog

### Requirement: Fix with agent action
The pull request review panel and the pre-commit findings strip SHALL offer a **Fix with agent** action when the run has at least one non-dismissed finding and the AI provider is enabled; the action SHALL be hidden when the provider is disabled and SHALL be disabled while a review is running. Activating it SHALL rewrite the export, then open the repository in the user's configured terminal running the configured agent command with `{file}` replaced by the path of the run's exported Markdown, escaped for the shell that terminal parses the command with. When the export cannot be written, or the configured command is not usable, the action SHALL report that and MUST NOT open a terminal. The first activation SHALL show a one-time notice that the findings, including diff excerpts, are handed to the chosen agent.

#### Scenario: Launch Claude Code
- **WHEN** the agent preset is Claude Code and the user activates Fix with agent on a pre-commit run
- **THEN** a terminal opens in the repository root running `claude` with a prompt that names `latest.md`

#### Scenario: Provider disabled
- **WHEN** the AI provider is disabled
- **THEN** no Fix with agent action is rendered

#### Scenario: Zero live findings
- **WHEN** every finding is dismissed
- **THEN** the action is not shown

#### Scenario: Terminal cannot run a command
- **WHEN** the configured terminal has no way to run a command in a new window
- **THEN** GitGood opens the terminal in the repository, copies the agent command to the clipboard, and shows a toast saying to paste it

#### Scenario: No terminal found
- **WHEN** no terminal application is found
- **THEN** the existing "Configure one in Options → Integrations" error is shown and nothing launches

#### Scenario: Custom command not yet filled in
- **WHEN** the agent is set to Custom and its template is empty or has no `{file}`
- **THEN** activating the action reports that the agent command must be set and opens no terminal

#### Scenario: Export cannot be written
- **WHEN** the git directory is not writable
- **THEN** the action reports the failure and opens no terminal, even if an export from an earlier run is still on disk

### Requirement: Agent command setting
Options → AI SHALL offer an **Agent for fixes** choice with presets Claude Code, Codex and omp and a Custom entry holding a command template. The template MUST contain `{file}`; saving a custom template without it SHALL be refused with an inline message. The setting SHALL default to Claude Code and SHALL be included in portable settings exports as a preference.

#### Scenario: Custom template validation
- **WHEN** the user enters a custom template without `{file}`
- **THEN** the field shows "The command must contain {file}" and the previous value stays in effect

#### Scenario: Preset expansion
- **WHEN** the preset is Codex
- **THEN** the launched command is `codex` with a prompt that names `latest.md`

### Requirement: Agent plugin folder
The repository SHALL contain a `plugin/` folder installable by Claude Code, Codex and omp from the same files: a Claude Code manifest, a Codex manifest, an omp package file, one `gitgood-review` skill, a slash command, a JSON hooks file with a session-start hook for Claude Code and Codex, and a session-start hook module for omp. The repository root SHALL carry a marketplace manifest listing the plugin. The skill SHALL instruct the agent to read `latest.json`, fix findings in severity order file by file, trust title and detail over line numbers once a file changed, never commit, trigger the re-review link, and re-read the export afterwards instead of reusing finding ids. The session-start hooks SHALL print one line naming the count of non-dismissed findings when an export with findings exists in the current repository and SHALL stay silent otherwise. Hook scripts MUST work with only git and a POSIX shell or Node available and MUST exit successfully when the export is absent.

#### Scenario: Hook with findings
- **WHEN** an agent session starts in a repository whose `latest.json` has three non-dismissed findings
- **THEN** the hook prints one line stating three findings and naming the slash command

#### Scenario: Hook without export
- **WHEN** the repository has no export
- **THEN** the hook prints nothing and exits successfully

#### Scenario: Skill metadata
- **WHEN** any of the three tools loads the skill
- **THEN** its SKILL.md frontmatter has `name` and `description` and the description names review findings from GitGood as the trigger

### Requirement: Data handling
The export MUST contain only data already present in the review run; it MUST NOT include API keys, tokens or the raw diff beyond finding suggestions. Launching the agent MUST NOT pass secrets or environment variables beyond the user's normal terminal environment.

#### Scenario: Export contents
- **WHEN** an export is inspected
- **THEN** it contains no provider credentials and no field that was not in the persisted run
