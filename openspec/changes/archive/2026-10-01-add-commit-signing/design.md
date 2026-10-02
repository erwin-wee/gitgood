# Design

## Context

See proposal.md. All git runs use `GIT_TERMINAL_PROMPT=0`, so a terminal pinentry cannot appear; graphical pinentries (default on Windows and macOS) open on their own. `operations.ts` has `getConfigIdentity` / `setConfigIdentity` to mirror. `log.ts` uses a `\x1f`-separated `FORMAT`. `tools.ts` has `findExecutable` with known install directories. `classifyGitError` maps stderr to `GitErrorInfo.code`.

## Goals / Non-Goals

**Goals:**
- Never handle passphrases in the app; only detect and explain.
- Keep default history loading fast by making verification opt-in.

**Non-Goals:**
- x509/smimesign beyond passing the format through; uploading keys to GitHub (`gh ssh-key add` / `gh gpg-key add`) is a follow-up; signature display in the PR dialog.

## Decisions

- **Signature placeholders behind an option.** git verifies signatures only when `%G?`-style placeholders are present, which is slow on large logs. `getHistory` gains `verifySignatures`, controlled by the `historyVerifySignatures` setting (default false). Parser accepts both formats.
- **Test signing outside git.** Use `gpg --batch --status-fd=2 --detach-sign` on a temp file and parse `NEED_PASSPHRASE` / `BAD_PASSPHRASE` status lines; `ssh-keygen -Y sign -n git -f <key> <tmp>` for SSH. Alternative (a throwaway `git commit-tree -S`) rejected because it hides which program failed.
- **Key validation before save.** GPG key IDs are checked against `--list-secret-keys`; SSH paths must exist. Pasted keys are stored as `key::<pubkey>`.
- **Commit override.** `createCommit` gains `signOverride: 'default' | 'sign' | 'unsigned'`; unsigned passes `--no-gpg-sign`. Rebase fallback `-c commit.gpgsign=false` only on explicit user choice.
- **Error classification.** New codes `signing-failed` (`gpg failed to sign the data`) and `signing-key-missing` (`No secret key`, `ssh-keygen: … No such file`).

Commands:

| Purpose | Command |
| --- | --- |
| Read config | `git config [--local|--global] --get gpg.format`, `user.signingkey`, `commit.gpgsign`, `tag.gpgsign`, `gpg.program`, `gpg.ssh.program`, `gpg.ssh.allowedSignersFile` |
| Write config | `git config [--global] <key> <value>` / `--unset` |
| List GPG keys | `gpg --list-secret-keys --with-colons --keyid-format=long` (parse `sec`, `uid`, `fpr`, expiry) |
| Test | `gpg --batch --status-fd=2 --detach-sign <tmp>`; `ssh-keygen -Y sign -n git -f <key> <tmp>` |
| History | `FORMAT` + `%G?%x1f%GS%x1f%GK` when `verifySignatures` |
| Commit / tag | `git commit [-S|--no-gpg-sign]`; `git tag -s` when `tag.gpgsign` |

Types and IPC:

```ts
interface SigningConfig { format: 'openpgp' | 'ssh' | 'x509' | null; key: string | null; signCommits; signTags; program: string | null; allowedSignersFile: string | null; scope: 'local' | 'global' | 'none' }
interface SigningKey { id; label; email: string | null; expires: string | null; kind: 'gpg' | 'ssh' }
type SignatureStatus = 'good' | 'bad' | 'unknown-key' | 'expired' | 'expired-key' | 'revoked' | 'untrusted' | 'none'
Commit.signature: { status: SignatureStatus; signer: string | null; keyId: string | null } | null

'repo.signing.get': (repoPath) => Promise<{ local; global; effective: SigningConfig }>
'repo.signing.set': (repoPath | null, scope: 'local' | 'global', patch: Partial<SigningConfig>) => Promise<void>
'app.signing.keys': (format: 'openpgp' | 'ssh', email: string | null) => Promise<SigningKey[]>
'app.signing.test': (repoPath) => Promise<{ ok; message; needsPassphrase }>
```

`CommitOptions.signOverride`, `HistoryOptions.verifySignatures`, setting `historyVerifySignatures`.

UI: Options → Git section (format radio, key picker with Detect and manual entry, scope toggle, Test button with result line, external link on GitHub verification); failure dialog *Commit could not be signed* with collapsible stderr; commit-form shield icon; History badges.

Windows: locate `gpg.exe` under `C:\Program Files (x86)\GnuPG\bin` via `findExecutable`; SSH signing requires OpenSSH ≥ 8.8, check `ssh -V`.

## Risks / Trade-offs

- [Linux without a graphical pinentry blocks or fails silently] → Test action detects `NEED_PASSPHRASE`, dialog explains and links to settings.
- [Verification slows large histories] → opt-in setting, default off.
- [`%GS` names contain UTF-8 or separators] → `\x1f` separator already used; add parser tests with non-ASCII names.
- [SSH signatures always show unknown key without allowed signers] → tooltip explains; allowed-signers file is configurable.
