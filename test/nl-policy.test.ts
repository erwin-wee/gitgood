import { describe, expect, it } from 'vitest';
import { evaluatePlan, higherRisk, isKnownRef, isSafeRepoPath, MAX_STEPS, stripLeadingGit, type NlPolicyContext, type RawNlStep } from '../src/main/ai/nlPolicy';

const CTX: NlPolicyContext = {
  branches: ['main', 'feature/foo', 'origin/main'],
  tags: ['v1.0.0'],
  statusPaths: ['src/app.ts', 'README.md'],
  stashes: [{ index: 0, sha: 'deadbeef00000000000000000000000000000000' }, { index: 1, sha: 'cafef00d00000000000000000000000000000000' }],
  currentBranch: 'feature/foo',
  detached: false,
  operation: 'none',
};

function step(argv: string[], risk: RawNlStep['risk'] = 'safe', explanation = 'do it'): RawNlStep {
  return { argv, explanation, risk };
}

/** Evaluates a single-step plan and returns that one step. */
function evalOne(argv: string[], risk: RawNlStep['risk'] = 'safe', ctx: NlPolicyContext = CTX) {
  const plan = evaluatePlan({ clarifyingQuestion: null, steps: [step(argv, risk)] }, ctx);
  expect(plan.steps).toHaveLength(1);
  return plan.steps[0];
}

describe('nlPolicy: small helpers', () => {
  it('strips exactly one leading "git" token', () => {
    expect(stripLeadingGit(['git', 'status'])).toEqual(['status']);
    expect(stripLeadingGit(['git.exe', 'status'])).toEqual(['status']);
    expect(stripLeadingGit(['status'])).toEqual(['status']);
    expect(stripLeadingGit(['git', 'git', 'status'])).toEqual(['git', 'status']);
  });

  it('ranks discards-work as the most severe risk', () => {
    expect(higherRisk('safe', 'discards-work')).toBe('discards-work');
    expect(higherRisk('touches-remote', 'changes-history')).toBe('touches-remote');
    expect(higherRisk('discards-work', 'touches-remote')).toBe('discards-work');
    expect(higherRisk('safe', 'safe')).toBe('safe');
  });

  it('recognizes known refs and rejects unsafe paths', () => {
    expect(isKnownRef('main', CTX)).toBe(true);
    expect(isKnownRef('v1.0.0', CTX)).toBe(true);
    expect(isKnownRef('HEAD~2', CTX)).toBe(true);
    expect(isKnownRef('deadbeef', CTX)).toBe(true);
    expect(isKnownRef('no-such-branch', CTX)).toBe(false);
    expect(isSafeRepoPath('src/app.ts')).toBe(true);
    expect(isSafeRepoPath('../../etc/passwd')).toBe(false);
    expect(isSafeRepoPath('/etc/passwd')).toBe(false);
    expect(isSafeRepoPath('-rf')).toBe(false);
  });
});

