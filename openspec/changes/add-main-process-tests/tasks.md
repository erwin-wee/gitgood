# Tasks

## 1. Helpers and configuration

- [x] 1.1 Add `test/helpers/repo.ts` (`createRepo`, `commit`, bare remote, cleanup with retries) and verify a sample fixture test creates and removes a repository on Linux and Windows
- [x] 1.2 Add `test/helpers/electron-mock.ts` and the vitest alias for the fixture project; verify a test importing `src/main/store.ts` runs under vitest
- [x] 1.3 Add `test/helpers/gh-stub/` with the Node script, `gh` and `gh.cmd` launchers, scenario matching, invocation log and exit-99 on unmatched calls; verify with a test that asserts the log and the failure path
- [x] 1.4 Split `vitest.config.ts` into `unit` and `fixture` projects and add `test:unit`, `test:fixture`, `test:smoke` scripts with `test` running unit and fixture; verify `npm test` runs both and fixture tests skip cleanly when `git` is absent
- [x] 1.5 Read `GITGOOD_SEQUENCE_EDITOR` in `src/main/git/operations.ts` when set; verify squash runs under plain Node in a fixture test

## 2. Git wrapper fixture tests

- [x] 2.1 `status.ts`: staged, unstaged, untracked, renamed and conflicted entries; verify all pass
- [x] 2.2 `log.ts` and `commit.ts`: history paging and search, commit with partial patch, undo and amend; verify all pass
- [x] 2.3 `branches.ts` and `operations.ts`: create/rename/delete, merge with conflict and abort, rebase with conflict and continue, squash/reorder/reword/drop, stash push/pop/apply/drop, tags, fetch/push/pull outcomes against a bare origin, `useSide`/`markResolved`/`unresolve`; verify all pass

## 3. gh and AI stub tests

- [x] 3.1 `gh.ts` against the stub: `account()`, `prList`, `prView`, `prChecks`, `prCreate` argument shapes, device-code parsing in `login`, auth and rate-limit error classification; verify all pass
- [x] 3.2 Stub `claude` on PATH returning canned JSON and a resolver test exercising `src/main/ai/resolver.ts` end to end without network; verify it passes

## 4. Smoke suite and CI

- [x] 4.1 Add `scripts/smoke.mjs` and scenarios for first-launch Welcome, open fixture repo, stage and commit, switch branch, History selection, Conflicts dialog on a conflicted fixture, AI resolve with the stub; verify `npm run test:smoke` passes locally with screenshots and dumps under `test/smoke/out/`
- [ ] 4.2 Add `.github/workflows/test.yml` with a Linux and Windows matrix running unit, fixture and smoke (`xvfb-run -a` on Linux), uploading screenshots and logs on failure; verify a green run on both
- [x] 4.3 Add an isolation test that points `HOME` at a temp dir and asserts nothing outside temp directories was written; verify it passes

## 5. Verification

- [x] 5.1 Run `npm run typecheck` and `npm test` and confirm both pass in under 3 minutes on CI
