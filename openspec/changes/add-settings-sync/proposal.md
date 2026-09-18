# Proposal

## Why

Users who run GitGood on two machines configure theme, editor, confirmations and the repository list twice. A file export covers most needs, and a secret gist through the already signed-in GitHub CLI gives sync without a new service or account.

## What Changes

- Add **Export…** and **Import…** of settings, repository list (paths and aliases), and integration choices as one JSON file, with a section checklist and a preview before import (merge or replace).
- Add optional **Sync with GitHub gist**: create or reuse a secret gist, upload, download, compare which side is newer, disconnect. No background sync.
- Never export or sync secrets: the API key, gist ID, tool paths from other platforms and window state are excluded.
- Keep timestamped backups before a replace import.

## Capabilities

### New Capabilities
- `settings-sync`: exporting, importing and gist-syncing portable app settings with explicit exclusion of secrets.

### Modified Capabilities
- (none; existing settings keep their meaning. Repositories imported with missing paths use the existing missing-repository handling.)

## Impact

- `gh` commands: `gh api gists --paginate` (find by description), `gh gist create --desc "GitGood settings" --filename gitgood-settings.json -` (stdin, secret), `gh gist view <id> --filename … --raw`, `gh gist edit <id> --filename … -` (stdin), `gh api gists/<id>` (updated_at).
- Code: `src/main/store.ts` (export/import/merge/replace, backups, sync state), `src/main/gh/gh.ts` (gist wrappers), new save-path dialog method, `src/shared/types.ts` / `src/shared/ipc.ts`, Options → Advanced UI, File menu items in `src/main/menu.ts`.
- Replace import overwrites settings and is confirmed; a backup is written first. Gists are secret but readable by anyone with the URL, which the enable dialog states.