describe('nlPolicy: positive cases (allowlisted shapes)', () => {
  it('inspect: status/log/show/diff/branch -a/stash list/reflog/rev-parse run read-only via git.tryRun', () => {
    for (const argv of [['git', 'status'], ['log', '--oneline', '-5'], ['show', 'HEAD'], ['diff', '--stat'], ['branch', '-a'], ['stash', 'list'], ['reflog'], ['rev-parse', '--verify', 'main']]) {
      const s = evalOne(argv);
      expect(s.executable).toBe(true);
      expect(s.risk).toBe('safe');
      expect(s.mappedAction).toBe('git.tryRun');
    }
  });

  it('branch: switch/checkout, checkout -b, rename, delete map to their wrappers', () => {
    expect(evalOne(['git', 'checkout', 'main'])).toMatchObject({ executable: true, mappedAction: 'git.checkout', mappedArgs: ['main', 'ask'] });
    expect(evalOne(['switch', 'main'])).toMatchObject({ executable: true, mappedAction: 'git.checkout' });
    expect(evalOne(['checkout', '-b', 'new-feature', 'main'])).toMatchObject({ executable: true, mappedAction: 'git.branch.create', mappedArgs: ['new-feature', 'main', true, 'ask'] });
    expect(evalOne(['branch', '-m', 'feature/foo', 'feature/bar'])).toMatchObject({ executable: true, mappedAction: 'git.branch.rename', mappedArgs: ['feature/foo', 'feature/bar'] });
    expect(evalOne(['branch', '-d', 'feature/foo'])).toMatchObject({ executable: true, mappedAction: 'git.branch.delete', mappedArgs: ['feature/foo', false] });
  });

  it('commit: reset --soft HEAD~1, revert, cherry-pick map to their wrappers', () => {
    expect(evalOne(['reset', '--soft', 'HEAD~1'], 'changes-history')).toMatchObject({ executable: true, mappedAction: 'git.undoCommit', risk: 'changes-history' });
    expect(evalOne(['revert', 'deadbeef'])).toMatchObject({ executable: true, mappedAction: 'git.revert', mappedArgs: ['deadbeef'] });
    expect(evalOne(['cherry-pick', 'deadbeef', 'cafef00d'])).toMatchObject({ executable: true, mappedAction: 'git.cherryPick', mappedArgs: [['deadbeef', 'cafef00d']] });
  });

  it('stash: push/pop/apply/drop map to their wrappers (by index or SHA, never git\'s brace syntax)', () => {
    expect(evalOne(['stash', 'push', '-m', 'wip'])).toMatchObject({ executable: true, mappedAction: 'git.stash.push', mappedArgs: ['wip', false, null] });
    expect(evalOne(['stash', 'pop', '0'])).toMatchObject({ executable: true, mappedAction: 'git.stash.pop', mappedArgs: ['deadbeef00000000000000000000000000000000'] });
    expect(evalOne(['stash', 'apply', 'deadbeef00000000000000000000000000000000'])).toMatchObject({ executable: true, mappedAction: 'git.stash.apply' });
    expect(evalOne(['stash', 'drop', '1'])).toMatchObject({ executable: true, mappedAction: 'git.stash.drop', risk: 'discards-work' });
    // git's own stash@{N} syntax is never accepted: "{"/"}" are always rejected as shell metacharacters.
    expect(evalOne(['stash', 'pop', 'stash@{0}']).executable).toBe(false);
  });

  it('sync: fetch/pull/push and push --force-with-lease map to their wrappers', () => {
    expect(evalOne(['fetch'])).toMatchObject({ executable: true, mappedAction: 'git.fetch', mappedArgs: [null] });
    expect(evalOne(['pull'])).toMatchObject({ executable: true, mappedAction: 'git.pull' });
    expect(evalOne(['push'])).toMatchObject({ executable: true, mappedAction: 'git.push', risk: 'touches-remote' });
    expect(evalOne(['push', '-u', 'origin', 'feature/foo'])).toMatchObject({ executable: true, mappedAction: 'git.push', mappedArgs: [{ force: false, setUpstream: true, remote: 'origin', branch: 'feature/foo', tags: false }] });
    expect(evalOne(['push', '--force-with-lease'])).toMatchObject({ executable: true, mappedAction: 'git.push', mappedArgs: [{ force: true, setUpstream: false, remote: null, branch: null, tags: false }] });
  });

  it('integrate: merge/rebase and their abort/continue map to their wrappers', () => {
    expect(evalOne(['merge', 'main'])).toMatchObject({ executable: true, mappedAction: 'git.merge', mappedArgs: ['main', false] });
    expect(evalOne(['merge', '--abort'])).toMatchObject({ executable: true, mappedAction: 'git.merge.abort', risk: 'safe' });
    expect(evalOne(['rebase', 'main'])).toMatchObject({ executable: true, mappedAction: 'git.rebase', mappedArgs: ['main'] });
    expect(evalOne(['rebase', '--abort'])).toMatchObject({ executable: true, mappedAction: 'git.rebase.abort' });
  });

  it('discard: restore/checkout -- known paths and reset --hard HEAD map to their wrappers', () => {
    expect(evalOne(['restore', 'src/app.ts'])).toMatchObject({ executable: true, mappedAction: 'git.discard', mappedArgs: [['src/app.ts'], true], risk: 'discards-work' });
    expect(evalOne(['checkout', '--', 'README.md'])).toMatchObject({ executable: true, mappedAction: 'git.discard' });
    expect(evalOne(['reset', '--hard', 'HEAD'], 'safe')).toMatchObject({ executable: true, mappedAction: 'git.discardAll', risk: 'discards-work' });
  });

  it('tags: create/delete/push map to their wrappers', () => {
    expect(evalOne(['tag', 'v2.0.0', 'main'])).toMatchObject({ executable: true, mappedAction: 'git.tag.create', mappedArgs: ['v2.0.0', 'main', null] });
    expect(evalOne(['tag', '-d', 'v1.0.0'])).toMatchObject({ executable: true, mappedAction: 'git.tag.delete', mappedArgs: ['v1.0.0', false] });
    expect(evalOne(['push', 'origin', 'refs/tags/v1.0.0'])).toMatchObject({ executable: true, mappedAction: 'git.tag.push', mappedArgs: ['v1.0.0'], risk: 'touches-remote' });
  });
});

