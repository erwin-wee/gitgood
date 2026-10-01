# Releasing

## Building packages locally

```bash
npm run dist:win   # produces release/<version>/GitGood-Setup-<version>.exe (one NSIS installer for x64 + arm64)
```

`npm run dist:linux` builds an AppImage and a `.deb`, `npm run dist:mac` a universal (Intel + Apple silicon) dmg/zip. Local builds are unsigned unless the signing environment variables below are set.

Packaging notes:

- Build the Windows installer on Windows (`npm run dist:win`). Cross-building it from Linux/macOS also works but needs `wine` installed for electron-builder's NSIS step; without it you still get `release/<version>/win-unpacked/` (a runnable portable folder) but no `Setup.exe`.
- The `.deb` target uses electron-builder's `fpm`, which needs `libcrypt.so.1` (`libxcrypt-compat` on Arch-based systems) on the build machine.
- The macOS universal build merges x64 and arm64 apps and is meant to be built on macOS.
- Flathub and AUR packages are separate repositories (a Flathub manifest, a PKGBUILD); nothing here builds or publishes them.
- The installer registers the `gitgood://` and `x-github-client://` URL schemes, so GitHub's "Open with GitHub Desktop" buttons open the repository in GitGood (or offer to clone it).

## Cutting a release

`scripts/release.mjs` runs the sequence and enforces the checks below:

```bash
npm run release:prepare -- 0.2.0   # on main: bump package.json + lockfile on a
                                   # release/v0.2.0 branch, push it, open the PR
# review and merge that PR, then back on an up-to-date main:
npm run release:tag                # tag main at package.json's version and push
```

`prepare` refuses a version that does not move forward, a tag that already
exists, or a dirty or diverged `main`; `tag` additionally refuses to run while the
Test workflow on `main` is failing, unfinished or for a different commit than `HEAD`. If `gh` cannot answer, `tag` refuses too; `--skip-ci-check` skips the check entirely.
Both ask before doing anything; `--yes` answers for you.

By hand it is a bump of `version` in `package.json`, merged to `main`, then a
tag matching it:

```bash
git tag v0.2.0 && git push origin v0.2.0
```

`.github/workflows/release.yml` builds Windows/macOS/Linux in parallel with read-only permissions (`--publish never`) and uploads the installers, blockmaps and `latest*.yml` as workflow artifacts. A separate `publish` job, the only one with `contents: write`, then creates (or reuses) the **draft** GitHub Release for the tag and uploads them — review the draft, add notes, and publish it manually from the Releases page. It refuses to touch a release that is already published. Every action in the workflows is pinned to a commit SHA (Dependabot keeps them current); when bumping one by hand, look the SHA up with `gh api repos/<owner>/<repo>/git/ref/tags/<tag>` (dereference annotated tags) and keep the `# vX.Y.Z` comment.

The tag is what starts a release, so two things have to hold or the assets never arrive:

- **Bump `package.json` before tagging.** electron-builder names artifacts and picks the release from `version`, not from the tag, so a `v0.2.0` tag on a `0.1.9` `package.json` uploads `0.1.9` files to the `v0.1.9` release. The workflow's "Check the tag matches package.json" step fails the run instead.
- **Don't create the release from GitHub's Releases page.** Publishing a drafted release there creates the tag, so by the time the build finishes the release already exists as a published one; `releaseType: draft` then refuses it (`existing type not compatible with publishing type ... existingType=release publishingType=draft`) and skips every upload — while the workflow still reports success. Push the tag first and let the workflow create the draft.

## Auto-update

Installed copies check the GitHub releases feed (via `electron-updater`) on launch and every 6 hours, download a newer eligible release in the background, and offer **Restart to update**. `.deb` installs are excluded on purpose (electron-updater would `dpkg -i` the download as root): they show *Updates are unavailable for system-package (.deb) installs* and update from the Releases page or a package manager. See `openspec/changes/add-auto-update` for the full design (channels, install gating, per-machine Windows installs, and what's still unverified end-to-end).

## Signing

`release.yml` passes these repository secrets to the build step, and electron-builder signs and notarizes only when they are set; with none set the build is unsigned, exactly as before:

| Secret | Used for |
| --- | --- |
| `CSC_LINK` | Certificate (`.p12`/`.pfx`, base64 or URL) for macOS (Developer ID Application) and Windows signing |
| `CSC_KEY_PASSWORD` | Password of that certificate |
| `APPLE_ID` | Apple ID used for notarization |
| `APPLE_APP_SPECIFIC_PASSWORD` | App-specific password for that Apple ID |
| `APPLE_TEAM_ID` | Apple Developer team ID |

**Not done, needs you:** the certificates and accounts themselves — an Apple Developer Program membership with a Developer ID Application certificate, and a Windows code-signing certificate. `CSC_LINK` is one variable shared by both platforms, so a single secret cannot hold both a Mac and a Windows certificate; and OV/EV Windows keys must live on a hardware token/HSM under CA/Browser Forum rules, which a `.pfx` secret cannot satisfy — for those, use a signing service (SignPath's free OSS tier, Azure Trusted Signing) and extend the workflow (`azureSignOptions` or a SignPath step). Until signed builds are verified, the updater stays disabled on macOS (`detectDisabledReason` in `src/main/update/update-core.ts`), and Windows shows SmartScreen's "unknown publisher" prompt.
