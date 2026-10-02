# gitgood-review plugin

Lets a terminal coding agent fix the AI review findings that [GitGood](https://github.com/erwin-wee/gitgood) exports, and ask GitGood to re-review when it is done. One folder serves Claude Code, Codex and omp:

| File | Read by |
| --- | --- |
| `skills/gitgood-review/SKILL.md` | all three (the workflow itself) |
| `commands/gitgood-review.md` | Claude Code and omp (`/gitgood-review`) |
| `hooks/hooks.json` + `hooks/session-start.sh` | Claude Code and Codex (one-line reminder when a repository has open findings) |
| `hooks/pre/session-start.ts` | omp (same reminder) |
| `.mcp.json` | Claude Code and omp (the GitGood MCP server, see [MCP server](#mcp-server)) |
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

After a **pre-commit** review the agent finishes by opening `gitgood://review/rerun?repo=<path>&token=<single-use token>` (the exact command is in `latest.json` under `rerun.command`). GitGood, if running with that repository in its list, re-runs the review (a link without a valid, unspent token first asks the user to confirm the repository and files) over the working tree and rewrites `latest.json` with a new `runId` whose `previousRunId` points at the run the agent worked from.

After a **pull request or branch** review, `rerun` is `null` and the agent stops instead: those reviews read committed history, so they cannot see edits still in the working tree. Commit the agent's changes in GitGood and press Re-review.

## MCP server

GitGood ships a small [MCP](https://modelcontextprotocol.io) server (stdio, no dependencies, source in `src/mcp`, built to `out/mcp/index.mjs`) so an agent can use the handoff as tools instead of reading files and running `xdg-open`:

| Tool | Does |
| --- | --- |
| `gitgood_latest_review` (`repoPath`) | The open findings of the latest export (file, line, severity, title, message, suggestion) plus the re-review link. Read-only. |
| `gitgood_request_rereview` (`repoPath`) | Opens the export's single-use `gitgood://review/rerun` link so GitGood re-reviews the working tree. Fails when the latest review has no link (pull request and branch reviews). |
| `gitgood_open_repository` (`path`) | Opens the repository in GitGood (starts the app, or hands the folder to the running one). |

`repoPath` may be any folder inside the repository or a linked worktree; the export is looked up in that checkout's own git directory, as the app does.

**Plugin.** `.mcp.json` registers the server for Claude Code and omp when the plugin is installed. It starts the installed app's own runtime in Node mode (`ELECTRON_RUN_AS_NODE=1 gitgood -e <import app.asar/out/mcp/index.mjs>`), so it needs the `gitgood` command on `PATH` (the Linux installer creates it). On macOS use `/Applications/GitGood.app/Contents/MacOS/GitGood`, on Windows `%LOCALAPPDATA%\Programs\GitGood\GitGood.exe`, as `command` in your own copy of the entry (below).

**Any MCP client, installed app.** Same command and environment as `.mcp.json`. Codex (`~/.codex/config.toml`):

```toml
[mcp_servers.gitgood]
command = "gitgood"
args = ["-e", "import(require('node:url').pathToFileURL(require('node:path').join(process.resourcesPath,'app.asar','out','mcp','index.mjs')).href)", "--", "--no-sandbox"]
env = { ELECTRON_RUN_AS_NODE = "1" }
```

omp (`~/.omp/agent/mcp.json`, or `.omp/mcp.json` per project) takes the `mcpServers` entry from `.mcp.json` unchanged.

**From a checkout.** `npm run build` (or just `npm run build:mcp`), then point the client at `node /path/to/gitgood/out/mcp/index.mjs`, e.g. `claude mcp add gitgood -- node /path/to/gitgood/out/mcp/index.mjs`. `gitgood_open_repository` then needs a GitGood executable to start: put `gitgood` on `PATH` or set `GITGOOD_APP` to the executable (a running GitGood must have been started from that same build for the folder to land in it).
