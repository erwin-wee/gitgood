/**
 * Pure policy for the AI command palette (add-ai-command-palette). The model
 * only ever proposes `argv` arrays; this module is the sole authority on
 * whether GitGood will actually run one. It never touches Electron, git or
 * the filesystem, so it can be exercised with a plain table of inputs and
 * expected outputs (see test/nl-policy.test.ts).
 *
 * Model output is untrusted input. Every step is:
 *  1. Stripped of a leading literal "git" token.
 *  2. Rejected outright if any argv element contains a shell metacharacter,
 *     starts with "!" (a git alias), or matches one of a small set of
 *     never-run flags/commands (config, submodule writes, -c/--exec/
 *     --git-dir/--work-tree/-C, force push without --force-with-lease,
 *     reflog expire, gc --prune, filter-branch, update-ref, remote add/
 *     set-url, git rm, any non-"git" command).
 *  3. Matched against a small grammar of allowed shapes, one per family
 *     (inspect / branch / commit / stash / sync / integrate / discard /
 *     tags). Anything that does not match is left non-executable.
 *  4. Checked against the live repository context (known branches/tags,
 *     current status paths, detached HEAD, in-progress operation) so a step
 *     naming something that does not exist, or a family not allowed mid
 *     merge/rebase, is refused.
 *  5. Given a risk classification that is the higher of the model's own
 *     guess and this module's independent classification of the matched
 *     shape, and, when executable, an `ApiMethods` key ("mappedAction")
 *     plus the typed arguments GitGood will call it with.
 *
 * `clean -fd` is always copy-only (see design.md's open question): it never
 * gets a mappedAction, regardless of arguments.
 */
import type { NlRisk, NlStep, OperationKind } from '@shared/types';

export const MAX_STEPS = 8;

export interface RawNlStep {
  argv: string[];
  explanation: string;
  risk: NlRisk;
}

export interface RawNlPlan {
  clarifyingQuestion: string | null;
  steps: RawNlStep[];
}

export interface NlPolicyContext {
  /** Local and remote-tracking branch short names, e.g. "main", "origin/main". */
  branches: string[];
  tags: string[];
  /** Repository-relative paths currently reported by `git status` (staged, unstaged or untracked). */
  statusPaths: string[];
  /**
   * Current stashes, indexed the way `git stash list` prints them (index 0
   * is the most recent). The AI-brief's shell-metacharacter denylist forbids
   * `{`/`}` in any argv element, so the palette never uses git's own
   * `stash@{N}` syntax: the model (and this grammar) refer to a stash by
   * its plain index or by its commit SHA, and the policy resolves that to
   * the SHA `git.stash.*` wrappers expect (they re-resolve the live
   * `stash@{N}` ref from the SHA at execution time, which is also immune to
   * index drift from other stash operations in between).
   */
  stashes: { index: number; sha: string }[];
  currentBranch: string | null;
  detached: boolean;
  operation: OperationKind;
}

export interface EvaluatedPlan {
  steps: NlStep[];
  clarifyingQuestion: string | null;
  /** True when the raw plan had more than MAX_STEPS steps; `steps` is then empty and the caller should reject the whole plan. */
  tooManySteps: boolean;
}

const RISK_RANK: Record<NlRisk, number> = { safe: 0, 'changes-history': 1, 'touches-remote': 2, 'discards-work': 3 };

/** The risk shown is the higher (more severe) of the model's own guess and the policy's independent classification. */
export function higherRisk(a: NlRisk, b: NlRisk): NlRisk {
  return RISK_RANK[a] >= RISK_RANK[b] ? a : b;
}

// ---------------------------------------------------------------------------
// Shell metacharacters and other unconditional token-level rejections
// ---------------------------------------------------------------------------

/** `; | & > < \` $ ( ) { }` and newline — checked on every raw argv element, never on a joined string (GitGood never builds one). */
const SHELL_META_CHARS = [';', '|', '&', '>', '<', '`', '$', '(', ')', '{', '}', '\n'];

