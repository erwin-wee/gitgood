# Spec Delta

## Purpose

Lets users configure and test GPG or SSH commit signing, see whether commits in history carry valid signatures, and recover cleanly when a commit cannot be signed.

## ADDED Requirements

### Requirement: Configure signing at repository or global scope
The system SHALL provide a Commit signing section in Options → Git with a format choice (Off, GPG, SSH), a key, a sign-all-commits toggle, a sign-tags toggle and a scope selector (this repository or global). Saving MUST write the corresponding git configuration at the chosen scope, and turning signing off MUST only disable signing without changing other values.

#### Scenario: Enable SSH signing for one repository
- **WHEN** the user selects SSH, picks a public key file, enables sign all commits and saves with scope *This repository*
- **THEN** the repository's git configuration has the SSH format, the key path as signing key and commit signing enabled, and the global configuration is unchanged

#### Scenario: Turn signing off
- **WHEN** the user selects Off and saves
- **THEN** commit signing is disabled at the chosen scope and the previously configured key and format remain stored

### Requirement: Detect and pick keys
The system SHALL list available GPG secret keys matching the configured email and available SSH public keys, and MUST store the signing key in the form git expects: a key ID for GPG, a file path for an SSH key file, or the literal-key form for a pasted SSH public key. The system MUST NOT save a key that could not be found.

#### Scenario: Detect GPG keys
- **WHEN** the user clicks *Detect keys* with GPG selected
- **THEN** the picker lists each secret key with its ID, identity and expiry, highlighting keys whose email matches the commit email

#### Scenario: Pasted SSH key
- **WHEN** the user pastes an SSH public key string instead of choosing a file
- **THEN** the stored signing key uses the literal-key form recognised by git

#### Scenario: Unknown key rejected
- **WHEN** the user enters a GPG key ID that does not exist in the keyring and saves
- **THEN** the system refuses to save and explains that the key was not found

### Requirement: Test signing
The system SHALL offer a Test signing action that produces a signature with the configured setup and reports one of: success, passphrase required, or a distinct error such as signing program not found or SSH version too old.

#### Scenario: Missing program
- **WHEN** GPG is selected and no GPG program can be found
- **THEN** the test reports that the signing program is missing with an install hint, and key detection is disabled with the same hint

#### Scenario: Passphrase required
- **WHEN** the GPG key needs a passphrase and no agent has it cached
- **THEN** the test reports that a passphrase is required and explains that a graphical pinentry or running agent is needed because the app cannot show terminal prompts

### Requirement: Signing failure during commit
The system SHALL, when git fails to sign a commit or an amend, show a dialog stating the classified cause with the raw error available, offering Retry, Commit unsigned this time, and Open signing settings. Commit unsigned MUST complete the same commit without a signature and without changing configuration.

#### Scenario: Commit unsigned this time
- **WHEN** a commit fails because the signing key is missing and the user chooses *Commit unsigned this time*
- **THEN** the commit is created without a signature, the signing configuration is unchanged and the next commit attempts signing again

#### Scenario: Failure during history rewrite
- **WHEN** signing fails while rewriting commits during a squash or reword
- **THEN** the rewrite stays in progress, the existing in-progress banner is shown and the dialog offers the same recovery choices

### Requirement: Signature badges in history
The system SHALL, when signature verification is enabled in settings, show a badge on each commit in History indicating good, bad, unknown key, expired, revoked or untrusted signature, with the signer identity shown on hover and in the details pane. When verification is disabled the system MUST NOT verify signatures and history loading performance MUST be unchanged.

#### Scenario: Good signature
- **WHEN** verification is enabled and a commit has a valid signature from a known key
- **THEN** the commit shows a good-signature badge and hovering shows the signer's name

#### Scenario: Unknown SSH signer
- **WHEN** verification is enabled, a commit is SSH-signed and no allowed-signers file is configured
- **THEN** the commit shows an unknown-key badge whose tooltip explains that an allowed-signers file is needed for local verification

#### Scenario: Verification off
- **WHEN** verification is disabled
- **THEN** no badges are shown and history loads without requesting signature information

### Requirement: Commit form indicates signing
The system SHALL show a small indicator in the commit form when the effective configuration signs commits.

#### Scenario: Indicator shown
- **WHEN** sign-all-commits is enabled at any scope that applies to the repository
- **THEN** the commit form shows the signing indicator
