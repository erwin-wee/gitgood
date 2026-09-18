# Design

## Context

See proposal.md. `electron-builder.yml` currently has `publish: null`; builds are unsigned. `Banners.tsx` has a priority slot; `AppStateFile` already stores `currentRepositoryId`; `logger.ts` exists; the `progress` event supports a generic kind. `RepositoryStatus.operation.kind` tells whether a git operation is in progress and `ai.cancel` covers AI tasks.

## Goals / Non-Goals

**Goals:**
- Updates that never interrupt work and never install anything the feed did not checksum.
- Clear behaviour for builds where updating cannot work.

**Non-Goals:**
- Code signing and notarisation setup (separate prerequisite for macOS); staged rollouts (`stagingPercentage`, later); in-app changelog history.

## Decisions

- **`electron-updater` over Electron's built-in `autoUpdater`.** The built-in one needs a Squirrel feed on Windows and a signed macOS app; `electron-updater` works with NSIS differential updates and GitHub Releases directly. This is contingent on the dependency review; if rejected, fall back to a minimal checker that compares `gh api repos/{o}/{r}/releases/latest` (or a plain fetch) and opens the release page.
- **Feed fixed in build config**, not settings, to prevent feed hijacking.
- **Download progress** forwarded on the existing `progress` event (`kind: 'generic'`, id `update`).
- **Install gate** in the main process: refuse when the current repository's operation kind is not `none` or an AI task is active; persist `currentRepositoryId` before `quitAndInstall(isSilent=true, forceRunAfter=true)`.
- **Per-machine Windows installs** detected by the executable path being under `ProgramFiles`; use a non-silent install there.
- **Release notes** from update info rendered as plain text with links.
- **2026-09-17: fallback shipped first, pending the dependency review.** Tasks 1.1/1.2 (the `electron-updater` new-dependency review and its `package.json`/`electron-builder.yml` `publish` block) have not been run, so no new runtime dependency was added. Everything else in this change is implemented against the documented fallback instead: `src/main/update/provider.ts` defines the `UpdateProvider` seam, `src/main/update/github-provider.ts` checks `gh api repos/erwin-wee/gitgood/releases/latest` when signed in (falling back to a plain authenticated-`User-Agent` `fetch` to the same endpoint otherwise), `src/main/update/update-core.ts` holds the pure semver/channel/reducer/gate logic, and `src/main/update/updater.ts` orchestrates launch + 6-hour checks. The fallback only ever reaches `idle → checking → available | up-to-date | error | disabled`; `downloading`/`ready` stay in `UpdateState` for when a downloader-backed provider lands, and "available" always offers **Download** (opens the release page) rather than a silent install, since there is nothing to install without a real downloader. One consequence of using only the "latest release" endpoint (never the full releases list): GitHub defines "latest" as never a prerelease or draft, so the beta channel can currently surface a newer *stable* release but cannot detect a beta-only prerelease — documented in github-provider.ts. Tasks 1.1, 1.2 and 5.1 remain unchecked pending the review and a real release pair to test against.

Types and IPC:

```ts
type UpdateState =
  | { status: 'idle' | 'checking' | 'up-to-date' | 'disabled' }
  | { status: 'available'; version; releaseDate; notes: string | null }
  | { status: 'downloading'; version; percent; bytesPerSecond }
  | { status: 'ready'; version; notes: string | null }
  | { status: 'error'; message; manualUrl }

'app.update.state': () => Promise<UpdateState>
'app.update.check': () => Promise<UpdateState>
'app.update.download': () => Promise<void>
'app.update.install': () => Promise<void>
'app.update.dismiss': (version: string) => Promise<void>
event 'app.update.changed': UpdateState
```

Settings: `checkForUpdatesAutomatically` (true), `autoDownloadUpdates` (true), `updateChannel: 'stable' | 'beta'` (stable). App state: `dismissedUpdateVersion`.

UI: banner in `Banners.tsx` at lowest priority; Help menu item; About dialog section with Check now; Options → Advanced toggles; downloading percent in the toolbar status area.

## Risks / Trade-offs

- [New runtime dependency and its transitive tree] → dependency review first; fallback design documented.
- [Unsigned Windows builds trigger SmartScreen once per version] → document; signing is a follow-up.
- [Silent install cannot elevate for per-machine installs] → detect and fall back to a visible installer.
- [Install during an operation corrupts state] → main-process gate on operation kind and AI activity.
- [Corporate proxies] → Electron `net` honours system proxy; no custom handling.

## Migration Plan

1. Land the dependency review and, on approval, add `electron-updater` and the `publish` block.
2. Publish a test release pair (`0.1.1`, `0.1.2`) to a test repository and verify the path with `dev-app-update.yml`.
3. Ship in the next release; rollback is to publish a release without `latest.yml` changes and disable checks via settings default if needed.
