# Spec Delta

## Purpose

Lets a user point GitGood at the folders where they keep their clones, so every Git repository underneath is discovered and kept in the repository list without being added one at a time.

## ADDED Requirements

### Requirement: Registering watched folders

The application SHALL let the user register any number of watched folders, each an absolute path to a directory with its own scan depth. Depth SHALL default to 3 and be constrained to 1–10. The same folder SHALL NOT be registered twice; path comparison SHALL be case-insensitive on Windows and case-sensitive elsewhere. A folder that is a subdirectory of an already-watched folder SHALL be rejected with an explanation naming the folder that already covers it. Registering, editing the depth of, or removing a watched folder SHALL be reversible by the user at any time, and removing a watched folder SHALL leave the repositories it discovered in the list.

#### Scenario: Add a folder

- **WHEN** the user chooses a directory in Options and confirms
- **THEN** it is added to the watched-folder list with depth 3 and a scan of that folder starts

#### Scenario: Duplicate folder

- **WHEN** the user adds a folder that is already watched, differing only in letter case on Windows
- **THEN** it is not added a second time and the existing entry is highlighted

#### Scenario: Nested inside an existing watched folder

- **WHEN** the user adds `C:\Users\me\Projects\work` while `C:\Users\me\Projects` is watched at depth 3
- **THEN** the addition is rejected with a message naming `C:\Users\me\Projects`

#### Scenario: Depth out of range

- **WHEN** the user sets a depth below 1 or above 10
- **THEN** the value is rejected and the previous depth is kept

#### Scenario: Folder missing or not a directory

- **WHEN** a watched folder does not exist, is a file, or cannot be read
- **THEN** the entry is kept and shown with a warning explaining which of the three it is, and the rest of the scan continues

#### Scenario: Removing a watched folder

- **WHEN** the user removes a watched folder
- **THEN** it is no longer scanned and the repositories discovered from it stay in the repository list

#### Scenario: Folder reached through a symbolic link

- **WHEN** the user registers `~/Projects`, which is a symbolic link (or a Windows junction) to `/mnt/data/Projects`, and a repository exists at `/mnt/data/Projects/a`
- **THEN** that repository is discovered, and is treated as being inside the watched folder — so removing it records an exclusion and a vanished copy of it is dropped

### Requirement: Bounded discovery of repositories

A scan of a watched folder SHALL walk its directory tree and report every Git repository found, bounded as follows. The watched folder itself is level 0 and is always examined; a folder's configured depth is the deepest level below it that may be examined. A directory SHALL be treated as a repository when it directly contains a `.git` directory or a `.git` file, and its contents SHALL NOT be walked any further, so nested submodules and in-tree worktrees are not reported separately. Directories named `node_modules`, `vendor`, `target`, `dist`, `build`, `out`, `.cache`, and any directory whose name begins with `.`, SHALL be skipped. Symbolic links to directories SHALL NOT be followed. Bare repositories (no working tree) SHALL NOT be reported. Discovery SHALL read the filesystem only and SHALL NOT modify anything on disk.

#### Scenario: Repository one level down

- **WHEN** `~/Projects` is watched at depth 3 and `~/Projects/erwin-wee/gitgood/.git` exists
- **THEN** `~/Projects/erwin-wee/gitgood` is reported

#### Scenario: Depth limit

- **WHEN** `~/Projects` is watched at depth 1 and the only repository is `~/Projects/erwin-wee/gitgood`
- **THEN** no repository is reported, because level 2 is beyond the configured depth

#### Scenario: No descent into a repository

- **WHEN** a reported repository contains a submodule checkout with its own `.git` file
- **THEN** the submodule is not reported as a separate repository

#### Scenario: Excluded directory names

- **WHEN** a repository exists under `node_modules` or under a dot-directory within the depth limit
- **THEN** it is not reported

#### Scenario: Symlinked directory

- **WHEN** a watched folder contains a symbolic link to a directory holding repositories
- **THEN** the link is not followed and nothing beneath it is reported

#### Scenario: Windows path with a trailing separator

