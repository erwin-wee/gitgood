import { describe, expect, it } from 'vitest';
import { buildResolvePrompt } from '../src/main/ai/prompts';
import { parseConflicts } from '../src/shared/diff/conflicts';

const CONFLICT_TEXT = ['function f() {', '<<<<<<< HEAD', '  return 1;', '=======', '  return 2;', '>>>>>>> feature', '}', ''].join('\n');

function baseInput() {
  const parsed = parseConflicts(CONFLICT_TEXT);
  return {
    filePath: 'a.ts',
    language: 'typescript',
    operation: { kind: 'merge' as const, headName: null, onto: null, ontoName: null, current: null, total: null, targetSha: null, targetName: 'feature', message: null },
    currentBranch: 'main',
    oursLabel: parsed.oursLabel,
    theirsLabel: parsed.theirsLabel,
    oursCommits: [],
    theirsCommits: [],
    lines: parsed.lines,
    blocks: parsed.blocks,
    hasBase: false,
  };
}

describe('buildResolvePrompt', () => {
  it('includes worked examples on a guided run', () => {
    const prompt = buildResolvePrompt({
      ...baseInput(),
      examples: [{ path: 'other.ts', original: '<<<<<<< HEAD\nx\n=======\ny\n>>>>>>> feature', resolved: 'x + y' }],
    });
    expect(prompt).toContain('already resolved');
    expect(prompt).toContain('other.ts');
    expect(prompt).toContain('x + y');
  });

  it('omits the examples section when there are none', () => {
    const prompt = buildResolvePrompt(baseInput());
    expect(prompt).not.toContain('already resolved');
  });

  it('includes the failing check command and output tail on a retry', () => {
    const prompt = buildResolvePrompt({ ...baseInput(), checkOutput: { command: 'npm run typecheck', tail: 'error TS2322: boom' } });
    expect(prompt).toContain('check command failed');
    expect(prompt).toContain('npm run typecheck');
    expect(prompt).toContain('error TS2322: boom');
  });

  it('omits the check section when there is no retry', () => {
    const prompt = buildResolvePrompt(baseInput());
    expect(prompt).not.toContain('check command failed');
  });
});
