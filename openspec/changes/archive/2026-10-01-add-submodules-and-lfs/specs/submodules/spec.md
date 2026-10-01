# Spec Delta

## Purpose

Shows the state of every submodule in a repository and lets users initialize, update, sync and open them, so cloned repositories are never left with silently empty directories.

## ADDED Requirements

### Requirement: Submodules dialog lists state
The system SHALL provide a Submodules dialog from the Repository menu listing each submodule, including nested ones up to three levels, with its path, URL, recorded commit, checked-out commit and one of the states: up to date, not initialized, modified, differs from recorded, conflicted, missing.

#### Scenario: Uninitialized submodule
- **WHEN** the repository has a submodule whose directory is empty
- **THEN** the dialog lists it as not initialized with its URL and recorded commit

#### Scenario: Submodule moved to another commit
- **WHEN** a submodule's checked-out commit differs from the commit recorded in the superproject
- **THEN** the dialog lists it as differs from recorded, showing both commits

#### Scenario: Relative URL
- **WHEN** a submodule URL is relative (for example `../lib.git`)
- **THEN** the dialog displays it resolved against the superproject's origin, without changing the stored configuration

### Requirement: Initialize and update submodules
The system SHALL offer Initialize and update all, per-submodule Update, and Sync URLs. Updates MUST show transfer progress, be cancellable, and leave each updated submodule at its recorded commit.

#### Scenario: Initialize all after clone
- **WHEN** the user clicks *Initialize and update all*
- **THEN** every submodule is checked out at its recorded commit, progress is shown while fetching, and the dialog states show up to date

#### Scenario: Network failure
- **WHEN** a submodule update fails because the remote is unreachable
- **THEN** the classified network error is shown and other submodules' states are unaffected

### Requirement: Post-clone banner
The system SHALL show a banner after cloning or opening a repository that has a `.gitmodules` file and at least one uninitialized submodule, offering to initialize and update all.

#### Scenario: Banner appears
- **WHEN** a repository with uninitialized submodules is cloned
- **THEN** a banner offers *Initialize and update all* and disappears once no submodule is uninitialized

### Requirement: Open submodule as repository
The system SHALL let the user open a submodule as its own repository in the repository list, nested under its parent, and show it in the file manager.

#### Scenario: Open as repository
- **WHEN** the user clicks *Open as repository* on a submodule
- **THEN** the submodule appears in the repository list linked to its parent and becomes the current repository

### Requirement: Submodule rows in Changes and diff pane
The system SHALL show submodule changes in the Changes tab with the diff pane's submodule summary, which MUST offer *Update to recorded commit* and *Open submodule*.

#### Scenario: Update to recorded commit
- **WHEN** the user clicks *Update to recorded commit* on a modified submodule row
- **THEN** the submodule is checked out at the commit recorded in the current HEAD and the row disappears from Changes