- **WHEN** a watched folder is stored as `C:\Users\me\Projects\`
- **THEN** discovery treats it the same as `C:\Users\me\Projects` and reports repositories under it once

#### Scenario: Unreadable subdirectory

- **WHEN** a subdirectory cannot be read because of filesystem permissions
- **THEN** that subdirectory is skipped, counted as unreadable, and the scan continues through the rest of the tree

### Requirement: When scans run

A scan of every watched folder SHALL run when the application starts, after the main window has rendered, and whenever the watched-folder list or any folder's depth changes. The user SHALL also be able to start a scan on demand with a "Rescan now" action. The application SHALL NOT watch the folders for filesystem events between scans, so a repository created outside GitGood appears after the next scan. A scan SHALL report progress while it runs, SHALL be cancellable by the user, and SHALL never block interaction with the window. Only one scan SHALL run at a time; requesting another while one is running SHALL be ignored with the running scan left alone. Registering no watched folders SHALL mean no scanning happens at all.

#### Scenario: Launch scan

- **WHEN** the application starts with at least one watched folder registered
- **THEN** a scan starts once the window has rendered and the repository list updates as repositories are added

#### Scenario: Rescan after cloning outside GitGood

- **WHEN** the user clones a repository into a watched folder from a terminal and then chooses "Rescan now"
- **THEN** the new repository is added to the repository list

#### Scenario: Depth change rescans

- **WHEN** the user changes a watched folder's depth from 1 to 3
- **THEN** a scan of that folder starts using the new depth

#### Scenario: Cancelling

- **WHEN** the user cancels a running scan
- **THEN** the scan stops, repositories already added stay in the list, and the summary reports the scan as cancelled

#### Scenario: Scan already running

- **WHEN** a scan is requested while one is running
- **THEN** the request is ignored and the running scan continues

### Requirement: Discovered repositories in the repository list

Every repository reported by a scan and not excluded SHALL be added to the repository list, recorded as discovered from a watched folder rather than added by hand. A repository already in the list SHALL NOT be duplicated and SHALL keep its existing alias, origin and last-opened time. Two paths SHALL be treated as the same repository when their working-tree roots resolve to the same location once symbolic links are resolved, so a repository already listed under a symlinked path is recognised when a scan reaches it by its real path. A linked worktree SHALL remain a separate entry from its main repository, since their working-tree roots differ. Discovered repositories SHALL otherwise behave exactly like manually added ones — they can be opened, aliased, nested as worktrees of their main repository, and removed. The repository list SHALL show which entries came from a watched folder. Adding repositories SHALL be incremental, so the list fills in as the scan proceeds rather than only at the end.

#### Scenario: Repository added once

- **WHEN** a scan reports a repository that is already in the list because the user added it by hand
- **THEN** no second entry appears and the existing entry keeps its alias and manual origin

#### Scenario: Already listed under a symlinked path

- **WHEN** the list holds `~/code/gitgood`, which is a symbolic link to `~/Projects/erwin-wee/gitgood`, and a scan of `~/Projects` reaches the real path
- **THEN** no second entry appears and the existing entry is left as it is

#### Scenario: Worktree of a discovered repository

- **WHEN** a discovered repository is a linked worktree of another repository
- **THEN** it is nested under its main repository exactly as a manually added worktree would be

#### Scenario: Main repository outside every watched folder

- **WHEN** a scan finds a worktree whose main repository lies outside every watched folder, and registers that main so the worktree can be nested
- **THEN** the main is not marked as discovered from a watched folder, is not treated as recently opened, and stays subject to the rules for a repository the user added by hand

#### Scenario: Worktree reached before its main repository

- **WHEN** a scan reaches a linked worktree before the main repository it belongs to, and neither is in the list yet
- **THEN** both are added as discovered from the watched folder, both are counted in the summary, and neither is treated as recently opened

#### Scenario: Discovered entries are marked

- **WHEN** the repository list contains both manually added and discovered repositories
- **THEN** the discovered ones are visibly marked as coming from a watched folder

### Requirement: Excluding repositories

Removing a repository whose path lies within a registered watched folder SHALL record its path in a persisted exclusion list, and later scans SHALL NOT add it again. This SHALL hold however a scan would otherwise reach it, including when it is registered indirectly as the main repository of a worktree that was found. Exclusions SHALL be recorded and matched by physical path, so an entry held under a symbolic link is still recognised when a scan reaches its real path. This SHALL apply whatever the repository's origin: a repository the user added by hand that happens to sit inside a watched folder would otherwise be re-added by the very next scan, so its removal would not stick. Removing a repository that lies outside every watched folder SHALL NOT create an exclusion. The removal confirmation SHALL say that the repository will not be added back, and SHALL say it only for repositories that are within a watched folder. The exclusion list SHALL be visible in Options, with an action to un-exclude a single path and an action to clear the list; either SHALL make the affected paths eligible for the next scan again. Path comparison SHALL follow the same platform rules as watched folders.

#### Scenario: Removal excludes

- **WHEN** the user removes a discovered repository and confirms
- **THEN** it leaves the list, its path is recorded as excluded, and the next scan does not add it back

#### Scenario: Manually added repository inside a watched folder

- **WHEN** the user removes a repository they had added by hand that sits under a watched folder
- **THEN** its path is recorded as excluded and the next scan does not add it back

#### Scenario: Confirmation explains the exclusion

- **WHEN** the removal confirmation is shown for a repository within a watched folder
- **THEN** it states that the repository will not be added again by future scans

#### Scenario: Confirmation unchanged elsewhere

- **WHEN** the removal confirmation is shown for a repository outside every watched folder
- **THEN** it does not mention scans or exclusions

#### Scenario: Excluded repository found again through its worktree

- **WHEN** a scan finds a worktree whose main repository is excluded
- **THEN** the worktree is added, the excluded main repository is not, and the worktree is shown at the top level rather than nested under it

#### Scenario: Un-excluding

- **WHEN** the user removes a path from the exclusion list in Options and rescans
- **THEN** the repository is added to the list again

#### Scenario: Repository outside every watched folder

- **WHEN** the user removes a repository that lies outside every watched folder
- **THEN** no exclusion is recorded

### Requirement: Discovered repositories that disappear

When a scan completes without error over the watched folder that a discovered repository came from, and that repository's folder no longer exists or is no longer a Git repository, the repository SHALL be removed from the list without being excluded and without any confirmation. Dropping a main repository SHALL also drop its discovered worktrees that are likewise gone, but SHALL NOT remove a worktree entry the user added by hand or one that is still on disk; such an entry SHALL remain visible in the repository list rather than staying nested under a repository that is no longer there. This SHALL apply only to repositories discovered from a watched folder; a manually added repository whose folder is gone SHALL continue to be shown as missing. A repository SHALL NOT be dropped on the basis of a scan that was cancelled or that could not read the folder it lives under, so an unmounted drive or a denied directory does not silently empty the list.

#### Scenario: Folder deleted

- **WHEN** a discovered repository's folder is deleted and a scan of its watched folder completes
- **THEN** the repository is removed from the list and is not recorded as excluded

#### Scenario: Cancelled scan keeps entries

- **WHEN** a scan is cancelled before reaching a discovered repository's folder
- **THEN** that repository stays in the list

#### Scenario: Unreadable parent keeps entries

- **WHEN** the watched folder a discovered repository came from cannot be read during a scan
- **THEN** that repository stays in the list

#### Scenario: Worktree that outlives its main repository

- **WHEN** a discovered main repository's folder is deleted while a worktree of it that the user added by hand is still on disk
- **THEN** the main is dropped, the worktree entry stays in the list, and it is shown at the top level rather than nested under the repository that is gone

#### Scenario: Manually added repository stays

- **WHEN** a manually added repository's folder is deleted and a scan completes
- **THEN** it remains in the list, shown as missing

### Requirement: Scan results are reported

When a scan finishes, the application SHALL report how many repositories were added, how many reported repositories were skipped as already known or excluded, and how many directories could not be read. A repository that was found but could not be registered SHALL be reported separately from one that was skipped as already known, so the summary never claims a repository was already in the list when it was not. A scan that added nothing SHALL say so rather than appearing to have done nothing, whatever else it reports. Errors reading individual directories SHALL NOT abort the scan or be shown as failures of the whole scan.

#### Scenario: Summary after a scan

- **WHEN** a scan finishes having added 4 repositories and failed to read 2 directories
- **THEN** the summary states both counts

#### Scenario: Nothing new

- **WHEN** a scan finishes without adding any repository
- **THEN** the summary says no new repositories were found, even when it also reports repositories that were already known

#### Scenario: Found but not registrable

- **WHEN** a scan finds a directory that stops being a repository before it can be registered
- **THEN** it is counted as one that could not be added, not as one already known or excluded

### Requirement: Watched folders are machine-local

Watched folders and the exclusion list SHALL be treated as machine-local: they SHALL NOT be included in a settings export or in settings sync, since their paths only make sense on the machine that registered them.

#### Scenario: Export omits watched folders

- **WHEN** the user exports settings with the preferences section selected
- **THEN** the exported file contains neither the watched-folder list nor the exclusion list

#### Scenario: Import leaves them alone

- **WHEN** the user imports a settings file
- **THEN** the watched folders and exclusions already on this machine are unchanged