function firstShellMetachar(token: string): string | null {
  for (const ch of SHELL_META_CHARS) if (token.includes(ch)) return ch === '\n' ? 'newline' : ch;
  return null;
}

/** Flags that change what git operates on or that can run/write arbitrary things, denied on every command regardless of family. */
const DANGEROUS_FLAG_PATTERNS: { re: RegExp; reason: string }[] = [
  { re: /^-c$/, reason: 'the -c option can override git configuration and is never run automatically' },
  { re: /^--exec(=.*)?$/, reason: 'the --exec option runs an arbitrary program and is never run automatically' },
  { re: /^--upload-pack(=.*)?$/, reason: 'the --upload-pack option runs an arbitrary program and is never run automatically' },
  { re: /^--receive-pack(=.*)?$/, reason: 'the --receive-pack option runs an arbitrary program and is never run automatically' },
  { re: /^-C$/, reason: 'the -C option changes which repository git operates on and is never run automatically' },
  { re: /^--git-dir(=.*)?$/, reason: 'the --git-dir option changes which repository git operates on and is never run automatically' },
  { re: /^--work-tree(=.*)?$/, reason: 'the --work-tree option changes which working tree git operates on and is never run automatically' },
  { re: /^--output(=.*)?$/, reason: 'the --output option writes to an arbitrary file and is never run automatically' },
  { re: /^--no-index$/, reason: 'the --no-index option compares files outside the repository and is never run automatically' },
  { re: /^--ext-diff$/, reason: 'the --ext-diff option runs an external diff program and is never run automatically' },
  { re: /^--textconv$/, reason: 'the --textconv option runs an external conversion program and is never run automatically' },
  { re: /^-O.+$/, reason: 'the -O option reads an arbitrary order file and is never run automatically' },
];

/**
 * Absolute paths (POSIX or Windows drive) and `..` path segments are refused
 * in every positional argument so an inspect command can only ever read
 * inside the repository. Revision ranges like `main..feature` are untouched
 * (the `..` there is not a path segment).
 */
export function hasUnsafePathToken(token: string): boolean {
  return /^\/|^[A-Za-z]:[\\/]|^\\\\|(^|[\\/])\.\.([\\/]|$)/.test(token);
}

/** Whole commands (argv[0] after stripping a leading "git") that are never run, independent of the allowlist grammar below. */
const DENYLISTED_COMMAND_REASONS: Record<string, string> = {
  config: 'changing git configuration is never run automatically',
  submodule: 'submodule writes are never run automatically',
  worktree: 'worktree writes are never run automatically',
  rm: 'git rm is never run automatically; use a discard command instead',
  'filter-branch': 'history-rewriting maintenance commands are never run automatically',
  'update-ref': 'update-ref can silently rewrite refs and is never run automatically',
  gc: 'repository maintenance commands like gc are never run automatically',
  clone: 'cloning a repository is never run from the command palette',
  init: 'initializing a repository is never run from the command palette',
  am: 'applying mailbox patches is never run from the command palette',
  apply: 'applying a raw patch is never run from the command palette',
  archive: 'archiving is not part of the command palette',
  bisect: 'bisecting is not part of the command palette',
  notes: 'git notes are not part of the command palette',
  replace: 'git replace is not part of the command palette',
};

/** git strips a leading literal "git"/"git.exe" token; everything else is passed through unchanged. */
export function stripLeadingGit(argv: string[]): string[] {
  if (argv.length && /^git(\.exe)?$/i.test(argv[0])) return argv.slice(1);
  return argv;
}

function isShaLike(ref: string): boolean {
  return /^[0-9a-f]{7,40}$/i.test(ref);
}

