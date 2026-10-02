# Proposal

## Why

Only pure parsers in `src/shared` and a handful of main-process parsers have tests; git wrappers, IPC handlers and dialogs are verified by hand. Every planned feature changes those layers, so argument mistakes and Windows/Linux differences currently reach users first.

## What Changes

- Fixture-based tests for the main-process git wrappers using real temporary repositories with deterministic identities and dates and an optional bare `origin`.
- Tests for the `gh` wrapper against a stub `gh` executable on `PATH` driven by scenario files, and a stub `claude` for AI backends.
- A vitest `fixture` project alongside `unit`, an `electron` module mock for code that imports Electron, and an environment override for the interactive-rebase sequence editor so it runs under plain Node.
- A smoke runner that builds the app and drives it headless with `GITGOOD_SMOKE_SCRIPT`, asserting on store dumps and screenshot presence.
- A CI workflow running unit, fixture and smoke on Linux and Windows, uploading screenshots and logs on failure.

This change is tooling only and changes no user-visible behaviour, so it sets `skip_specs: true` and has no spec deltas.

## Capabilities

### New Capabilities

_None._

### Modified Capabilities

_None._

## Impact

- Commands used by helpers: `git init -b main`, `git init --bare`, `git -c user.name=… -c user.email=… commit`, `GIT_AUTHOR_DATE`/`GIT_COMMITTER_DATE`, `xvfb-run -a` on Linux CI, `electron-vite build` then `electron .`.
- Code: new `test/helpers/repo.ts`, `test/helpers/electron-mock.ts`, `test/helpers/gh-stub/` (Node script plus `gh` and `gh.cmd` launchers), `test/fixture/**`, `test/smoke/scenarios/*.json`, `scripts/smoke.mjs`, `vitest.config.ts` projects, `package.json` scripts `test:unit`, `test:fixture`, `test:smoke`, `.github/workflows/test.yml`. One small production change: `src/main/git/operations.ts` reads the sequence editor from `GITGOOD_SEQUENCE_EDITOR` when set instead of `process.execPath`.
- Tests never touch the developer's real git or gh configuration (temp `HOME`, `GIT_CONFIG_GLOBAL`, `GH_CONFIG_DIR`, `GITGOOD_USER_DATA`). No new runtime dependencies; no network in unit or fixture tests.
