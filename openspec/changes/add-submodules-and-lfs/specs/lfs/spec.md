# Spec Delta

## Purpose

Makes Git LFS visible and manageable inside the app: users can see which files are LFS pointers, whether LFS is installed and hooked, and fetch, pull, track or prune objects without the command line.

## ADDED Requirements

### Requirement: Detect LFS usage and installation
The system SHALL detect when a repository uses LFS (a `filter=lfs` attribute) and whether the LFS extension is installed. When the repository uses LFS and the extension is missing, the system MUST show a banner with platform-specific install instructions and disable LFS actions with the same hint.

#### Scenario: LFS missing
- **WHEN** the repository's attributes use the LFS filter and `git lfs` is not installed
- **THEN** a banner explains that the repository uses Git LFS, which is not installed, with an install command for the current platform

#### Scenario: LFS installed
- **WHEN** LFS is installed
- **THEN** the Git LFS dialog shows the version, whether hooks are installed, tracked patterns, tracked file count and local object size

### Requirement: Pointer files are labelled
The system SHALL recognise LFS pointer files (content starting with the LFS pointer version line, with or without a trailing carriage return) in the Changes and History file lists and label them with an LFS chip. The diff pane MUST show an LFS summary with object size and the old and new object identifiers, and MUST render the image diff when both objects are present locally and are images.

#### Scenario: Pointer changed
- **WHEN** a commit changes an LFS-tracked binary file
- **THEN** the file list shows the LFS chip and the diff pane shows the object size and both object identifiers instead of a binary placeholder

#### Scenario: Image with local objects
- **WHEN** both versions of an LFS-tracked image are present locally
- **THEN** the diff pane shows the image diff modes used for regular images

#### Scenario: Missing object
- **WHEN** a pointer file's object is not present locally
- **THEN** the diff pane offers *Download* which fetches that object and then displays the summary or image diff

### Requirement: Manage LFS from a dialog
The system SHALL provide a Git LFS dialog with Install hooks, Track pattern, Untrack, Fetch all LFS objects, Pull LFS objects and Prune. Track and Untrack MUST update the attributes file and stage it. Prune MUST show the dry-run count and size and require confirmation before deleting. Fetch and pull MUST show progress and be cancellable.

#### Scenario: Track a pattern
- **WHEN** the user tracks `*.psd`
- **THEN** the attributes file contains the LFS filter rule for `*.psd`, preserving its existing line endings, and the file is staged

#### Scenario: Prune with confirmation
- **WHEN** the user clicks *Prune*
- **THEN** the dialog shows how many objects and bytes would be removed and deletes them only after the user confirms

#### Scenario: Hooks missing
- **WHEN** LFS is installed but hooks are not installed for the repository
- **THEN** the status card warns that pushes would upload pointers only and offers *Install hooks*
