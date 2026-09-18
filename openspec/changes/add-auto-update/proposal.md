# Proposal

## Why

GitGood ships as an installer with no update channel, so bug fixes and AI prompt improvements never reach installed copies. GitHub Releases is already the distribution point and needs no new service.

## What Changes

- Check GitHub Releases for a newer version on launch and periodically, download it in the background, and offer **Restart to update** from a banner, the Help menu and the About dialog.
- Settings for automatic checks, automatic download and release channel (stable or beta).
- Block installation while a git operation or AI task is in progress; reopen on the same repository after updating.
- Disable the updater in development and portable builds and on unsigned macOS builds, offering a download link instead.
- **Dependency**: adds `electron-updater` as a new runtime dependency. This is gated on a new-dependency review (maintainer, downloads, licence, transitive dependencies, supply-chain posture) with explicit approval before any `package.json` change. Alternatives to weigh: Electron's built-in `autoUpdater` (Squirrel feed, signed macOS required) and a minimal in-house checker that only opens the release page.

## Capabilities

### New Capabilities
- `auto-update`: detecting, downloading and installing new app versions from GitHub Releases with user control and safety gates.

### Modified Capabilities
- (none.)

## Impact

- Build: `electron-builder.yml` gains `publish: { provider: github, owner: erwin-wee, repo: gitgood }` so builds emit `latest.yml`, `latest-mac.yml`, `latest-linux.yml` and blockmaps.
- Dependencies: `electron-updater` (pending review). No `git`/`gh` commands are involved.
- Code: a new updater module in the main process, `src/main/menu.ts` (Help → Check for updates…), `src/shared/types.ts` / `src/shared/ipc.ts` (update state, methods, event), `src/main/store.ts` (settings, dismissed version), renderer banner in the Banners slot, About dialog and Options → Advanced toggles, `src/main/logger.ts` for updater events.
- Installing restarts the app; it is gated on no in-progress git operation and no running AI task, and persists the current repository first.