/** True when `ref` is something the policy can already confirm resolves: a known branch/tag, HEAD (with ~/^ modifiers), an upstream shorthand, or a full/short SHA. Anything else is refused as an unknown reference. */
function isKnownRef(ref: string, ctx: NlPolicyContext): boolean {
  if (!ref) return false;
  if (ref === 'HEAD' || /^HEAD[~^][\w~^]*$/.test(ref)) return true;
  if (ref === '@' || /^@[~^][\w~^]*$/.test(ref)) return true;
  if (ref === '@{u}' || ref === '@{upstream}') return true;
  if (isShaLike(ref)) return true;
  if (ctx.branches.includes(ref)) return true;
  if (ctx.tags.includes(ref)) return true;
  return false;
}

/** Repo-relative POSIX path with no `..` segment, no absolute root, and no leading "-" (which would be read as a flag). */
function isSafeRepoPath(path: string): boolean {
  if (!path) return false;
  if (path.startsWith('-')) return false;
  if (path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path)) return false;
  if (path.includes('\\')) return false;
  const segments = path.split('/');
  return segments.every((s) => s !== '..' && s !== '.');
}

// ---------------------------------------------------------------------------
// Families allowed mid merge/rebase/cherry-pick/revert
// ---------------------------------------------------------------------------

type Family = 'inspect' | 'branch' | 'commit' | 'stash' | 'sync' | 'integrate' | 'discard' | 'tags';

const FAMILIES_DURING_OPERATION = new Set<Family>(['inspect', 'integrate']);

interface MatchResult {
  family: Family;
  risk: NlRisk;
  mappedAction: string | null;
  mappedArgs: unknown[];
  /** Set when the shape matched but a referenced ref/path is unknown or out of bounds; the step is still non-executable but keeps its family for the operation-in-progress check. */
  refusalReason?: string;
}

function flag(argv: string[], ...names: string[]): boolean {
  return argv.some((a) => names.includes(a));
}

function nonFlagArgs(argv: string[]): string[] {
  return argv.filter((a) => !a.startsWith('-'));
}

// ---- inspect --------------------------------------------------------------

const INSPECT_COMMANDS = new Set(['status', 'log', 'show', 'diff', 'rev-parse']);

function matchInspect(cmd: string, rest: string[]): MatchResult | null {
  // Inspect commands read only: refuse anything that could reach outside the repository.
  if (rest.some(hasUnsafePathToken)) return null;
  if (INSPECT_COMMANDS.has(cmd)) {
    return { family: 'inspect', risk: 'safe', mappedAction: 'git.tryRun', mappedArgs: [[cmd, ...rest]] };
  }
  if (cmd === 'branch') {
    // Inspect-only branch shape: no mutating flag (-d/-D/-m/-M/-c/-C) and no bare create/checkout form.
    if (rest.some((a) => /^(-d|-D|--delete|-m|-M|--move|-c|-C|--copy)$/.test(a))) return null;
    return { family: 'inspect', risk: 'safe', mappedAction: 'git.tryRun', mappedArgs: [['branch', ...rest]] };
  }
  if (cmd === 'stash' && rest[0] === 'list') {
    return { family: 'inspect', risk: 'safe', mappedAction: 'git.tryRun', mappedArgs: [['stash', 'list', ...rest.slice(1)]] };
  }
  if (cmd === 'reflog' && (rest.length === 0 || rest[0] === 'show')) {
    return { family: 'inspect', risk: 'safe', mappedAction: 'git.tryRun', mappedArgs: [['reflog', ...rest]] };
  }
  return null;
}

// ---- branch -----------------------------------------------------------

