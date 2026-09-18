# Design

## Context

See proposal.md — Why. The relevant current state:

- `RepositoryManager` (`src/main/repo/manager.ts`) owns the list. `add(path)` resolves the top level with `git rev-parse --show-toplevel`, resolves `worktreeOf`, reads the GitHub remote (`git remote -v`), persists through `Store.saveRepositories`, and then sends `repos.changed` with the freshly derived list — one git-process burst and one full-list broadcast per repository.
- `Store` (`src/main/store.ts`) persists `settings.json` (`AppSettings`), `repositories.json` and `state.json` (machine-local state: window, recents, trust, issue filters). Settings changes broadcast to listeners.
- `RepositoryWatcher` (`src/main/repo/watcher.ts`) watches only the *active* repository; it is not a folder-discovery mechanism and is untouched by this change.
- Settings export (`src/main/settings/sync-core.ts`) is an allowlist: only fields named in `PortablePreferences` / `PortableIntegrations` / `PortableRepository` ever leave the machine.
- The renderer talks to main over the single typed contract in `src/shared/ipc.ts`; long operations use the existing progress/toast plumbing.

Constraints: no new runtime dependencies (so no `fast-glob`/`chokidar`); `node:fs` only; must behave on Windows paths; the walk must not turn a large home directory into a hang.

## Goals / Non-Goals

**Goals:**

- A discovery walk that is pure and unit-testable against a temp-directory fixture, with no Electron or git dependency.
- Bulk registration that costs one `repos.changed` broadcast and a bounded number of git processes, not one of each per repository found.
- An origin field on repositories that survives the existing `repositories.json` files without a migration step.

**Non-Goals:**

- Background filesystem watching of watched folders (decided against: one more recursive watcher per folder, and inotify limits on Linux; "Rescan now" plus the launch scan covers the case). Revisitable later without changing this spec's requirements.
- Discovering bare repositories, submodules, or repositories behind symlinks.
- Any change to how the *active* repository is watched.

## Decisions

### Discovery lives in a pure walker, orchestration next to it

`src/main/repo/scan.ts` exports `scanFolder(root, { depth, skipNames, signal, onFound })` returning `{ repositories, unreadable, cancelled }`. It uses `readdir(dir, { withFileTypes: true })` and treats a directory as a repository when it directly contains a `.git` entry — checked from the parent's dirent list, so it costs no extra syscall per candidate. Level accounting: the root is level 0 and is always examined; children are examined while `level < depth`.

`src/main/repo/watched-folders.ts` holds the orchestration: iterate the configured folders, feed found paths to the manager, track the single in-flight scan, own the `AbortController`, and compute the drop set. Keeping the two apart is what makes the walk testable without a `Store`, a `GitClient` or an Electron `app`.

Alternative considered: a `git`-based probe (`git rev-parse --show-toplevel` on every candidate directory). Rejected — it is a process per directory, orders of magnitude slower, and the manager runs that check anyway on the paths that survive.

*Symlinks*: `withFileTypes` dirents report `isSymbolicLink()` without following, so skipping them needs no `lstat` — that also closes the loop risk for free (`~/Projects/self -> ~/Projects`).

*Bare repositories*: excluded by construction, since the test is a `.git` entry in the directory, which a bare repository does not have.

### Bulk add on the manager, one broadcast

Add `RepositoryManager.addMany(paths, { concurrency: 3 })`: it filters out ids already present and excluded paths, runs `getTopLevel` + `resolveWorktreeOf` + `detectGitHub` with the same bounded concurrency used by `work()` (3), writes once through `saveRepositories`, and sends `repos.changed` once per batch. The scan feeds it in batches (say 10 found paths, or on folder completion) so the list fills in progressively without one broadcast per repository.

Alternative considered: looping the existing `add()`. Rejected — N full list derivations, N broadcasts, and unbounded git fan-out, which is the exact failure mode already noted in this repo's review lessons.

### Sameness is the realpath of the working tree, not the stored path

`repositoryId()` stays exactly as it is — a sha1 of the normalized path — because it is the stable key used by `state.json` (issue filters, trust) and by the renderer. It is not, however, a good test of *sameness*: a repository added through a symlink (`~/code/gitgood` → `~/Projects/erwin-wee/gitgood`) is stored under the link path, and a scan reaches it by its real path, so the ids differ and the list would grow a second entry for one repository.

`addMany` therefore dedupes on `realpath(top-level)`: one `fs.realpath` per existing entry and per found path, no git process. Entries whose realpath fails (missing folder, dead link) fall back to their normalized path, so a missing repository never blocks an add.

Deliberately *not* the `.git` common dir, which is the obvious-looking key and the wrong one: a linked worktree shares its main repository's common dir, so keying on it would merge a worktree into its main entry and undo the nesting the spec requires. Working-tree roots differ between a worktree and its main repository, which is precisely the distinction wanted.

### `origin` on `RepositoryInfo`, defaulted at read time

