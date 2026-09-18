# Releasing

## Building packages locally

```bash
npm run dist:win   # produces release/<version>/GitGood-Setup-<version>.exe (NSIS installer)
```

`npm run dist:linux` builds an AppImage and `npm run dist:mac` a dmg/zip. Builds are unsigned; add your certificate configuration to `electron-builder.yml` for signed releases.

Packaging notes:

- Build the Windows installer on Windows (`npm run dist:win`). Cross-building it from Linux/macOS also works but needs `wine` installed for electron-builder's NSIS step; without it you still get `release/<version>/win-unpacked/` (a runnable portable folder) but no `Setup.exe`.
- A `.deb` target can be added back to `linux.target` in `electron-builder.yml`, but electron-builder's `fpm` needs `libcrypt.so.1` (`libxcrypt-compat` on Arch-based systems) on the build machine.
- The installer registers the `gitgood://` and `x-github-client://` URL schemes, so GitHub's "Open with GitHub Desktop" buttons open the repository in GitGood (or offer to clone it).

## Cutting a release

Bump `version` in `package.json`, merge to `main`, then push a tag matching it:

```bash
git tag v0.2.0 && git push origin v0.2.0
```

`.github/workflows/release.yml` builds Windows/macOS/Linux in parallel and publishes the artifacts to a **draft** GitHub Release (`electron-builder.yml`'s `publish` block, `releaseType: draft`) — review the draft, add notes, and publish it manually from the Releases page.

The tag is what starts a release, so two things have to hold or the assets never arrive:

- **Bump `package.json` before tagging.** electron-builder names artifacts and picks the release from `version`, not from the tag, so a `v0.2.0` tag on a `0.1.9` `package.json` uploads `0.1.9` files to the `v0.1.9` release. The workflow's "Check the tag matches package.json" step fails the run instead.
- **Don't create the release from GitHub's Releases page.** Publishing a drafted release there creates the tag, so by the time the build finishes the release already exists as a published one; `releaseType: draft` then refuses it (`existing type not compatible with publishing type ... existingType=release publishingType=draft`) and skips every upload — while the workflow still reports success. Push the tag first and let the workflow create the draft.

## Auto-update

Installed copies check the GitHub releases feed (via `electron-updater`) on launch and every 6 hours, download a newer eligible release in the background, and offer **Restart to update**. See `openspec/changes/add-auto-update` for the full design (channels, install gating, per-machine Windows installs, and what's still unverified end-to-end).

## Signing

Releases are currently unsigned:

- **Windows** triggers a SmartScreen "unknown publisher" prompt on first run of a new version.
- **macOS** Gatekeeper may refuse to open the `.dmg` outright without notarization.

Setting up real signing needs accounts/credentials this repo's automation doesn't manage (an Apple Developer Program membership + Developer ID certificate for macOS notarization, and a CI-compatible signing service — e.g. SignPath's free OSS tier, or Azure Trusted Signing — for Windows, since CA/Browser Forum rules require OV/EV code-signing keys to live on a hardware token or HSM). Once you've created the certificates/accounts and added the resulting secrets to the repo's GitHub Actions secrets, `electron-builder.yml` and `.github/workflows/release.yml` can be wired to consume them (notarize block, `azureSignOptions`, or a SignPath step) — that wiring isn't done yet.