function matchBranch(cmd: string, rest: string[], ctx: NlPolicyContext): MatchResult | null {
  if ((cmd === 'switch' || cmd === 'checkout') && rest.length === 1 && !rest[0].startsWith('-')) {
    const ref = rest[0];
    if (!isKnownRef(ref, ctx)) return { family: 'branch', risk: 'safe', mappedAction: null, mappedArgs: [], refusalReason: `"${ref}" does not match a known branch, tag or commit.` };
    return { family: 'branch', risk: 'safe', mappedAction: 'git.checkout', mappedArgs: [ref, 'ask'] };
  }
  if (cmd === 'checkout' && rest[0] === '-b') {
    const name = rest[1];
    const start = rest[2];
    if (!name || name.startsWith('-')) return null;
    if (start && !isKnownRef(start, ctx)) return { family: 'branch', risk: 'safe', mappedAction: null, mappedArgs: [], refusalReason: `"${start}" does not match a known branch, tag or commit.` };
    return { family: 'branch', risk: 'safe', mappedAction: 'git.branch.create', mappedArgs: [name, start ?? null, true, 'ask'] };
  }
  if (cmd === 'branch' && rest[0] === '-m' && rest.length === 3) {
    return { family: 'branch', risk: 'safe', mappedAction: 'git.branch.rename', mappedArgs: [rest[1], rest[2]] };
  }
  if (cmd === 'branch' && rest[0] === '-d' && rest.length === 2 && !rest[1].startsWith('-')) {
    const name = rest[1];
    if (!ctx.branches.includes(name)) return { family: 'branch', risk: 'changes-history', mappedAction: null, mappedArgs: [], refusalReason: `"${name}" does not match a known branch.` };
    return { family: 'branch', risk: 'changes-history', mappedAction: 'git.branch.delete', mappedArgs: [name, false] };
  }
  return null;
}

// ---- commit -------------------------------------------------------------

function matchCommit(cmd: string, rest: string[], ctx: NlPolicyContext): MatchResult | null {
  if (cmd === 'commit' && flag(rest, '--amend')) {
    // No single ApiMethods call performs a bare "reuse the previous message" amend the way the
    // Changes tab does (git.commit needs the full CommitOptions the commit form builds); shown copy-only.
    return { family: 'commit', risk: 'changes-history', mappedAction: null, mappedArgs: [], refusalReason: 'Amending a commit needs the commit form; open Changes and use "Amend last commit" instead.' };
  }
  if (cmd === 'reset' && flag(rest, '--soft')) {
    const ref = nonFlagArgs(rest)[0];
    if (!ref) return null;
    if (!isKnownRef(ref, ctx)) return { family: 'commit', risk: 'changes-history', mappedAction: null, mappedArgs: [], refusalReason: `"${ref}" does not match a known branch, tag or commit.` };
    // The only wrapper GitGood exposes for a soft reset is "undo the last commit" (reset --soft HEAD~1).
    if (ref === 'HEAD~1') return { family: 'commit', risk: 'changes-history', mappedAction: 'git.undoCommit', mappedArgs: [] };
    return { family: 'commit', risk: 'changes-history', mappedAction: null, mappedArgs: [], refusalReason: 'GitGood only runs "reset --soft HEAD~1" (undo last commit) automatically; other soft resets are copy-only.' };
  }
  if (cmd === 'revert' && rest.length === 1 && !rest[0].startsWith('-')) {
    const ref = rest[0];
    if (!isKnownRef(ref, ctx)) return { family: 'commit', risk: 'changes-history', mappedAction: null, mappedArgs: [], refusalReason: `"${ref}" does not match a known commit.` };
    return { family: 'commit', risk: 'changes-history', mappedAction: 'git.revert', mappedArgs: [ref] };
  }
  if (cmd === 'revert' && rest[0] === '--abort') return { family: 'commit', risk: 'safe', mappedAction: 'git.revert.abort', mappedArgs: [] };
  if (cmd === 'revert' && rest[0] === '--continue') return { family: 'commit', risk: 'changes-history', mappedAction: 'git.revert.continue', mappedArgs: [] };
  if (cmd === 'cherry-pick' && rest[0] === '--abort') return { family: 'commit', risk: 'safe', mappedAction: 'git.cherryPick.abort', mappedArgs: [] };
  if (cmd === 'cherry-pick' && rest[0] === '--continue') return { family: 'commit', risk: 'changes-history', mappedAction: 'git.cherryPick.continue', mappedArgs: [] };
  if (cmd === 'cherry-pick') {
    const shas = nonFlagArgs(rest);
    if (!shas.length) return null;
    const unknown = shas.find((s) => !isKnownRef(s, ctx));
    if (unknown) return { family: 'commit', risk: 'changes-history', mappedAction: null, mappedArgs: [], refusalReason: `"${unknown}" does not match a known commit.` };
    return { family: 'commit', risk: 'changes-history', mappedAction: 'git.cherryPick', mappedArgs: [shas] };
  }
  return null;
}

