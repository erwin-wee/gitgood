# Tasks

## 1. Types and persistence

- [x] 1.1 Add `WatchedFolder` (`{ path: string; depth: number }`), `RepositoryInfo.origin?: 'manual' | 'watched'`, `RepositoryScanResult` (`{ added: number; skipped: number; unreadable: number; cancelled: boolean; alreadyRunning?: boolean }`) and `RepositoryScanProgress` to `src/shared/types.ts`, plus `AppSettings.watchedFolders` with a `[]` default in `DEFAULT_SETTINGS`; verify `npm run typecheck` passes and that `watchedFolders` is absent from `PortablePreferences`
- [x] 1.2 Add `excludedRepositoryPaths: string[]` to `AppStateFile` in `src/main/store.ts` with getter/add/remove/clear methods that normalize paths the way `repositoryId()` does (lowercase on Windows); verify with a unit test in `test/watched-folders.test.ts` that a path added as `C:\A\B` is matched by `c:\a\b\` on Windows and not on POSIX
- [x] 1.3 Confirm an existing `repositories.json` written before this change still loads and that entries without `origin` are treated as `'manual'`; verify with a store test over a fixture file that omits the field

## 2. Discovery walker

- [x] 2.1 Create `src/main/repo/scan.ts` with `scanFolder(root, { depth, signal, onFound })` returning `{ repositories, unreadable, cancelled }`: level 0 is the root, descend while `level < depth`, treat a directory holding a `.git` dirent as a repository and do not descend into it, skip `node_modules`/`vendor`/`target`/`dist`/`build`/`out`/`.cache` and dot-directories, never follow symlinked directories, never report bare repositories; verify with temp-directory fixture tests in `test/watched-folders.test.ts` covering each of those rules
- [x] 2.2 Cover the depth boundary, a trailing-separator root, a symlink loop (`projects/self -> projects`) and an unreadable subdirectory (chmod 000, skipped on Windows and when running as root) in the same test file; verify the unreadable case is counted and does not abort the walk
- [x] 2.3 Make the walk cancellable through an `AbortSignal` and confirm it resolves with `cancelled: true` and stops issuing `readdir` calls; verify with a test that aborts after the first `onFound`

## 3. Scan orchestration

- [x] 3.1 Add `RepositoryManager.addMany(paths, opts)` in `src/main/repo/manager.ts`: skip excluded paths and repositories already in the list, resolve top level / worktree / GitHub with concurrency 3, persist once and send a single `repos.changed`, and mark newly added entries `origin: 'watched'` while leaving existing entries' origin, alias and `lastOpened` untouched; verify with a fixture test that adds two repositories in one call and asserts a single `repos.changed` payload
- [x] 3.1a Dedupe in `addMany` on `realpath(top-level)` rather than the stored path, falling back to the normalized path when `realpath` fails; verify with a fixture test that a repository listed under a symlinked path is not added a second time when found by its real path, and that a linked worktree is still added as an entry separate from its main repository
- [x] 3.2 Create `src/main/repo/watched-folders.ts` owning the single in-flight scan, the `AbortController`, batched `addMany` calls (batch of 10 or on folder completion) and the per-folder result; verify a second `scan()` while one runs resolves `{ alreadyRunning: true }` without starting a walk
- [x] 3.3 Implement the drop pass: after a folder's scan completes with `cancelled: false` and no unreadable ancestor on the path, remove `origin: 'watched'` repositories under that folder that no longer exist or are no longer repositories, without recording exclusions; verify with tests for the deleted-folder, cancelled-scan, unreadable-parent and manual-repository cases from the spec
- [x] 3.4 Record an exclusion in `RepositoryManager.remove` when the removed repository's path lies inside a registered watched folder, whatever its `origin`, and none when it lies outside every watched folder; verify with tests that remove a discovered repository, a hand-added repository inside a watched folder and a repository outside them all, asserting the first two are excluded and the third is not, and that a rescan re-adds none of them
- [x] 3.5 Validate folder registration in the settings path: reject a duplicate (platform-normalized), reject a folder nested inside an already-watched one with a message naming the covering folder, clamp depth to 1–10, and report missing / not-a-directory / unreadable folders as warnings without dropping the entry; verify with unit tests over the validator

## 4. IPC and wiring

- [x] 4.1 Add `repos.scanWatchedFolders`, `repos.cancelScan`, `repos.exclusions.list`, `repos.exclusions.remove`, `repos.exclusions.clear` to `src/shared/ipc.ts` and handlers in `src/main/ipc.ts`, plus the `repos.scanProgress` event payload; verify `npm run typecheck` passes
- [x] 4.2 Subscribe to `Store.onSettingsChanged` in `watched-folders.ts` and start a scan only when the watched-folder list or a depth actually changed (deep compare); verify with a test that an unrelated settings update (e.g. `theme`) starts no scan
- [x] 4.3 Kick off the launch scan from `src/main/index.ts` after the window's `ready-to-show`, guarded so an empty `watchedFolders` does no work; verify the app still starts with an empty profile and no scan is logged, and that a profile with a watched folder has its repositories listed on launch without any user action (smoke: watched-folders-launch)

## 5. Renderer

- [x] 5.1 Add a "Watched folders" section to the Git tab of `src/renderer/src/components/dialogs/SettingsDialog.tsx`: the folder list with a depth control and per-row warning, "Add folder…" using `app.chooseDirectory`, remove, and "Rescan now" with progress and a cancel action; verify with a smoke screenshot of the section holding two folders
- [x] 5.2 Add the exclusion list UI (paths, per-row un-exclude, "Clear all") to the same section, hidden when empty; verify by seeding an exclusion in the smoke profile and dumping the rendered list
- [x] 5.3 Mark discovered repositories in the repository list, and extend the removal confirmation to state that future scans will not add the repository back — shown for any repository inside a watched folder, whatever its origin, and not shown for repositories outside them all; verify by dumping `repos` after a scripted scan and screenshotting the confirmation in both forms
- [x] 5.4 Report the scan summary (added / skipped / unreadable, "no new repositories found", cancelled) through the existing toast surface; verify each variant appears in a smoke run

## 6. Documentation

- [x] 6.1 Document watched folders in the README Features list and in `docs/` (where repositories are described), including that scans run on launch, on settings change and on demand, and that folders are never exported; verify the README mentions the capability before this change is archived

## 7. Verification

- [x] 7.1 Run `npm run typecheck` and `npm test` and confirm both pass
- [x] 7.2 Smoke pass: register a temp folder holding two repositories at different depths plus a `node_modules` decoy, scan, confirm both appear and the decoy does not; remove one, rescan and confirm it stays gone; un-exclude it, rescan and confirm it returns; delete the other on disk, rescan and confirm it leaves the list
- [x] 7.3 Smoke pass on the two amended behaviours: add a repository by hand from inside the watched folder, remove it, rescan and confirm it stays gone; add a third repository to the list through a symlink to a path inside the watched folder, rescan and confirm the list still holds one entry for it
