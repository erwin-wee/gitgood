# Proposal

## Why

Many organisations require signed commits and GitHub marks unsigned ones *Unverified*, yet GitHub Desktop has no signing UI at all. GitGood runs git with terminal prompts disabled, so a passphrase prompt from a signing program fails or hangs unless the app handles signing explicitly.

## What Changes

- Add a *Commit signing* section under Options → Git to configure GPG or SSH signing (format, key, sign commits, sign tags) at repository or global scope, with key detection and a **Test signing** action.
- Show signature badges (good, bad, unknown key, expired) on commits in History behind an opt-in setting, with signer identity in the details pane.
- Handle signing failures during commit with a dialog offering Retry, Commit unsigned this time, and Open signing settings.
- Classify signing-related git errors distinctly from other failures.

## Capabilities

### New Capabilities
- `commit-signing`: configuring commit and tag signing, testing the signing setup, verifying signatures in history, and recovering from signing failures.

### Modified Capabilities
- (none; history loading keeps its default behaviour unless signature verification is enabled, and committing is unchanged when signing is off.)

## Impact

- `git` commands: `git config [--local|--global] gpg.format|user.signingkey|commit.gpgsign|tag.gpgsign|gpg.program|gpg.ssh.program|gpg.ssh.allowedSignersFile`, `git commit -S` / `--no-gpg-sign`, `git tag -s`, log format placeholders `%G? %GS %GK`.
- External tools: `gpg --list-secret-keys --with-colons --keyid-format=long`, `gpg --detach-sign` (test), `ssh-keygen -Y sign` (test; needs OpenSSH 8.8+).
- Code: `src/main/git/operations.ts` (signing config read/write following the identity config pattern), new `src/main/git/signing.ts`, `src/main/git/log.ts` (optional signature placeholders and parser fields), `src/main/git/commit.ts` (sign override), error classification in `src/main/exec.ts` or its git wrapper, `src/main/tools.ts` (locate gpg/ssh-keygen), `src/shared/types.ts` / `src/shared/ipc.ts`, Options → Git UI, History badges, failure dialog.
- Rewriting history (rebase, squash, reword, amend) re-signs commits; failures there surface through the same dialog and the existing in-progress banner.
