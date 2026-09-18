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