describe('nlPolicy: negative cases (denylist and shell-injection)', () => {
  const SHELL_OPERATOR_ARGVS: string[][] = [
    ['status', ';', 'rm', '-rf'],
    ['status', '|', 'sh'],
    ['status', '&', 'sh'],
    ['log', '>', '/tmp/x'],
    ['log', '<', '/tmp/x'],
    ['log', '`whoami`'],
    ['log', '$(whoami)'],
    ['log', '${HOME}'],
    ['log', 'a\nb'],
    ['checkout', 'stash@{0}'],
  ];
  it.each(SHELL_OPERATOR_ARGVS)('rejects a shell metacharacter in %j', (...argv) => {
    const s = evalOne(argv);
    expect(s.executable).toBe(false);
    expect(s.refusalReason).toBeTruthy();
  });

  it('rejects the prompt-injection style argv from the AI brief', () => {
    expect(evalOne(['status', ';', 'rm', '-rf']).executable).toBe(false);
    expect(evalOne(['log', '--output=/etc/passwd']).executable).toBe(false);
    expect(evalOne(['fetch', '--upload-pack=/bin/sh']).executable).toBe(false);
    expect(evalOne(['status', '-c', 'core.sshCommand=ssh -oProxyCommand=x']).executable).toBe(false);
    expect(evalOne(['restore', '../../x']).executable).toBe(false);
    expect(evalOne(['restore', '/etc/passwd']).executable).toBe(false);
  });

  it('rejects push --force without --force-with-lease, with the exact reason', () => {
    const s = evalOne(['push', '--force']);
    expect(s.executable).toBe(false);
    expect(s.refusalReason).toMatch(/force pushes without lease are not run by GitGood/);
  });

  it('never executes gh commands', () => {
    expect(evalOne(['gh', 'pr', 'create']).executable).toBe(false);
  });

  it('never executes explicit never-run maintenance/config/rewrite commands', () => {
    for (const argv of [['reflog', 'expire'], ['gc', '--prune=now'], ['filter-branch', '--tree-filter', 'x'], ['update-ref', 'refs/heads/main', 'deadbeef'], ['config', 'user.name', 'x'], ['remote', 'add', 'origin', 'https://evil'], ['remote', 'set-url', 'origin', 'https://evil'], ['submodule', 'update'], ['rm', '-rf', 'src']]) {
      const s = evalOne(argv);
      expect(s.executable).toBe(false);
    }
  });

  it('never executes -c/--exec/--git-dir/--work-tree/-C options', () => {
    for (const argv of [['status', '-c', 'x=y'], ['log', '--exec=whoami'], ['status', '--git-dir=/tmp/x'], ['status', '--work-tree=/tmp'], ['status', '-C', '/tmp']]) {
      expect(evalOne(argv).executable).toBe(false);
    }
  });

  it('never executes "!" shell alias invocations', () => {
    expect(evalOne(['!rm', '-rf', '/']).executable).toBe(false);
  });

  it('git clean is always copy-only, even with a path argument', () => {
    expect(evalOne(['clean', '-fd']).executable).toBe(false);
    expect(evalOne(['clean', '-fd', 'src/']).executable).toBe(false);
  });

  it('refuses a step whose reference does not exist', () => {
    const s = evalOne(['checkout', 'no-such-branch']);
    expect(s.executable).toBe(false);
    expect(s.refusalReason).toMatch(/no-such-branch/);
  });

  it('refuses a discard step naming a path with no pending changes', () => {
    const s = evalOne(['restore', 'not-in-status.txt']);
    expect(s.executable).toBe(false);
  });

  it('refuses a push when HEAD is detached', () => {
    const s = evalOne(['push'], 'safe', { ...CTX, detached: true, currentBranch: null });
    expect(s.executable).toBe(false);
    expect(s.refusalReason).toMatch(/detached/);
  });

  it('anything unmatched is non-executable, never silently "safe"', () => {
    const s = evalOne(['bisect', 'start']);
    expect(s.executable).toBe(false);
    expect(s.risk).not.toBe('safe');
  });
});

