# Spec Delta

## Purpose

Keeps installed copies of GitGood current by detecting, downloading and installing new releases from GitHub with the user's consent and without interrupting in-progress work.

## ADDED Requirements

### Requirement: Automatic update checks
The system SHALL check the release feed on launch and every six hours while running when automatic checks are enabled, silently. Only releases newer than the running version MUST be offered, prereleases only on the beta channel, and downgrades never.

#### Scenario: Newer release available
- **WHEN** a newer stable release exists and automatic checks are on
- **THEN** the update is detected without any dialog and, when automatic download is on, downloading starts in the background

#### Scenario: Prerelease on stable channel
- **WHEN** only a prerelease newer than the running version exists and the channel is stable
- **THEN** no update is offered

#### Scenario: Automatic checks disabled
- **WHEN** the automatic-check setting is off
- **THEN** no check runs on launch or on the timer, and manual checks still work

### Requirement: Ready banner and install
The system SHALL show a non-blocking banner when an update has been downloaded, with Restart to update, Release notes and Later. Later MUST hide the banner for that version until the next launch. Restart to update MUST install quietly and reopen the app on the same repository.

#### Scenario: Restart to update
- **WHEN** the user clicks *Restart to update*
- **THEN** the app persists the current repository, quits, installs the update silently and reopens on the same repository

#### Scenario: Later
- **WHEN** the user clicks *Later*
- **THEN** the banner disappears and does not return for that version until the app is launched again

#### Scenario: Release notes
- **WHEN** the user clicks *Release notes*
- **THEN** the release body is shown as plain text with clickable links

### Requirement: Manual check and About dialog
The system SHALL provide Help → Check for updates… and an About section showing the current version and channel with a Check now action. A manual check MUST report up to date, show the ready banner, or show the error.

#### Scenario: Up to date
- **WHEN** the user runs a manual check and no newer release exists
- **THEN** a message states the app is up to date

#### Scenario: Network error on manual check
- **WHEN** the feed cannot be reached during a manual check
- **THEN** the error is shown with a link to download manually, while the same error during an automatic check is only logged

### Requirement: Installation safety gates
The system SHALL refuse to install while a merge, rebase, cherry-pick or revert is in progress in the current repository or while an AI task is running, explaining why, and MUST verify the download's checksum, discarding it with a warning when verification fails. The feed MUST be fixed to the configured GitHub owner and repository with no user-configurable feed URL.

#### Scenario: Operation in progress
- **WHEN** the user clicks *Restart to update* while a rebase is in progress
- **THEN** installation is blocked with an explanation and the banner remains

#### Scenario: Checksum mismatch
- **WHEN** the downloaded file's checksum does not match the feed
- **THEN** the download is discarded and a warning links to the manual download page

### Requirement: Builds where updating is unavailable
The system SHALL disable the updater in development builds and portable unpacked builds and report *Updates unavailable in this build* without errors. On macOS builds that are not signed and notarised, the banner MUST offer a download link instead of installing. On per-machine Windows installs that need elevation, the system MUST fall back to a visible installer with a note. On AppImage runs from a read-only location, the system MUST show the manual download link.

#### Scenario: Development build
- **WHEN** the app runs unpackaged
- **THEN** About shows *Updates unavailable in this build* and no check runs

#### Scenario: Unsigned macOS build
- **WHEN** a newer release exists on an unsigned macOS build
- **THEN** the banner offers *Download* to the release page rather than *Restart to update*

### Requirement: Settings
The system SHALL provide settings for automatic checks (default on), automatic download (default on) and release channel (default stable) in Options → Advanced.

#### Scenario: Switch to beta
- **WHEN** the user selects the beta channel and runs a check
- **THEN** prereleases newer than the running version are offered
