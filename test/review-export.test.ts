import { describe, expect, it } from 'vitest';
import type { ReviewFinding, ReviewRun } from '../src/shared/types';
import { buildExportJson, exportFileNames, renderExportMarkdown, rerunCommand, rerunUrl, rerunUseful, serializeExport, sortFindings } from '../src/main/ai/review-export';

const finding = (over: Partial<ReviewFinding> = {}): ReviewFinding => ({
  id: 'f1',
  path: 'src/app.ts',
  line: 3,
  endLine: null,
  severity: 'warning',
  category: 'readability',
  title: 'Leftover debug log',
  detail: 'Remove the console.log before committing.',
  suggestion: null,
  confidence: 'high',
  dismissed: false,
  ...over,
});

function run(over: Partial<ReviewRun> = {}): ReviewRun {
  return {
    id: 'run-2',
    repoPath: '/home/dev/my app',
    target: { kind: 'worktree', paths: ['src/app.ts', 'src/util.ts'], partialPaths: [], indexSha: 'abc' },
    startedAt: '2026-09-18T10:00:00.000Z',
    finishedAt: '2026-09-18T10:00:05.000Z',
    model: 'claude-opus-5',
    provider: 'claude-cli',
    effort: 'high',
    strictness: 'strict',
    summary: '3 findings across 2 files.',
    verdict: 'request-changes',
    findings: [
      finding({ id: 'nit', path: 'src/app.ts', line: 3, severity: 'nit', title: 'Nit first in input' }),
      finding({ id: 'blk', path: 'src/app.ts', line: 40, severity: 'blocker', category: 'security', title: 'Hard-coded token' }),
      finding({ id: 'warn', path: 'src\\util.ts', line: 2, endLine: 4, severity: 'warning', title: 'Use a constant', suggestion: 'const b = 20;\r\nconst c = 30;\r\n' }),
      finding({ id: 'gone', path: 'src/util.ts', line: 9, severity: 'blocker', title: 'Dismissed one', dismissed: true }),
    ],
    files: [
      { file: { path: 'src/app.ts', oldPath: null, status: 'modified', additions: 2, deletions: 0, binary: false, lfs: false }, status: 'reviewed', reason: null, hash: 'h1' },
      { file: { path: 'src/util.ts', oldPath: null, status: 'modified', additions: 1, deletions: 1, binary: false, lfs: false }, status: 'reviewed', reason: null, hash: 'h2' },
      { file: { path: 'package-lock.json', oldPath: null, status: 'modified', additions: 1, deletions: 1, binary: false, lfs: false }, status: 'skipped', reason: 'lockfile', hash: null },
    ],
    droppedInvalid: 1,
    error: null,
    cancelled: false,
    ownPullRequest: false,
    commitMessageMatches: null,
    commitMessageNote: '',
    ...over,
  };
}

describe('sortFindings', () => {
  it('orders blocker, warning, nit, then path, then line', () => {
    expect(sortFindings(run().findings).map((f) => f.id)).toEqual(['blk', 'gone', 'warn', 'nit']);
  });
});

describe('buildExportJson', () => {
  it('carries every finding including dismissed ones, with forward-slash paths and a previous run id', () => {
    const doc = buildExportJson(run(), 'run-1', 'linux');
    expect(doc.version).toBe(1);
    expect(doc.runId).toBe('run-2');
    expect(doc.previousRunId).toBe('run-1');
    expect(doc.repoPath).toBe('/home/dev/my app');
    expect(doc.findings.map((f) => f.id)).toEqual(['blk', 'gone', 'warn', 'nit']);
    expect(doc.findings.find((f) => f.id === 'warn')?.path).toBe('src/util.ts');
    expect(doc.findings.find((f) => f.id === 'gone')?.dismissed).toBe(true);
    expect(doc.files).toEqual([
      { path: 'src/app.ts', status: 'reviewed', reason: null },
      { path: 'src/util.ts', status: 'reviewed', reason: null },
      { path: 'package-lock.json', status: 'skipped', reason: 'lockfile' },
    ]);
    expect(doc.droppedInvalid).toBe(1);
    expect(doc.rerun?.url).toBe('gitgood://review/rerun?repo=%2Fhome%2Fdev%2Fmy%20app');
    expect(doc.rerun?.command).toBe("xdg-open 'gitgood://review/rerun?repo=%2Fhome%2Fdev%2Fmy%20app'");
  });

  it('keeps a Windows repository path native while finding paths use forward slashes', () => {
    const doc = buildExportJson(run({ repoPath: 'C:\\work\\app' }), null, 'win32');
    expect(doc.repoPath).toBe('C:\\work\\app');
    expect(doc.findings.every((f) => !f.path.includes('\\'))).toBe(true);
    expect(doc.rerun?.url).toBe('gitgood://review/rerun?repo=C%3A%5Cwork%5Capp');
    expect(doc.rerun?.command).toBe('Start-Process "gitgood://review/rerun?repo=C%3A%5Cwork%5Capp"');
  });

  it('never contains fields that were not on the persisted run', () => {
    const doc = buildExportJson(run(), null, 'linux');
    const text = serializeExport(doc);
    expect(text).not.toMatch(/apiKey|ANTHROPIC_API_KEY|hasApiKey|claudeCliPath/);
    expect(Object.keys(doc).sort()).toEqual(['cancelled', 'droppedInvalid', 'effort', 'error', 'files', 'findings', 'finishedAt', 'model', 'previousRunId', 'provider', 'repoPath', 'rerun', 'runId', 'startedAt', 'strictness', 'summary', 'target', 'verdict', 'version']);
  });
});

