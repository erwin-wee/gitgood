# Stash Specification

## Purpose

Stashing sets uncommitted changes aside and restores them later, so a user can switch branches or clear the working tree without losing work, and can inspect what a stash contains before restoring it.

## Requirements

### Requirement: Stash or carry changes on branch switch
When the user switches branches with uncommitted changes, the app SHALL offer to carry the changes to the new branch or to stash them on the current branch, honouring the configured default strategy. A stash created this way SHALL be marked as created by the app for that branch.

#### Scenario: Stash on switch
- **WHEN** the user chooses to leave changes on the current branch
- **THEN** the changes are stashed, the branch is switched, and the stash is associated with the original branch

#### Scenario: Carry on switch
- **WHEN** the user chooses to bring changes to the new branch and they apply cleanly
- **THEN** the branch is switched with the changes still uncommitted in the working tree

### Requirement: Stash all changes
The user SHALL be able to stash all current changes from the Changes tab, including untracked files.

#### Scenario: Stash all
- **WHEN** the user chooses "Stash all changes"
- **THEN** the working tree becomes clean and a new stash appears in the stash list

### Requirement: Stash list
The Changes tab SHALL list every stash in the repository with its message, whether it was created by the app, and the branch it belongs to when known, with stashes for the current branch listed first.

#### Scenario: Stashes from the terminal
- **WHEN** a stash was created outside the app
- **THEN** it still appears in the list, marked as not created by the app

### Requirement: Inspect a stash
Selecting a stash SHALL list the files it contains and show the diff of a selected file against the stash's parent commit.

#### Scenario: View stashed file
- **WHEN** the user selects a stash and one of its files
- **THEN** the diff pane shows the stashed changes for that file

### Requirement: Restore and discard a stash
The user SHALL be able to apply a stash while keeping it, restore it (apply and drop), or discard it. Discarding SHALL ask for confirmation when the corresponding confirmation setting is on. A restore that conflicts SHALL keep the stash and start the conflict flow.

#### Scenario: Apply and keep
- **WHEN** the user chooses "Apply (keep stash)"
- **THEN** the changes are applied to the working tree and the stash remains listed

#### Scenario: Restore with conflicts
- **WHEN** restoring a stash conflicts with the working tree
- **THEN** the conflict banner appears and the stash is still listed

#### Scenario: Discard
- **WHEN** the user confirms "Discard stash"
- **THEN** the stash is removed from the list
