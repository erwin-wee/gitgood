# Tasks

## 1. Dependency review

- [ ] 1.1 Run the new-dependency review for `electron-updater` (maintainer, downloads, licence, transitive deps, supply chain) and record the outcome and approval link in this change's design.md; verify the record exists before any `package.json` change
  - Awaiting the dependency review (see design.md's 2026-09-17 decision note). Not run in this pass; no approval exists.
- [ ] 1.2 On approval, add `electron-updater` and the `publish` block to `electron-builder.yml`; verify `npm install` and `npm run build` succeed and the build emits `latest*.yml`
  - Awaiting 1.1's approval. `package.json` and `electron-builder.yml`'s `publish` block were deliberately left untouched.

## 2. Shared contract and settings

- [x] 2.1 Add `UpdateState`, the `app.update.*` methods and `app.update.changed` event, the three settings with defaults and `dismissedUpdateVersion`; verify `npm run typecheck`
  - `src/shared/types.ts` (`UpdateState`, `UpdateChannel`, `checkForUpdatesAutomatically`/`autoDownloadUpdates`/`updateChannel` settings), `src/shared/ipc.ts` (`app.update.*` methods, `app.update.changed` event), `src/main/store.ts` (`dismissedUpdateVersion` in `AppStateFile`). `npm run typecheck` passes.

## 3. Main process

- [x] 3.1 Implement the updater module: launch and 6-hour checks honouring the setting, channel/prerelease filter, no downgrades, state reducer emitting `app.update.changed`, progress forwarding; verify reducer and filter unit tests
  - `src/main/update/updater.ts` (launch + 6-hour checks, gated on `checkForUpdatesAutomatically`, manual checks always run), `src/main/update/update-core.ts` (`compareVersions`/`isNewerVersion`, `isEligibleForChannel`, `reduceUpdateState`), `src/main/update/github-provider.ts` and `provider.ts` (the `UpdateProvider` seam). Unit tests: `test/update-core.test.ts`, `test/update-provider.test.ts`, `test/fixture/updater.test.ts`, `test/fixture/update-provider-gh.test.ts`. "Progress forwarding" does not apply to the fallback (it never downloads, so there is no download progress to forward); the `downloading` state stays wired into `UpdateState`/`ProgressEvent`'s `kind: 'generic'` pattern for a future downloader-backed provider.
- [ ] 3.2 Implement the install gate (operation in progress, AI active), current-repository persistence before quit, per-machine Windows fallback, and disabled state for unpackaged/portable/unsigned-macOS/read-only AppImage; verify gating unit tests and a smoke run reporting *Updates unavailable in this build* when unpackaged
  - Done: the install gate (`canInstall` in `update-core.ts`, unit-tested for merge/rebase/cherry-pick/revert and AI-active), current-repository persistence in the `app.update.install` handler (`src/main/ipc.ts`), and disabled-state detection for all four cases (`detectDisabledReason`, unit-tested) — confirmed live in a smoke run (`test/smoke/scenarios/20-update-banner.json`, `about-disabled.json`/`.png`: real bootstrap state is `disabled` with the exact text *Updates unavailable in this build*).
  - Left unchecked because the "per-machine Windows fallback" (detecting a per-machine NSIS install and using a visible installer instead of a silent one) has nothing to implement against yet: the fallback provider has no installer at all (`app.update.install` always refuses with "Automatic installation is not available in this build yet…" once the gate passes), so silent-vs-visible install is meaningless until a real downloader/installer exists — the same blocker as 1.1/1.2.
- [x] 3.3 Log updater events through `logger.ts` without tokens; verify log lines in a smoke run
  - `Updater` logs the disabled reason on `start()` and each check's start/result/error via `log.info`/`log.warn` (never anything from `gh` output beyond a plain error message, never a token). Verified manually with `GITGOOD_USER_DATA` under `/tmp`: `Updater disabled: Updates unavailable in this build (development / unpackaged).` appears in `gitgood.log` on an unpackaged run (which is every dev/smoke run).

## 4. Renderer

- [x] 4.1 Build the ready banner (Restart, Release notes, Later) in `Banners.tsx` at lowest priority, the About section with version, channel and Check now, and Options → Advanced toggles; verify with an injected `UpdateState` via `actions.setUpdateState`
  - `src/renderer/src/components/Banners.tsx` (banner, lowest priority, shown even with no repository open), `src/renderer/src/components/dialogs/SettingsDialog.tsx` (`AboutDialog`'s channel/status/Check now, `AdvancedTab`'s Updates section, `UpdateNotesDialog`), `src/renderer/src/state/actions.ts` (`setUpdateState` exposed on `window.__gitgood.actions`, `checkForUpdates`, `downloadUpdate`, `dismissUpdate`, `openUpdateNotes`). The banner's primary action is **Download** (opens the release page), not **Restart to update** — the fallback never reaches the `ready` state a real installer would produce, per this change's scope decision. Verified with an injected `UpdateState` in `test/smoke/scenarios/20-update-banner.json`.
- [x] 4.2 Add Help → Check for updates… in `src/main/menu.ts` with up-to-date and error messaging; verify the menu action reaches the renderer
  - `src/main/menu.ts` (Help menu item, action id `check-for-updates`), `src/renderer/src/state/actions.ts`'s `handleMenuAction` and `checkForUpdates` (toasts for up-to-date/error/disabled). Verified by `npm run typecheck` and the existing `menu.action` event plumbing (same mechanism as every other Help item); not covered by a dedicated smoke step since none of the existing Help-menu items are either.

## 5. Verification

- [ ] 5.1 Build `0.1.1` and `0.1.2` to a test release repository and run `0.1.1` with `dev-app-update.yml`; verify detection, download, banner, install and reopen on the same repository on Windows and Linux runners
  - Not applicable to the fallback (no `electron-updater`, no `dev-app-update.yml`) and requires a real release repository, a real GitHub account and Windows/Linux runners; cannot be done here. Awaits the dependency review (1.1/1.2) and a real downloader-backed provider.
- [ ] 5.2 Verify *Later* hides the banner until relaunch and that installation is blocked during a rebase
  - *Later* hides the banner: verified in the smoke scenario (`dismissed.json`: `bannerGone: true`) and unit-tested (`reduceUpdateState`'s `dismiss` case in `test/update-core.test.ts`); "does not return until the app is launched again" is by design (`Updater` never reads `dismissedUpdateVersion` back from disk on startup — see the comment on `Store.AppStateFile.dismissedUpdateVersion`).
  - Left unchecked: "installation is blocked during a rebase" is verified only at the pure-gate level (`canInstall({ operationKind: 'rebase', ... })` in `test/update-core.test.ts`, which is the exact logic `app.update.install` calls). There is no end-to-end UI path to exercise this with a real rebase in progress, because the fallback never reaches the `ready`/"Restart to update" state that would let a user trigger an install in the first place — install is only reachable by calling the IPC method directly, which this pass did not add a dedicated fixture/smoke test for.
- [x] 5.3 Run `npm run typecheck` and `npm test`; verify both pass
  - `npm run typecheck`: 0 errors. `npm test`: 43 files, 472 passed, 2 skipped (0 failed) — includes 52 new tests across `test/update-core.test.ts`, `test/update-provider.test.ts`, `test/fixture/updater.test.ts`, `test/fixture/update-provider-gh.test.ts`.
- [x] 5.4 Smoke screenshot of the banner and About dialog with an injected state; update README; verify
  - `test/smoke/scenarios/20-update-banner.json`: real About-dialog "Updates unavailable" state, an injected available-update banner (Download/Release notes/Later), the release-notes dialog, and Later hiding the banner — all with real screenshots (`test/smoke/out/update-banner/*.png`). `README.md`'s Features section updated. Full smoke suite (20/20) still passes.