// ---- stash ----------------------------------------------------------------

/** Resolves a plain stash index ("0") or a SHA-like token to the stash's commit SHA, or null when it does not match any current stash. Never accepts git's own `stash@{N}` syntax (see NlPolicyContext.stashes doc comment: `{`/`}` are always rejected as shell metacharacters). */
function resolveStashSha(token: string, ctx: NlPolicyContext): string | null {
  if (/^\d+$/.test(token)) return ctx.stashes.find((s) => s.index === parseInt(token, 10))?.sha ?? null;
  if (isShaLike(token)) return ctx.stashes.find((s) => s.sha.startsWith(token) || s.sha === token)?.sha ?? null;
  return null;
}

function matchStash(cmd: string, rest: string[], ctx: NlPolicyContext): MatchResult | null {
  if (cmd !== 'stash') return null;
  const sub = rest[0];
  if (sub === 'push') {
    const args = rest.slice(1);
    const includeUntracked = flag(args, '-u', '--include-untracked');
    const mIdx = args.findIndex((a) => a === '-m' || a === '--message');
    const message = mIdx !== -1 ? args[mIdx + 1] ?? null : null;
    return { family: 'stash', risk: 'safe', mappedAction: 'git.stash.push', mappedArgs: [message, includeUntracked, null] };
  }
  if (sub === 'pop' || sub === 'apply' || sub === 'drop') {
    const token = rest[1];
    if (!token) return null;
    const risk: NlRisk = sub === 'drop' ? 'discards-work' : 'safe';
    const sha = resolveStashSha(token, ctx);
    if (!sha) return { family: 'stash', risk, mappedAction: null, mappedArgs: [], refusalReason: `"${token}" does not match a current stash.` };
    const mappedAction = sub === 'pop' ? 'git.stash.pop' : sub === 'apply' ? 'git.stash.apply' : 'git.stash.drop';
    return { family: 'stash', risk, mappedAction, mappedArgs: [sha] };
  }
  return null;
}

// ---- sync (fetch/pull/push) -------------------------------------------------

function matchSync(cmd: string, rest: string[], ctx: NlPolicyContext): MatchResult | null {
  if (cmd === 'fetch') {
    const remote = nonFlagArgs(rest)[0] ?? null;
    return { family: 'sync', risk: 'safe', mappedAction: 'git.fetch', mappedArgs: [remote] };
  }
  if (cmd === 'pull') {
    return { family: 'sync', risk: 'safe', mappedAction: 'git.pull', mappedArgs: [] };
  }
  if (cmd === 'push') {
    const hasForce = flag(rest, '--force', '-f');
    const hasLease = rest.some((a) => a === '--force-with-lease' || a.startsWith('--force-with-lease='));
    if (hasForce && !hasLease) {
      return { family: 'sync', risk: 'touches-remote', mappedAction: null, mappedArgs: [], refusalReason: 'force pushes without lease are not run by GitGood; use --force-with-lease instead.' };
    }
    if (ctx.detached) return { family: 'sync', risk: 'touches-remote', mappedAction: null, mappedArgs: [], refusalReason: 'HEAD is detached; there is no branch to push.' };
    const setUpstream = flag(rest, '-u', '--set-upstream');
    const args = nonFlagArgs(rest);
    const remote = args[0] ?? null;
    const branch = args[1] ?? null;
    return { family: 'sync', risk: hasLease ? 'touches-remote' : 'touches-remote', mappedAction: 'git.push', mappedArgs: [{ force: hasLease, setUpstream, remote, branch, tags: false }] };
  }
  return null;
}

