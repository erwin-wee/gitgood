import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildTextDiff } from '../src/main/git/diff';
import { parseUnifiedDiff } from '../src/shared/diff/parse';
import { reconstructOldLines } from '../src/shared/diff/old-lines';

function git(repo: string, args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
}

function splitContent(content: string): string[] {
  const lines = content.split(/\r?\n/);
  if (lines.at(-1) === '' && content.endsWith('\n')) lines.pop();
  return lines;
}

function realDiff(oldContent: string, newContent: string, rename = false) {
  const repo = mkdtempSync(join(tmpdir(), 'gitgood-diff-'));
  try {
    git(repo, ['init', '-q']);
    git(repo, ['config', 'user.email', 'test@example.com']);
    git(repo, ['config', 'user.name', 'Test']);
    writeFileSync(join(repo, 'old.txt'), oldContent);
    git(repo, ['add', '.']);
    git(repo, ['commit', '-qm', 'old']);
    if (rename) {
      git(repo, ['mv', 'old.txt', 'new.txt']);
      writeFileSync(join(repo, 'new.txt'), newContent);
    } else writeFileSync(join(repo, 'old.txt'), newContent);
    const parsed = parseUnifiedDiff(git(repo, ['diff', '--no-color', '--unified=3', '-M']));
    return buildTextDiff(parsed, rename ? 'new.txt' : 'old.txt', oldContent, newContent);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

describe('old-side diff reconstruction', () => {
  it('matches real old content for CRLF, no-EOL, deletion-at-start, multi-hunk, and rename diffs', () => {
    const multiOld = Array.from({ length: 20 }, (_, i) => `line-${i + 1}`).join('\n') + '\n';
    const multiNew = multiOld.replace('line-1', 'changed-1').replace('line-20', 'changed-20');
    const fixtures: Array<[string, string, boolean]> = [
      ['one\r\ntwo\r\nthree\r\n', 'one\r\nTWO\r\nthree\r\n', false],
      ['one\ntwo\nthree', 'one\ntwo changed\nthree', false],
      ['one\ntwo\n', 'zero\none\ntwo\n', false],
      ['first\nkeep\nlast\n', 'keep\nlast\n', false],
      [multiOld, multiNew, false],
      ['same\n', 'same changed\n', true],
    ];
    for (const [oldContent, newContent, rename] of fixtures) {
      const diff = realDiff(oldContent, newContent, rename);
      expect(diff.kind).toBe('text');
      if (diff.kind !== 'text' || diff.newContent === null) throw new Error('expected modified text diff');
      expect(reconstructOldLines(splitContent(diff.newContent), diff.hunks)).toEqual(splitContent(oldContent));
    }
  });

  it('keeps a pure deletion on the old-content fallback', () => {
    const repo = mkdtempSync(join(tmpdir(), 'gitgood-delete-'));
    try {
      git(repo, ['init', '-q']);
      git(repo, ['config', 'user.email', 'test@example.com']);
      git(repo, ['config', 'user.name', 'Test']);
      const oldContent = 'gone\n';
      writeFileSync(join(repo, 'gone.txt'), oldContent);
      git(repo, ['add', '.']);
      git(repo, ['commit', '-qm', 'old']);
      rmSync(join(repo, 'gone.txt'));
      const parsed = parseUnifiedDiff(git(repo, ['diff', '--no-color', '--unified=3']));
      const diff = buildTextDiff(parsed, 'gone.txt', oldContent, null);
      expect(diff.kind).toBe('text');
      if (diff.kind !== 'text') throw new Error('expected deleted text diff');
      expect(diff.oldContent).toBe(oldContent);
      expect(reconstructOldLines(null, diff.hunks)).toBeNull();
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