`RepositoryInfo.origin?: 'manual' | 'watched'`. Existing `repositories.json` entries have no field; `undefined` is read as `'manual'`, so no migration runs and a downgrade to an older build still parses the file. Only `addMany` from a scan writes `'watched'`; if a scan finds a repository the user had already added by hand, the existing entry keeps `'manual'` (and its alias and `lastOpened`) — a repository the user chose deliberately should not start being managed by the scanner behind their back.

### Settings vs. state split

`AppSettings.watchedFolders: WatchedFolder[]` (`{ path: string; depth: number }`) lives in `settings.json` with the rest of the preferences, because it is a user preference edited in Options. It is deliberately **not** added to `PortablePreferences`, so the existing export allowlist keeps it off exports and gist sync without any new code — `defaultCloneDirectory` is portable, but a single default path that the import preview can flag is a different thing from a list of paths whose whole meaning is this machine's disk layout.

`excludedRepositoryPaths: string[]` goes in `state.json` alongside `trustedRepoConfigs`, which is the existing home for per-path machine-local decisions, and is likewise outside the export.

An exclusion is written on removal when the repository's path is **inside a watched folder**, whatever its `origin`. Keying it on origin instead was the first cut and is wrong: a repository the user had added by hand that happens to sit under a watched folder would record no exclusion, and the next scan would add it straight back as `'watched'` — removal that visibly does not stick. Location is the property that actually decides whether a scan can resurrect the entry, so location is the key. Removals outside every watched folder are untouched and record nothing.

Note the deliberate asymmetry with the drop pass below, which stays keyed on `origin`. They answer different questions: an exclusion honours an explicit removal, so it follows what the scanner is able to re-add; dropping is the scanner tidying up entries it owns, so it never touches an entry the user created. A hand-added repository inside a watched folder whose folder is deleted therefore still shows as missing rather than vanishing.

Both are compared with the normalization `repositoryId()` already uses: `normalize()`, plus `toLowerCase()` on Windows. The nesting check for "already covered by a watched folder" uses the same normalized form with a trailing separator, which is what makes `C:\Users\me\Projects\` and `C:\Users\me\Projects` the same folder.

### Dropping vanished repositories is scan-scoped and conservative

Only repositories with `origin === 'watched'` are candidates, and only those whose path is under a watched folder whose scan reported `cancelled: false` and recorded no unreadable ancestor on their path. Everything else is left alone. This is what keeps an unmounted network drive or a permissions change from quietly emptying the list; the cost is that a repository deleted from an unreadable subtree lingers until a clean scan, which is the right way round.

### Launch timing

The launch scan is kicked off from `src/main/index.ts` after the window's `ready-to-show`, not during `load()`. The scan is async and the renderer receives repositories through the existing `repos.changed` event, so nothing about startup is serialized behind it. Under `GITGOOD_SMOKE_SCRIPT` the launch scan still runs — the smoke tests set `GITGOOD_USER_DATA` to an empty profile, so there are no watched folders and it is a no-op.

### IPC surface

- `repos.scanWatchedFolders(): Promise<RepositoryScanResult>` — starts a scan, resolves with the summary; resolves immediately with `{ alreadyRunning: true }` if one is in flight.
- `repos.cancelScan(): Promise<void>`
- `repos.exclusions.list() / remove(path) / clear()`
- Event `repos.scanProgress` → `{ folder: string; scanned: number; found: number }` for the Options row and the progress surface.

Settings changes already broadcast; `watched-folders.ts` subscribes via `Store.onSettingsChanged` and starts a scan when the watched-folder list or a depth actually differs (deep-compared, so unrelated settings edits do not trigger scans).

## Risks / Trade-offs

- **A watched folder like `~` or `/` makes the walk enormous** → depth is capped at 10, the skip list covers the usual offenders, dot-directories are skipped, and the scan is cancellable with visible progress. The walk never follows symlinks, so it terminates.
- **Discovery could add dozens of repositories at once and flood the UI** → one broadcast per batch, bounded git concurrency of 3, and a single summary at the end rather than a toast per repository.
- **Removing a repository inside a watched folder now always excludes it**, including one the user added by hand → this is the point of the location key, but it does mean a removal carries a side effect the user did not have before. Mitigated by saying so in the confirmation for exactly those repositories, and by the exclusion list in Options being visible and clearable.
- **An exclusion outlives the watched folder that motivated it** → harmless, since exclusions are only consulted while scanning, but they stay listed in Options so a stale one can be cleared.
- **Exclusions accumulate invisibly** → they are listed in Options with per-path removal and "Clear all", and are never written by anything except an explicit removal.
- **`readdir` on a huge tree still blocks the main process's event loop in bursts** → the walk is `await`-ed per directory (never `readdirSync`), so it yields between directories; a worker thread would be the escape hatch if this ever shows up, and nothing in the design prevents moving `scan.ts` behind one later.

## Migration Plan

No data migration. `origin` and `excludedRepositoryPaths` are additive and read with defaults; `watchedFolders` defaults to `[]`, which means the feature is inert until the user registers a folder. Rolling back to a build without this change leaves the extra keys in `settings.json`/`state.json` unread and harmless.