// ---- integrate (merge/rebase) ----------------------------------------------

function matchIntegrate(cmd: string, rest: string[], ctx: NlPolicyContext): MatchResult | null {
  if (cmd === 'merge' && rest[0] === '--abort') return { family: 'integrate', risk: 'safe', mappedAction: 'git.merge.abort', mappedArgs: [] };
  if (cmd === 'merge' && (rest[0] === '--continue' || rest.join(' ') === '--no-edit')) return { family: 'integrate', risk: 'changes-history', mappedAction: 'git.merge.continue', mappedArgs: [] };
  if (cmd === 'merge') {
    const branch = nonFlagArgs(rest)[0];
    if (!branch) return null;
    if (!isKnownRef(branch, ctx)) return { family: 'integrate', risk: 'changes-history', mappedAction: null, mappedArgs: [], refusalReason: `"${branch}" does not match a known branch.` };
    return { family: 'integrate', risk: 'changes-history', mappedAction: 'git.merge', mappedArgs: [branch, false] };
  }
  if (cmd === 'rebase' && rest[0] === '--abort') return { family: 'integrate', risk: 'safe', mappedAction: 'git.rebase.abort', mappedArgs: [] };
  if (cmd === 'rebase' && rest[0] === '--continue') return { family: 'integrate', risk: 'changes-history', mappedAction: 'git.rebase.continue', mappedArgs: [] };
  if (cmd === 'rebase') {
    const onto = nonFlagArgs(rest)[0];
    if (!onto) return null;
    if (ctx.operation !== 'none') return { family: 'integrate', risk: 'changes-history', mappedAction: null, mappedArgs: [], refusalReason: `A ${ctx.operation} is already in progress; finish or abort it first.` };
    if (!isKnownRef(onto, ctx)) return { family: 'integrate', risk: 'changes-history', mappedAction: null, mappedArgs: [], refusalReason: `"${onto}" does not match a known branch, tag or commit.` };
    return { family: 'integrate', risk: 'changes-history', mappedAction: 'git.rebase', mappedArgs: [onto] };
  }
  return null;
}

// ---- discard ----------------------------------------------------------------

function matchDiscard(cmd: string, rest: string[], ctx: NlPolicyContext): MatchResult | null {
  if (cmd === 'clean') {
    // Design's open question resolves "clean -fd" as always copy-only, regardless of arguments.
    return { family: 'discard', risk: 'discards-work', mappedAction: null, mappedArgs: [], refusalReason: 'git clean is always shown copy-only in GitGood, never run automatically.' };
  }
  if (cmd === 'restore' || (cmd === 'checkout' && rest[0] === '--')) {
    const paths = cmd === 'checkout' ? rest.slice(1) : nonFlagArgs(rest);
    if (!paths.length) return null;
    const bad = paths.find((p) => !isSafeRepoPath(p));
    if (bad) return { family: 'discard', risk: 'discards-work', mappedAction: null, mappedArgs: [], refusalReason: `"${bad}" is not a safe repository-relative path.` };
    const unknown = paths.find((p) => !ctx.statusPaths.includes(p));
    if (unknown) return { family: 'discard', risk: 'discards-work', mappedAction: null, mappedArgs: [], refusalReason: `"${unknown}" does not have pending changes in the current status.` };
    return { family: 'discard', risk: 'discards-work', mappedAction: 'git.discard', mappedArgs: [paths, true] };
  }
  if (cmd === 'reset' && flag(rest, '--hard')) {
    const ref = nonFlagArgs(rest)[0] ?? 'HEAD';
    if (!isKnownRef(ref, ctx)) return { family: 'discard', risk: 'discards-work', mappedAction: null, mappedArgs: [], refusalReason: `"${ref}" does not match a known branch, tag or commit.` };
    // No dedicated "reset --hard <ref>" wrapper exists beyond discarding everything back to HEAD.
    if (ref === 'HEAD') return { family: 'discard', risk: 'discards-work', mappedAction: 'git.discardAll', mappedArgs: [true] };
    return { family: 'discard', risk: 'discards-work', mappedAction: null, mappedArgs: [], refusalReason: 'GitGood only runs "reset --hard HEAD" (discard all changes) automatically; other hard resets are copy-only.' };
  }
  return null;
}

