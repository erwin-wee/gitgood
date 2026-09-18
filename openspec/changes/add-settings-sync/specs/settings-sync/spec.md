# Spec Delta

## Purpose

Lets users carry their GitGood preferences, repository list and integration choices between machines through a portable file or a secret GitHub gist, without ever moving secrets.

## ADDED Requirements

### Requirement: Export selected sections to a file
The system SHALL export settings to a single JSON file chosen through a save dialog, with a checklist selecting Preferences, Repository list (paths and aliases), and Integrations. The export MUST include a schema version, app version, platform and timestamp, and MUST NOT include the API key, gist identifier, window geometry, or any stored secret.

#### Scenario: Preferences only
- **WHEN** the user exports with only *Preferences* selected
- **THEN** the file contains the preferences section and metadata, and contains no repository paths, no integration paths and no key material

#### Scenario: Secrets never exported
- **WHEN** the user exports with every section selected
- **THEN** scanning the file's keys finds no API key, no key-present flag, no gist identifier and no window state

### Requirement: Import with preview, merge or replace
The system SHALL validate an import file, show a preview with per-section counts of additions, changes and skips plus warnings, and offer Merge (default) or Replace. Merge MUST leave settings not present in the file untouched. Replace MUST restore defaults for omitted keys, require confirmation and write a timestamped backup, keeping the five most recent backups.

#### Scenario: Merge
- **WHEN** the user imports a file containing only a theme change with Merge
- **THEN** the theme changes and every other setting keeps its current value

#### Scenario: Replace with backup
- **WHEN** the user chooses Replace and confirms
- **THEN** a backup of the current settings is written under the user-data directory before any change, omitted keys return to defaults, and no more than five backups remain

#### Scenario: Invalid file
- **WHEN** the file is not a GitGood export, has a newer schema version, or has fields of the wrong type
- **THEN** the import is refused and the error lists the failing fields, or asks the user to update the app for a newer schema

#### Scenario: Unknown keys
- **WHEN** the file contains keys the app does not know
- **THEN** they are ignored and listed as warnings in the preview

### Requirement: Imported repositories with missing paths
The system SHALL add imported repositories whose path does not exist on this machine as missing entries that the user can relocate, and MUST skip tool paths recorded for a different platform.

#### Scenario: Missing repository path
- **WHEN** an imported repository path does not exist locally
- **THEN** it appears in the repository list marked missing with a relocate action

#### Scenario: Other-platform tool path
- **WHEN** the export was made on Windows and contains a custom editor path, and the import runs on Linux
- **THEN** the editor path is skipped and reported in the preview warnings

### Requirement: Gist sync
The system SHALL let the user enable sync, which creates a secret gist (or reuses an existing one identified by its description), uploads the export and stores the gist identifier locally. Sync now MUST compare the remote update time with the local export and offer to upload or download without merging silently. Disconnect MUST remove the local reference and delete the gist only when the user asks. The enable dialog MUST state that secret gists are readable by anyone with the link.

#### Scenario: Enable creates one gist
- **WHEN** the user enables sync twice on two machines with the same account
- **THEN** exactly one gist with the settings description exists and both machines reference it

#### Scenario: Remote newer
- **WHEN** the user clicks *Sync now* and the gist was updated more recently than the local export
- **THEN** the card shows that the remote is newer and offers *Download* (merge or replace) without changing anything yet

#### Scenario: Disconnect keeping gist
- **WHEN** the user disconnects without choosing to delete the gist
- **THEN** the local gist reference is cleared and the gist remains on GitHub

### Requirement: Degraded states
The system SHALL offer file export and import when the GitHub CLI is unavailable or the user is signed out, and MUST show the sign-in card for sync in that case. When the referenced gist no longer exists, the system MUST offer to create a new one.

#### Scenario: Gist deleted remotely
- **WHEN** *Sync now* finds the stored gist missing
- **THEN** the card explains it and offers to create a new gist
