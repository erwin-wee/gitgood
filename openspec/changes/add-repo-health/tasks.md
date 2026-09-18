# Tasks

## 1. Main process

- [x] 1.1 Create `src/main/git/health.ts` with the streamed rev-list → cat-file pipeline, first-three-spaces line parser and bounded top-N; verify with unit tests for paths with spaces and top-N selection, and a fixture repo containing a deleted 10 MB blob (fixture uses a ~1 MB random buffer instead, per implementer guidance, to keep the test fast)
- [x] 1.2 Add HEAD presence, first-commit lookup and LFS pointer detection for the top blobs; verify the fixture blob reports "not at HEAD" with the right first commit
- [x] 1.3 Extend `src/main/git/branches.ts` with committer date and `[gone]` parsing and add stale classification with a `staleBranchDays` threshold; verify with a parser test for `[ahead 2, behind 1]` and `[gone]` and a fixture with merged, inactive (`GIT_COMMITTER_DATE`) and upstream-gone branches
- [x] 1.4 Add `deleteManyBranches` recording tip SHAs and returning per-branch failures, `pruneRemote`, `gc`, `expireReflog`, and `count-objects -v` parsing; verify with fixture tests and a parser test
- [x] 1.5 Extend `src/main/repo/manager.ts` indicators with unpublished branch and stash counts and add the concurrency-limited `work()` scan skipping missing repositories; verify with two fixture repositories

## 2. IPC contract

- [x] 2.1 Add the new types, methods and the two settings to `src/shared/types.ts`, `src/shared/ipc.ts` and `src/main/ipc.ts`; verify typecheck

## 3. Renderer

- [x] 3.1 Build the health view shell with four independently loading, cancellable, retryable cards and the unborn-repository empty state; expose `actions.openHealth()`; verify with a smoke screenshot
- [x] 3.2 Implement the Large files card with Copy path, Add to .gitignore and conditional Track with LFS; verify on the fixture
- [x] 3.3 Implement the Stale branches card with multi-select, non-selectable current/default/protected rows, the bulk delete dialog and the Undo toast; verify delete, partial failure reporting and undo on the fixture
- [x] 3.4 Implement the Unpushed work card, Welcome screen card and opt-in row indicator with navigation to repository and branch; verify with two fixture repositories
- [x] 3.5 Implement the Housekeeping card with two-step confirmations for gc, prune remotes and expire reflog, disabled during operations; verify numbers against `git count-objects -v`
- [x] 3.6 Add the Repository menu item and a keyboard shortcut in `menu.ts`; verify the shortcut opens the view (uses `Ctrl+Shift+K`, not `Ctrl+Shift+H`, which was already bound to "Squash and Merge into Current Branch" — see implementation report)

## 4. Verification

- [x] 4.1 Run `npm run typecheck` and `npm test` and confirm both pass
- [x] 4.2 Smoke pass on the fixture: screenshot the four cards, bulk-delete two branches and undo, confirm the branch list is restored
