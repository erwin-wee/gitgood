import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ReviewRun } from '../src/shared/types';
import { buildExportJson, serializeExport } from '../src/main/ai/review-export';
import { hasGitSync } from './helpers/repo';

const ROOT = resolve(__dirname, '..');
const PLUGIN = join(ROOT, 'plugin');

async function json(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
}

describe('agent plugin folder', () => {
  it('keeps the session-start hook LF-only, because sh fails on a CR', async () => {
    // .gitattributes pins *.sh to eol=lf so a Windows checkout does not break the hook.
    expect(await readFile(join(PLUGIN, 'hooks', 'session-start.sh'), 'utf8')).not.toContain('\r');
    expect(await readFile(join(ROOT, '.gitattributes'), 'utf8')).toMatch(/^\*\.sh text eol=lf$/m);
  });

  it('has manifests for Claude Code, Codex and omp that agree on the name and version', async () => {
    const claude = await json(join(PLUGIN, '.claude-plugin', 'plugin.json'));
    const codex = await json(join(PLUGIN, 'plugin.json'));
    const omp = await json(join(PLUGIN, 'package.json'));
    for (const m of [claude, codex, omp]) {
      expect(m.name).toBe('gitgood-review');
      expect(m.version).toBe('0.1.0');
      expect(String(m.description)).toContain('GitGood');
    }
    expect(codex.$schema).toBe('https://agent-plugins.org/schemas/1.0.0/plugin.schema.json');
    const marketplace = await json(join(ROOT, '.claude-plugin', 'marketplace.json'));
    expect((marketplace.plugins as { name: string; source: string }[])[0]).toMatchObject({ name: 'gitgood-review', source: './plugin' });
  });

  it('ships a skill whose frontmatter names review findings from GitGood as the trigger', async () => {
    // Read through a line-ending normalisation: a Windows checkout with
    // core.autocrlf on hands back CRLF, which the anchors below would not match.
    const skill = (await readFile(join(PLUGIN, 'skills', 'gitgood-review', 'SKILL.md'), 'utf8')).replace(/\r\n/g, '\n');
    const fm = /^---\n([\s\S]*?)\n---/.exec(skill);
    expect(fm).not.toBeNull();
    expect(fm![1]).toMatch(/^name: gitgood-review$/m);
    expect(fm![1]).toMatch(/^description: .*GitGood.*/m);
    expect(fm![1]).toMatch(/^description: .*review findings/m);
    for (const phrase of ['one file at a time', 'trust the finding\'s `title` and `detail` over its `line`', 'Do not commit', 'rerun.command', 'Re-read `latest.json`', 'compare by `path` and `title`']) expect(skill).toContain(phrase);
    const command = (await readFile(join(PLUGIN, 'commands', 'gitgood-review.md'), 'utf8')).replace(/\r\n/g, '\n');
    expect(command).toContain('gitgood-review');
  });

  it('wires the session-start shell script for Claude Code and Codex and ships the omp factory', async () => {
    const hooks = await json(join(PLUGIN, 'hooks', 'hooks.json'));
    const text = JSON.stringify(hooks);
    expect(text).toContain('SessionStart');
    expect(text).toContain('hooks/session-start.sh');
    expect(text).toContain('CLAUDE_PLUGIN_ROOT');
    const omp = (await readFile(join(PLUGIN, 'hooks', 'pre', 'session-start.ts'), 'utf8')).replace(/\r\n/g, '\n');
    expect(omp).toContain('export default function');
    expect(omp).toContain("pi.on('before_agent_start'");
  });
});

function run(repoPath: string): ReviewRun {
  return {
    id: 'run-1', repoPath, target: { kind: 'worktree', paths: ['a.ts'], partialPaths: [], indexSha: '' }, startedAt: '2026-09-18T10:00:00.000Z', finishedAt: '2026-09-18T10:00:01.000Z', model: 'm', provider: 'claude-cli', effort: 'high', strictness: 'strict', summary: '', verdict: null,
    findings: [
      { id: 'a', path: 'a.ts', line: 1, endLine: null, severity: 'blocker', category: 'bug', title: 'One', detail: 'd', suggestion: null, confidence: 'high', dismissed: false },
      { id: 'b', path: 'a.ts', line: 2, endLine: null, severity: 'nit', category: 'style', title: 'Two', detail: 'd', suggestion: null, confidence: 'low', dismissed: false },
      { id: 'c', path: 'a.ts', line: 3, endLine: null, severity: 'nit', category: 'style', title: 'Three', detail: 'd', suggestion: null, confidence: 'low', dismissed: false },
      { id: 'd', path: 'a.ts', line: 4, endLine: null, severity: 'warning', category: 'docs', title: 'Gone', detail: 'd', suggestion: null, confidence: 'high', dismissed: true },
    ],
    files: [], droppedInvalid: 0, error: null, cancelled: false, ownPullRequest: false, commitMessageMatches: null, commitMessageNote: '',
  };
}

const isWindows = process.platform === 'win32';

describe.skipIf(!hasGitSync() || isWindows)('session-start.sh', () => {
  const script = join(PLUGIN, 'hooks', 'session-start.sh');

  async function repoWithExport(withExport: boolean): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'gg-hook-'));
    execFileSync('git', ['init', '-q', root]);
    if (withExport) {
      const dir = join(root, '.git', 'gitgood', 'review');
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'latest.json'), serializeExport(buildExportJson(run(root), null, 'linux')), 'utf8');
    }
    return root;
  }

  /** A PATH holding only git and grep, so `command -v node` fails and the grep fallback runs. */
  async function pathWithoutNode(): Promise<string> {
    const bin = await mkdtemp(join(tmpdir(), 'gg-hook-bin-'));
    for (const tool of ['git', 'grep']) {
      const real = execFileSync('sh', ['-c', `command -v ${tool}`]).toString('utf8').trim();
      await symlink(real, join(bin, tool));
    }
    return bin;
  }

  // Resolved once with the normal PATH so the trimmed-PATH case still finds the shell itself.
  const SH = execFileSync('sh', ['-c', 'command -v sh']).toString('utf8').trim();
  const sh = (cwd: string, env: NodeJS.ProcessEnv = process.env) => execFileSync(SH, [script], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] }).toString('utf8');

  it('prints one line with the live finding count when an export exists', async () => {
    const out = sh(await repoWithExport(true));
    expect(out.trim().split('\n')).toHaveLength(1);
    expect(out).toContain('GitGood has 3 open AI review findings');
    expect(out).toContain('/gitgood-review');
  });

  it('prints nothing and exits 0 without an export, and outside a repository', async () => {
    expect(sh(await repoWithExport(false))).toBe('');
    expect(sh(await mkdtemp(join(tmpdir(), 'gg-hook-norepo-')))).toBe('');
  });

  it('falls back to grep when node is not on PATH', async () => {
    const repo = await repoWithExport(true);
    const bin = await pathWithoutNode();
    const out = sh(repo, { ...process.env, PATH: bin });
    expect(out).toContain('GitGood has 3 open AI review findings');
  });
});