// ---- tags -------------------------------------------------------------------

function matchTags(cmd: string, rest: string[], ctx: NlPolicyContext): MatchResult | null {
  if (cmd === 'tag') {
    if (rest[0] === '-d' && rest[1] && !rest[1].startsWith('-')) {
      const name = rest[1];
      if (!ctx.tags.includes(name)) return { family: 'tags', risk: 'changes-history', mappedAction: null, mappedArgs: [], refusalReason: `"${name}" does not match a known tag.` };
      return { family: 'tags', risk: 'changes-history', mappedAction: 'git.tag.delete', mappedArgs: [name, false] };
    }
    const args = nonFlagArgs(rest);
    if (args.length >= 1 && !args[0].startsWith('-')) {
      const name = args[0];
      const sha = args[1] ?? 'HEAD';
      if (args[1] && !isKnownRef(args[1], ctx)) return { family: 'tags', risk: 'safe', mappedAction: null, mappedArgs: [], refusalReason: `"${args[1]}" does not match a known branch, tag or commit.` };
      return { family: 'tags', risk: 'safe', mappedAction: 'git.tag.create', mappedArgs: [name, sha, null] };
    }
  }
  return null;
}

function matchTagPush(cmd: string, rest: string[]): MatchResult | null {
  if (cmd !== 'push' || rest[0] !== 'origin' || rest.length !== 2) return null;
  const ref = rest[1];
  const name = ref.startsWith('refs/tags/') ? ref.slice('refs/tags/'.length) : ref;
  if (ref === name) return null; // not a tag-shaped push; let matchSync's generic push handle it
  return { family: 'tags', risk: 'touches-remote', mappedAction: 'git.tag.push', mappedArgs: [name] };
}

// ---------------------------------------------------------------------------
// Top-level classification
// ---------------------------------------------------------------------------

function matchGlobalDeny(argv: string[]): string | null {
  for (const token of argv) {
    for (const { re, reason } of DANGEROUS_FLAG_PATTERNS) if (re.test(token)) return reason;
    if (token.startsWith('!')) return 'git aliases starting with "!" are not supported.';
  }
  return null;
}

function matchNamedDenylist(cmd: string, rest: string[]): string | null {
  if (cmd in DENYLISTED_COMMAND_REASONS) return DENYLISTED_COMMAND_REASONS[cmd];
  if (cmd === 'reflog' && rest[0] === 'expire') return 'reflog expire permanently discards recovery history and is never run automatically';
  if (cmd === 'remote' && (rest[0] === 'add' || rest[0] === 'set-url')) return 'remote URL changes are never run automatically';
  if (cmd === 'remote') return 'remote configuration changes are never run automatically';
  return null;
}

function classify(argv: string[], ctx: NlPolicyContext): MatchResult | null {
  if (!argv.length) return null;
  const [cmd, ...rest] = argv;
  return (
    matchInspect(cmd, rest) ??
    matchBranch(cmd, rest, ctx) ??
    matchCommit(cmd, rest, ctx) ??
    matchStash(cmd, rest, ctx) ??
    matchTagPush(cmd, rest) ??
    matchSync(cmd, rest, ctx) ??
    matchIntegrate(cmd, rest, ctx) ??
    matchDiscard(cmd, rest, ctx) ??
    matchTags(cmd, rest, ctx)
  );
}