describe('nlPolicy: risk recomputation', () => {
  it('treats a model-understated risk as at least as severe as the policy classification', () => {
    const s = evalOne(['reset', '--hard', 'HEAD'], 'safe');
    expect(s.risk).toBe('discards-work');
  });

  it('keeps the model risk when it is already at least as severe', () => {
    const s = evalOne(['fetch'], 'changes-history');
    expect(s.risk).toBe('changes-history');
  });
});

describe('nlPolicy: in-progress operation restriction', () => {
  const REBASING: NlPolicyContext = { ...CTX, operation: 'rebase' };

  it('allows inspect and integrate (abort/continue) families during a rebase', () => {
    expect(evalOne(['status'], 'safe', REBASING).executable).toBe(true);
    expect(evalOne(['rebase', '--abort'], 'safe', REBASING).executable).toBe(true);
    expect(evalOne(['rebase', '--continue'], 'safe', REBASING).executable).toBe(true);
  });

  it('refuses other families (commit, branch, discard) while a rebase is in progress', () => {
    expect(evalOne(['revert', 'deadbeef'], 'safe', REBASING).executable).toBe(false);
    expect(evalOne(['checkout', 'main'], 'safe', REBASING).executable).toBe(false);
    expect(evalOne(['restore', 'src/app.ts'], 'safe', REBASING).executable).toBe(false);
  });
});

describe('nlPolicy: clarifying question precedence and step cap', () => {
  it('discards any steps returned alongside a clarifying question', () => {
    const plan = evaluatePlan({ clarifyingQuestion: 'Which commit?', steps: [step(['status'])] }, CTX);
    expect(plan.clarifyingQuestion).toBe('Which commit?');
    expect(plan.steps).toEqual([]);
  });

  it('rejects the whole plan when it has more than MAX_STEPS steps', () => {
    const steps = Array.from({ length: MAX_STEPS + 1 }, () => step(['status']));
    const plan = evaluatePlan({ clarifyingQuestion: null, steps }, CTX);
    expect(plan.tooManySteps).toBe(true);
    expect(plan.steps).toEqual([]);
  });

  it('accepts a plan with exactly MAX_STEPS steps', () => {
    const steps = Array.from({ length: MAX_STEPS }, () => step(['status']));
    const plan = evaluatePlan({ clarifyingQuestion: null, steps }, CTX);
    expect(plan.tooManySteps).toBe(false);
    expect(plan.steps).toHaveLength(MAX_STEPS);
  });
});
