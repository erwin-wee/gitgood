# Design

## Context

See proposal.md. `Store` in `src/main/store.ts` holds settings and the app state file and keeps the API key in a separate encrypted store. `app.chooseFile` exists; no save dialog method does. `GhClient.run` supports stdin. Repositories with missing paths are already supported by the repository list.

## Goals / Non-Goals

**Goals:**
- A schema-versioned, human-readable export that excludes anything sensitive by construction.
- Sync that never merges silently.

**Non-Goals:**
- Automatic background sync or conflict merging; syncing the API key through any store; team presets.

## Decisions

- **Exclusion by allowlist.** The export builder copies only known fields (`Omit<AppSettings, 'ai' | 'gitPath' | 'ghPath'>`, `ai` without `hasApiKey`/`claudeCliPath`), so new sensitive fields are not exported by accident. Alternative (denylist) rejected as unsafe when settings grow.
- **Gist discovery by description** via `gh api gists --paginate`, because `gh gist list` output is not JSON in all versions.
- **Content via stdin** for create and edit to avoid command-line length limits on Windows.
- **Newer-side detection** compares `updated_at` from `gh api gists/<id>` with the local export hash and last sync time; the UI always presents the choice.
- **Paths**: normalise `\` to `/` on export; on import keep as-is and mark missing when `app.pathExists` fails; no drive-letter translation.
- **Backups** at `userData/settings.backup-<timestamp>.json`, retain 5.

Commands:

| Purpose | Command |
| --- | --- |
| Find gist | `gh api gists --paginate` filtered by `description == "GitGood settings"` |
| Create | `gh gist create --desc "GitGood settings" --filename gitgood-settings.json -` (stdin, secret) |
| Read | `gh gist view <id> --filename gitgood-settings.json --raw` |
| Update | `gh gist edit <id> --filename gitgood-settings.json -` (stdin) |
| Metadata | `gh api gists/<id>` → `updated_at` |

Types and IPC:

```ts
interface SettingsExport { schema: 1; app: 'gitgood'; version; exportedAt; machine; platform; preferences?; repositories?: { path; alias; github: GitHubRepoRef | null }[]; integrations?: { externalEditor; customEditorPath; shell; customShellPath } }
interface ImportPreview { sections: { name; adds; changes; skipped }[]; missingRepositories: string[]; warnings: string[] }

'app.chooseSavePath': (opts) => Promise<string | null>
'settings.export': (sections) => Promise<SettingsExport>
'settings.exportToFile': (path, sections) => Promise<void>
'settings.previewImport': (path) => Promise<ImportPreview>
'settings.import': (path, mode: 'merge' | 'replace', sections) => Promise<AppSettings>
'settings.sync.status': () => Promise<{ enabled; gistId; lastSyncedAt; remoteUpdatedAt; localHash; remoteHash }>
'settings.sync.enable': () => Promise<{ gistId }>
'settings.sync.disable': (deleteGist: boolean) => Promise<void>
'settings.sync.upload': () => Promise<void>
'settings.sync.download': (mode) => Promise<AppSettings>
```

App state: `settingsSync: { gistId; lastSyncedAt; lastHash }`.

UI: Options → Advanced *Portable settings* section (Export…, Import…, sync card with status, Sync now, Upload, Download, Disconnect with optional delete); File menu *Export settings…* / *Import settings…*; export dialog with checklist and exclusion note; import dialog with preview table and Merge/Replace radio.

## Risks / Trade-offs

- [Secret gists are readable with the link] → enable dialog states it; nothing sensitive is exported; repository list only when selected.
- [Replace overwrites settings] → confirmation and backups.
- [Two machines edit concurrently] → never merge silently; show which side is newer.
- [Schema evolution] → version field; newer schema refused with an update prompt; unknown keys warned and ignored.
