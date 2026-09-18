# gitgood-review plugin

Lets a terminal coding agent fix the AI review findings that [GitGood](https://github.com/erwin-wee/gitgood) exports, and ask GitGood to re-review when it is done. One folder serves Claude Code, Codex and omp:

| File | Read by |
| --- | --- |
| `skills/gitgood-review/SKILL.md` | all three (the workflow itself) |
| `commands/gitgood-review.md` | Claude Code and omp (`/gitgood-review`) |
| `hooks/hooks.json` + `hooks/session-start.sh` | Claude Code and Codex (one-line reminder when a repository has open findings) |
| `hooks/pre/session-start.ts` | omp (same reminder) |
| `.claude-plugin/plugin.json`, `plugin.json`, `package.json` | Claude Code, Codex, omp manifests |

GitGood writes the findings to `<git-dir>/gitgood/review/latest.json` and `latest.md` after every review, so the plugin needs no server, CLI or network access. The **Fix with agent** button in GitGood opens your terminal with the agent already pointed at `latest.md`; the plugin adds discovery (the session-start reminder) and the slash command on top.

## Install

**Claude Code**

```
/plugin marketplace add erwin-wee/gitgood
/plugin install gitgood-review@gitgood
```

**Codex** — open the plugin browser with `/plugins` after adding this repository as a marketplace, install `gitgood-review`, then start a new session. Alternatively copy `skills/gitgood-review` into `~/.agents/skills/` (or the repository's `.agents/skills/`) to get the skill without the plugin. Note: the marketplace registration key for the Codex CLI is not shown in the Codex docs at the time of writing; the skill-folder copy always works.

**omp**

```
omp plugin install gitgood-review@gitgood
```

after adding this repository as a marketplace (omp reads `.claude-plugin/marketplace.json`). The skill is also picked up from `.agents/skills/gitgood-review` in a repository.

## Without the plugin

The exported `latest.md` starts with the same instructions as the skill, so any agent started with a prompt like *"Read .git/gitgood/review/latest.md and fix every finding it lists. Do not commit."* works too. That is what GitGood's **Fix with agent** button runs (configurable under Options → AI → Agent for fixes).

## Re-review

After a **pre-commit** review the agent finishes by opening `gitgood://review/rerun?repo=<path>` (the exact command is in `latest.json` under `rerun.command`). GitGood, if running with that repository in its list, re-runs the review over the working tree and rewrites `latest.json` with a new `runId` whose `previousRunId` points at the run the agent worked from.

After a **pull request or branch** review, `rerun` is `null` and the agent stops instead: those reviews read committed history, so they cannot see edits still in the working tree. Commit the agent's changes in GitGood and press Re-review.