describe('serializeExport', () => {
  it('pretty prints with two spaces so a grep for "dismissed": false counts live findings', () => {
    const text = serializeExport(buildExportJson(run(), null, 'linux'));
    expect(text.match(/^\s*"dismissed": false,?$/gm)).toHaveLength(3);
    expect(text.match(/^\s*"dismissed": true,?$/gm)).toHaveLength(1);
    expect(text.endsWith('}\n')).toBe(true);
    expect(JSON.parse(text).findings[2].suggestion).toBe('const b = 20;\r\nconst c = 30;\r\n');
  });
});

describe('rerun availability', () => {
  it('offers a re-review only for the pre-commit review, which is the only one that reads the working tree', () => {
    expect(rerunUseful({ kind: 'worktree', paths: [], partialPaths: [], indexSha: '' })).toBe(true);
    expect(rerunUseful({ kind: 'pr', number: 1, headSha: 'a', baseSha: 'b', title: 't', url: 'u' })).toBe(false);
    expect(rerunUseful({ kind: 'branch', base: 'main', head: 'dev', headSha: 'a', baseSha: 'b' })).toBe(false);
  });

  it('sets rerun to null and tells the agent to stop for a pull request run', () => {
    const pr = run({ target: { kind: 'pr', number: 7, headSha: 'aaaaaaaaaaaa', baseSha: 'bbbbbbbbbbbb', title: 'Add thing', url: 'https://x/7' } });
    expect(buildExportJson(pr, null, 'linux').rerun).toBeNull();
    const md = renderExportMarkdown(pr, null, 'linux');
    expect(md).toContain('Do not ask GitGood to re-review');
    expect(md).toContain('report the same findings');
    expect(md).toContain('telling the user to commit those changes in GitGood and press Re-review');
    expect(md).not.toContain('xdg-open');
    expect(md).toContain('Pull request #7');
  });
});

describe('renderExportMarkdown', () => {
  const md = renderExportMarkdown(run(), 'run-1', 'linux');

  it('opens with the agent instruction block', () => {
    const instructions = md.slice(md.indexOf('## Instructions'), md.indexOf('## Findings'));
    expect(instructions).toContain('severity order');
    expect(instructions).toContain('one file at a time');
    expect(instructions).toContain('trust each finding\'s title and detail over its line number');
    expect(instructions).toContain('Do not commit');
    expect(instructions).toContain("xdg-open 'gitgood://review/rerun?repo=%2Fhome%2Fdev%2Fmy%20app'");
    expect(instructions).toContain('re-read `latest.json`');
    expect(md).toContain('supersedes `run-1`');
  });

  it('groups by file, blockers before nits, and omits dismissed findings', () => {
    const findings = md.slice(md.indexOf('## Findings'));
    expect(findings).toContain('## Findings (3: 1 blocker, 1 warning, 1 nit)');
    expect(findings.indexOf('### src/app.ts')).toBeLessThan(findings.indexOf('### src/util.ts'));
    expect(findings.indexOf('[blocker] Hard-coded token')).toBeLessThan(findings.indexOf('[nit] Nit first in input'));
    expect(findings).not.toContain('Dismissed one');
    expect(findings).toContain('L2-L4');
    expect(findings).toContain('id `blk`');
    expect(findings).toContain('_1 model finding was dropped by validation');
  });

  it('preserves CRLF inside the suggestion fence', () => {
    expect(md).toContain('  const b = 20;\r\n  const c = 30;\r\n');
    expect(md).toContain('  ```\n  const b = 20;');
  });

  it('uses a longer fence when the suggestion contains backticks', () => {
    const text = renderExportMarkdown(run({ findings: [finding({ suggestion: 'const s = ```x```;' })] }), null, 'linux');
    expect(text).toContain('  ````\n  const s = ```x```;\n  ````');
  });

  it('shows both Windows commands and says when there is nothing to fix', () => {
    const win = renderExportMarkdown(run({ repoPath: 'C:\\work\\app', findings: [] }), null, 'win32');
    expect(win).toContain('Start-Process "gitgood://review/rerun?repo=C%3A%5Cwork%5Capp"');
    expect(win).toContain('start "" "gitgood://review/rerun?repo=C%3A%5Cwork%5Capp"');
    expect(win).toContain('No open findings. Nothing to fix.');
    expect(renderExportMarkdown(run({ findings: [], error: 'boom' }), null, 'darwin')).toContain('The review failed: boom');
    expect(rerunCommand('/r', 'darwin')).toBe(`open '${rerunUrl('/r')}'`);
  });
});

describe('exportFileNames', () => {
  it('sanitises the run id and names the latest copies', () => {
    expect(exportFileNames('run 1/x')).toEqual({ json: 'runs/run_1_x.json', md: 'runs/run_1_x.md', latestJson: 'latest.json', latestMd: 'latest.md' });
  });
});