/** A rough, conservative risk guess for a command the allowlist grammar did not recognize, so an unmatched/denylisted step never shows as "safe". */
function guessUnmatchedRisk(argv: string[]): NlRisk {
  const joined = argv.join(' ');
  if (/--force\b(?!-with-lease)|push/.test(joined)) return 'touches-remote';
  if (/--hard|clean|\brm\b|filter-branch/.test(joined)) return 'discards-work';
  return 'changes-history';
}

function evaluateStep(raw: RawNlStep, index: number, ctx: NlPolicyContext): NlStep {
  const id = `step-${index}`;
  const display = raw.argv.join(' ');
  const base = { id, argv: raw.argv, display, explanation: raw.explanation, preview: null };

  const refuse = (reason: string, risk: NlRisk): NlStep => ({ ...base, risk: higherRisk(raw.risk, risk), executable: false, refusalReason: reason, mappedAction: null, mappedArgs: [] });

  if (!Array.isArray(raw.argv) || raw.argv.some((a) => typeof a !== 'string')) {
    return refuse('The command was not a list of plain text arguments.', 'changes-history');
  }

  for (const token of raw.argv) {
    const meta = firstShellMetachar(token);
    if (meta) return refuse(`The command contains the shell operator "${meta}", which GitGood never runs.`, guessUnmatchedRisk(raw.argv));
  }

  const globalDeny = matchGlobalDeny(raw.argv);
  if (globalDeny) return refuse(globalDeny, guessUnmatchedRisk(raw.argv));

  const argv = stripLeadingGit(raw.argv);
  if (!argv.length) return refuse('The command is empty.', 'changes-history');

  if (argv[0].toLowerCase() === 'gh') return refuse('gh commands are never run from the command palette.', guessUnmatchedRisk(raw.argv));

  const named = matchNamedDenylist(argv[0], argv.slice(1));
  if (named) return refuse(named, guessUnmatchedRisk(argv));

  const match = classify(argv, ctx);
  if (!match) return refuse("This command is not part of GitGood's supported command set for the AI palette.", guessUnmatchedRisk(argv));

  if (ctx.operation !== 'none' && !FAMILIES_DURING_OPERATION.has(match.family)) {
    return refuse(`Only abort, continue, status, diff and log commands run while a ${ctx.operation} is in progress.`, higherRisk(match.risk, 'safe'));
  }

  if (match.refusalReason) return refuse(match.refusalReason, match.risk);

  const risk = higherRisk(raw.risk, match.risk);
  return { ...base, risk, executable: true, refusalReason: null, mappedAction: match.mappedAction, mappedArgs: match.mappedArgs };
}

/**
 * Evaluates a raw model response into a fully-decided plan. When the model
 * asked a clarifying question, any steps it also returned are discarded (the
 * question-and-answer precedence rule). When there are more than MAX_STEPS
 * steps, every step is dropped and `tooManySteps` is set instead of
 * evaluating them (the plan is rejected wholesale, per spec.md's "Too many
 * steps" scenario).
 */
export function evaluatePlan(raw: RawNlPlan, ctx: NlPolicyContext): EvaluatedPlan {
  if (raw.clarifyingQuestion) return { steps: [], clarifyingQuestion: raw.clarifyingQuestion, tooManySteps: false };
  if (raw.steps.length > MAX_STEPS) return { steps: [], clarifyingQuestion: null, tooManySteps: true };
  return { steps: raw.steps.map((s, i) => evaluateStep(s, i, ctx)), clarifyingQuestion: null, tooManySteps: false };
}

export { isKnownRef, isSafeRepoPath };
