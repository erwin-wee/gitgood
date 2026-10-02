# Design

## Context

See proposal.md. `GitClient` and `GhClient` already take an injected `ToolLocator`; `exec.ts` runs processes without a shell; interactive-rebase automation uses `process.execPath` with `ELECTRON_RUN_AS_NODE=1` as `GIT_SEQUENCE_EDITOR`; `store.ts`, `ipc.ts` and `window.ts` import `electron`. The smoke harness (`GITGOOD_SMOKE_SCRIPT`, `window.__gitgood`) exists in `src/main/index.ts`.

## Goals / Non-Goals

**Goals:** real-git coverage of every wrapper, deterministic and isolated, under 3 minutes on CI, on Linux and Windows.

**Non-Goals:** pixel-diff visual regression, macOS runners, coverage thresholds (report first).

## Decisions

- **Real temporary repositories, not mocks.** `createRepo({ commits, branches, remote })` in `test/helpers/repo.ts` uses `git init -b main`, `-c` identity, fixed dates for stable SHAs, `core.autocrlf=false`, short paths under the OS temp dir, and cleanup with `fs.rm({ maxRetries })` for Windows `EBUSY`. Alternative: mocking `exec` (rejected, cannot catch argument mistakes).
- **Stub `gh` on PATH.** A Node script with `gh` (POSIX) and `gh.cmd` (Windows) launchers prepended to `PATH`; `GH_STUB_SCENARIO` points at JSON rules `{ match, stdout, stderr, exitCode, delayMs, headers }`; every invocation is appended to `GH_STUB_LOG` for assertions; unmatched calls exit 99 loudly. The same mechanism provides a stub `claude` returning canned JSON for AI backends.
- **Electron mock.** vitest alias `electron` → `test/helpers/electron-mock.ts` exposing `app.getPath`, identity `safeStorage` and no-op `BrowserWindow`, only in the fixture project.
- **Sequence editor override.** `operations.ts` uses `process.env.GITGOOD_SEQUENCE_EDITOR` when set so squash/reorder/reword/drop run under plain Node in tests.
- **vitest projects.** `unit` (current include) and `fixture` (`test/fixture/**/*.test.ts`, `testTimeout: 30000`, `pool: 'forks'`); `npm test` runs both, fixture tests skip with a message when `git` is missing.
- **Smoke runner.** `scripts/smoke.mjs` builds, creates a fixture repo and `GITGOOD_USER_DATA`, launches `electron .` with a scenario from `test/smoke/scenarios/*.json`, waits for exit, asserts JSON-path expectations on dumps and non-zero screenshot dimensions. Linux uses `xvfb-run -a`; Windows runs on the default desktop session. Scenarios needing GitHub are tagged `requires-network` and excluded in CI.
- **Isolation.** `HOME`/`USERPROFILE`, `XDG_CONFIG_HOME`, `GIT_CONFIG_GLOBAL`, `GH_CONFIG_DIR` and `GITGOOD_USER_DATA` all point at temp directories; the watcher and auto-fetch are disabled through a no-op watcher factory.

## Risks / Trade-offs

- [Windows file locking during cleanup] → close handles before cleanup, `fs.rm` with retries, short paths.
- [Git version differences change output] → assert on messages and structure rather than SHAs where output may vary.
- [Smoke flakiness from timing] → explicit `wait` steps, paint-wait timeout already in the harness.
- [Fixture tests slow the suite] → forks pool, 30 s timeout per test, target under 3 minutes total.
