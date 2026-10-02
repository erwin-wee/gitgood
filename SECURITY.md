# Security policy

## Supported versions

Only the latest release receives security fixes (currently the 0.3 line). GitGood updates itself from the [Releases page](https://github.com/erwin-wee/gitgood/releases), so please reproduce on the newest version before reporting.

## Reporting a vulnerability

Please **do not open a public issue**. Report it privately with a GitHub security advisory:

1. Go to <https://github.com/erwin-wee/gitgood/security/advisories/new> (Repository → Security → Advisories → **Report a vulnerability**).
2. Describe the impact, the affected version and operating system, and the steps to reproduce. A proof of concept helps; please don't include real credentials.

This is a small, mostly solo-maintained project: expect an acknowledgement within a few days and a fix or a mitigation plan as soon as it can be made. You'll be credited in the advisory unless you prefer not to be.

## What is in scope

- The desktop app (Electron main, preload and renderer), including how it runs `git`, `gh` and AI-CLI commands and how it reads repository content.
- Server mode (`src/server`) and the desktop's client mode.
- The MCP server (`src/mcp`), the `gitgood://` protocol handler and the `gitgood-review` plugin.
- The installer script and the release pipeline (`scripts/`, `.github/workflows/`).
- What GitGood sends to an AI provider and what it writes to disk or logs (see [docs/AI-FEATURES.md](docs/AI-FEATURES.md#privacy-what-is-sent-and-what-never-is)).

Out of scope: vulnerabilities in `git`, `gh`, Electron or an AI provider themselves (report those upstream), an attacker who already runs code as your user, and the fact that releases are not yet code-signed (tracked in [docs/RELEASING.md](docs/RELEASING.md#signing)).

## Threat model notes

**Desktop.** GitGood drives the `git` and `gh` you already have; it stores no GitHub credentials of its own (`gh` does). API keys are stored encrypted with the OS credential store where Electron provides one; otherwise they are written to `secrets.json` with `0600` permissions in a `0700` directory. Repository files that feed the AI or configuration are never followed through symlinks, a repository's check command needs your explicit one-time trust, and logs have tokens and credentials scrubbed.

**Server mode** executes `git`, `gh`, shell and AI-CLI commands **as the host user**, so anything that can reach it effectively has that user's access. It is protected by four independent layers:

- **Loopback only.** It binds `127.0.0.1`, never `0.0.0.0`, and only answers to `127.0.0.1`, `localhost` and `*.ts.net` host names (against DNS rebinding). Public exposure (`tailscale funnel`) is never enabled by GitGood.
- **Tailscale identity.** Requests arriving through `tailscale serve` must carry the allowed `Tailscale-User-Login` (by default the node's owner, or `GITGOOD_ALLOWED_LOGIN`); other users and tagged devices are refused.
- **Bearer token.** A 256-bit token, stored `0600` in the data directory, is required on `/invoke` and the `/events` WebSocket and is never logged.
- **Path confinement.** Paths must lie inside the user's home directory, registered repositories, watched folders, the default clone directory or `GITGOOD_ALLOWED_ROOTS`; absolute and `../` repository-relative paths are rejected before any command runs.

If you run the server on another machine or in a VM, you take on that machine's trust boundary: keep the token private, use a dedicated user, and don't widen `GITGOOD_ALLOWED_ROOTS` or `GITGOOD_ALLOWED_LOGIN` more than you need. See the README's [Server mode](README.md#server-mode-web-access-over-your-tailnet) section.

**AI features** send repository content (diffs, file context, commit messages) to the provider you configure: Anthropic's API, your local Claude Code, or an OpenAI-compatible server. Secret-shaped files are excluded and known token shapes are masked, but this is a best-effort filter, not a guarantee; use the per-repository AI opt-out for sensitive repositories.
