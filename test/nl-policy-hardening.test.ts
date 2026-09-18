import { describe, expect, it } from 'vitest';
import { evaluatePlan, hasUnsafePathToken } from '../src/main/ai/nlPolicy';

const ctx = { branches: ['main', 'feat', 'origin/main'], tags: ['v1.0'], statusPaths: ['src/a.ts', 'a b.txt'], stashes: [{ index: 0, sha: 'abc1234abc1234abc1234abc1234abc1234abc12' }], currentBranch: 'main', detached: false, operation: 'none' as const };
const plan = (argv: string[]) => evaluatePlan({ clarifyingQuestion: null, steps: [{ argv, explanation: 'x', risk: 'safe' }] }, ctx).steps[0];

describe('nlPolicy hardening: inspect arguments, dangerous flags and denylist', () => {
  const cases: [string[], boolean][] = [
    [['status', '--porcelain'], true],
    [['log', '--oneline', 'main..feat'], true],
    [['diff', 'HEAD~1', '--', 'a b.txt'], true],
    [['show', 'HEAD:src/a.ts'], true],
    [['diff', '--no-index', '/etc/passwd', '/etc/hostname'], false],
    [['diff', '--ext-diff'], false],
    [['log', '--textconv'], false],
    [['log', '-p', '--', '../../etc'], false],
    [['show', 'HEAD:../../x'], false],
    [['log', '--output=/tmp/x'], false],
    [['log', '-O/etc/passwd'], false],
    [['status;', 'rm', '-rf'], false],
    [['-c', 'core.sshCommand=evil', 'fetch'], false],
    [['fetch', '--upload-pack=evil'], false],
    [['clean', '-fdx'], false],
    [['push', '--force', 'origin', 'main'], false],
    [['push', '--force-with-lease', 'origin', 'main'], true],
    [['reset', '--hard', 'HEAD'], true],
    [['reset', '--hard', 'origin/main'], false],
    [['checkout', '-b', 'newb', 'main'], true],
    [['branch', '-D', 'main'], false],
    [['stash', 'pop', '0'], true],
    [['config', 'user.name', 'x'], false],
    [['gh', 'pr', 'merge'], false],
    [['diff', 'C:\\Windows\\x'], false],
    [['log', '--', 'src/a.ts'], true],
  ];
  for (const [argv, ok] of cases) {
    it(argv.join(' '), () => {
      const step = plan(argv);
      expect(step.executable, JSON.stringify(step)).toBe(ok);
    });
  }
  it('range operator is not a path', () => {
    expect(hasUnsafePathToken('main..feat')).toBe(false);
    expect(hasUnsafePathToken('HEAD~1')).toBe(false);
    expect(hasUnsafePathToken('..')).toBe(true);
    expect(hasUnsafePathToken('a/../b')).toBe(true);
  });
});

describe('nlPolicy hardening: "git branch" only lists', () => {
  // `branch` maps to the tryRun sentinel, whose readOnly flag only unsets
  // GIT_OPTIONAL_LOCKS, and the palette runs "safe" steps with no confirmation
  // dialog -- so any branch form that can write a ref must never be "safe".
  for (const argv of [
    ['branch', '-f', 'main', 'HEAD~5'],
    ['branch', '--force', 'main', 'HEAD~5'],
    ['branch', '--set-upstream-to=origin/main', 'main'],
    ['branch', '-u', 'origin/main'],
    ['branch', 'newbranch', 'HEAD~3'],
    ['branch', '--edit-description'],
    // `--abbrev`/`--color`/`--column` take an optional value, so git accepts it
    // only as `--flag=value` and reads a following token as a branch to create.
    ['branch', '--color', 'newbranch'],
    ['branch', '--column', 'newbranch'],
    ['branch', '--abbrev', 'newbranch'],
  ]) {
    it(`never runs unconfirmed: ${argv.join(' ')}`, () => {
      const step = plan(argv);
      expect(step.risk === 'safe' && step.executable, JSON.stringify(step)).toBe(false);
    });
  }

  for (const argv of [
    ['branch'],
    ['branch', '-a'],
    ['branch', '-r'],
    ['branch', '-vv'],
    ['branch', '--list', 'feat/*'],
    ['branch', '--contains', 'HEAD'],
    ['branch', '--merged', 'main'],
    ['branch', '--show-current'],
    ['branch', '--sort=-committerdate', '-a'],
  ]) {
    it(`still lists: ${argv.join(' ')}`, () => {
      const step = plan(argv);
      expect({ risk: step.risk, action: step.mappedAction }, JSON.stringify(step)).toEqual({ risk: 'safe', action: 'git.tryRun' });
    });
  }
});

describe('nlPolicy hardening: the command that runs matches the one displayed', () => {
  it('refuses a push flag git.push cannot reproduce instead of dropping it', () => {
    const step = plan(['push', 'origin', '--delete', 'main']);
    expect(step.mappedAction, JSON.stringify(step)).toBe(null);
  });

  it('refuses a refspec that could delete or retarget a remote branch', () => {
    const step = plan(['push', 'origin', ':main']);
    expect(step.mappedAction, JSON.stringify(step)).toBe(null);
  });

  it('honours --tags rather than pushing no tags', () => {
    const step = plan(['push', '--tags']);
    expect(step.mappedAction).toBe('git.push');
    expect((step.mappedArgs[0] as { tags: boolean }).tags).toBe(true);
  });

  it('still maps an ordinary upstream push', () => {
    const step = plan(['push', '-u', 'origin', 'main']);
    expect(step.mappedAction).toBe('git.push');
    expect(step.mappedArgs[0]).toMatchObject({ setUpstream: true, remote: 'origin', branch: 'main', tags: false });
  });

  it('unstages for "restore --staged" instead of discarding the working tree', () => {
    const step = plan(['restore', '--staged', 'src/a.ts']);
    expect(step.mappedAction, JSON.stringify(step)).toBe('git.unstage');
    expect(step.risk).toBe('safe');
  });

  it('still discards for a plain "restore <path>"', () => {
    const step = plan(['restore', 'src/a.ts']);
    expect(step.mappedAction).toBe('git.discard');
    expect(step.risk).toBe('discards-work');
  });

  it('refuses "restore --source", which restores from another commit', () => {
    const step = plan(['restore', '--source=HEAD~2', 'src/a.ts']);
    expect(step.mappedAction, JSON.stringify(step)).toBe(null);
  });
});
