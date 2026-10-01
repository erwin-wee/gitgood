# Tasks

## 1. Shared contract

- [x] 1.1 Add `SigningConfig`, `SigningKey`, `SignatureStatus`, `Commit.signature`, `CommitOptions.signOverride`, `HistoryOptions.verifySignatures`, the `repo.signing.*` / `app.signing.*` methods and the `historyVerifySignatures` setting; verify `npm run typecheck`

## 2. Main process

- [x] 2.1 Implement signing config read/write at local and global scope in `src/main/git/operations.ts`; verify with a temp-repo test that values round-trip and global is untouched for local writes
- [x] 2.2 Implement `src/main/git/signing.ts`: GPG `--with-colons` parser, SSH public key discovery in `~/.ssh`, key validation, pasted-key `key::` form; verify with unit tests on sample output
- [x] 2.3 Implement Test signing for GPG (status-fd parsing) and SSH (`ssh-keygen -Y sign`, version check); verify distinct results for success, passphrase required and missing program using stubbed executables
- [x] 2.4 Add `%G?%GS%GK` placeholders to the log format when `verifySignatures` is set and extend the parser; verify `parseLog` tests with and without the fields and with a non-ASCII signer
- [x] 2.5 Add `signOverride` to commit creation and `tag -s` support; add `signing-failed` and `signing-key-missing` error codes; verify classification unit tests on sample stderr
- [x] 2.6 Locate `gpg` and `ssh-keygen` in `src/main/tools.ts` including Windows known directories; verify tools state reports them

## 3. Renderer

- [x] 3.1 Build the Options → Git Commit signing section with format, key picker, Detect, scope, toggles and Test result; verify save writes config in a smoke run
- [x] 3.2 Build the *Commit could not be signed* dialog with Retry, Commit unsigned this time and Open signing settings; verify in a repo with a missing key that the dialog appears and unsigned commit succeeds
- [x] 3.3 Add History signature badges with tooltips and the details-pane signer line, shown only when verification is enabled; verify badges for good, bad and unknown-key fixtures
- [x] 3.4 Add the commit-form signing indicator; verify it appears when effective config signs

## 4. Verification

- [x] 4.1 Linux fixture test: throwaway GPG key with empty passphrase and an ed25519 SSH key with allowed-signers; commit through the app wrappers and verify `%G?` is `G`
- [x] 4.2 Run `npm run typecheck` and `npm test`; verify both pass
- [x] 4.3 Smoke pass: screenshot Options → Git section; drive a failing-key commit and verify the failure dialog appears in the store dump
- [x] 4.4 Update README Features; verify text
