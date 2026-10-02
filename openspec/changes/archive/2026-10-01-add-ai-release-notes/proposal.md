# Proposal

## Why

Writing release notes from `git log` is tedious and often skipped. GitGood already lists tags, history and pull requests; the model can turn commit subjects into grouped, user-facing prose while the app keeps every entry tied to a real commit or PR so nothing is invented.

## What Changes

- Add a **Release notes** dialog: pick a range (default latest reachable tag to HEAD), version name and audience; preview the commits and merged PRs in range.
- Generate a categorized changelog (Breaking changes, Features, Fixes, Performance, Docs, Internal) where every bullet cites a PR number or commit in the range; uncited commits are listed for review.
- Edit the Markdown, copy it, insert it at the top of `CHANGELOG.md`, or create a GitHub release (draft by default) with `gh release create`. Writing the changelog, creating tags or releases and publishing are user-confirmed actions.
- Without AI the dialog still exports a plain commit list.

## Capabilities

### New Capabilities

- `ai-release-notes`: range selection, commit and PR gathering, AI changelog generation with reference validation, changelog insertion and GitHub release creation.

### Modified Capabilities

_None._

## Impact

- Main process: helpers in `src/main/git/operations.ts` and `src/main/git/log.ts` (`git describe --tags --abbrev=0 HEAD`, `git log --no-merges --format=… <from>..<to>` capped at 500, `git log --merges --format=%s <from>..<to>` for PR numbers, `git diff --stat=120 <from>..<to>`), `GhClient.prView` for PR titles (cap 100, concurrency 4), new `GhClient.releaseCreate` (`gh release create <tag> --title <t> --notes-file - [--draft] [--prerelease] [--target <sha>]`) and `GhClient.releaseView` (`gh release view <tag> --json url`); release-notes service and prompt/schema in `src/main/ai/`; `src/main/ipc.ts` methods `repo.release.range`, `ai.releaseNotes`, `repo.changelog.insert`, `gh.release.create`, `gh.release.view`.
- Renderer: new `ReleaseNotesDialog.tsx`, Repository menu item and History tag context item, setting `AiSettings.releaseNotesAudience`.
- Files: reads and writes `CHANGELOG.md` at the repository root preserving line endings.
- No new runtime dependencies.
