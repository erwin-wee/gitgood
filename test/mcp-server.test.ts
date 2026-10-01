import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ReviewRun } from '../src/shared/types';
import { buildExportJson, serializeExport } from '../src/main/ai/review-export';
import { handleMessage, PROTOCOL_VERSIONS, TOOLS, type McpDeps } from '../src/mcp/server';
import { hasGitSync } from './helpers/repo';

function run(repoPath: string, kind: 'worktree' | 'branch' = 'worktree'): ReviewRun {
  return {
    id: 'run-1', repoPath, target: kind === 'worktree' ? { kind: 'worktree', paths: ['a.ts'], partialPaths: [], indexSha: '' } : { kind: 'branch', base: 'main', head: 'feat', baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40) }, startedAt: '2026-09-18T10:00:00.000Z', finishedAt: '2026-09-18T10:00:01.000Z', model: 'm', provider: 'claude-cli', effort: 'high', strictness: 'strict', summary: 'Two things to fix', verdict: null,
    findings: [
      { id: 'a', path: 'src/a.ts', line: 7, endLine: 9, severity: 'blocker', category: 'bug', title: 'Off by one', detail: 'Loop skips the last item.', suggestion: 'for (const x of xs) {}', confidence: 'high', dismissed: false },
      { id: 'b', path: 'src/a.ts', line: 2, endLine: null, severity: 'nit', category: 'style', title: 'Naming', detail: 'Rename it.', suggestion: null, confidence: 'low', dismissed: false },
      { id: 'd', path: 'src/b.ts', line: 4, endLine: null, severity: 'warning', category: 'docs', title: 'Dismissed', detail: 'x', suggestion: null, confidence: 'high', dismissed: true },
    ],
    files: [], droppedInvalid: 0, error: null, cancelled: false, ownPullRequest: false, commitMessageMatches: null, commitMessageNote: '',
  };
}

const rpc = (method: string, params?: unknown, id: number | string = 1) => ({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) });

interface Reply {
  jsonrpc: string;
  id: unknown;
  result?: { protocolVersion?: string; tools?: { name: string; inputSchema: { required: string[] } }[]; content?: { text: string }[]; isError?: boolean; capabilities?: unknown };
  error?: { code: number; message: string };
}
const call = async (msg: unknown, deps: McpDeps) => (await handleMessage(msg, deps)) as Reply;

function recorder(overrides: Partial<McpDeps> = {}): McpDeps & { urls: string[]; dirs: string[] } {
  const urls: string[] = [];
  const dirs: string[] = [];
  return { urls, dirs, openUrl: async (u) => void urls.push(u), launchApp: async (d) => void dirs.push(d), ...overrides };
}

describe('MCP protocol', () => {
  const deps = recorder();

  it('answers initialize with the requested version when supported and the newest otherwise', async () => {
    for (const v of PROTOCOL_VERSIONS) expect((await call(rpc('initialize', { protocolVersion: v }), deps)).result?.protocolVersion).toBe(v);
    for (const params of [{ protocolVersion: '1999-01-01' }, {}, undefined]) expect((await call(rpc('initialize', params), deps)).result?.protocolVersion).toBe(PROTOCOL_VERSIONS[0]);
    const res = await call(rpc('initialize', { protocolVersion: '2025-06-18' }, 'abc'), deps);
    expect(res).toMatchObject({ jsonrpc: '2.0', id: 'abc', result: { capabilities: { tools: {} }, serverInfo: { name: 'gitgood' } } });
  });

  it('sends nothing for notifications, including notifications/initialized', async () => {
    expect(await handleMessage({ jsonrpc: '2.0', method: 'notifications/initialized' }, deps)).toBeNull();
    expect(await handleMessage({ jsonrpc: '2.0', method: 'whatever/unknown' }, deps)).toBeNull();
  });

  it('answers ping and lists the three tools with required-argument schemas', async () => {
    expect((await call(rpc('ping'), deps)).result).toEqual({});
    const tools = (await call(rpc('tools/list'), deps)).result!.tools!;
    expect(tools.map((t) => t.name)).toEqual(['gitgood_latest_review', 'gitgood_request_rereview', 'gitgood_open_repository']);
    expect(tools.map((t) => t.inputSchema.required)).toEqual([['repoPath'], ['repoPath'], ['path']]);
    expect(tools).toEqual(TOOLS);
  });

  it('reports protocol errors with JSON-RPC codes', async () => {
    expect((await call(rpc('nope'), deps)).error?.code).toBe(-32601);
    expect((await call(rpc('tools/call', { name: 'nope' }), deps)).error?.code).toBe(-32602);
    expect((await call('garbage', deps)).error?.code).toBe(-32600);
    expect((await call({ jsonrpc: '1.0', id: 1, method: 'ping' }, deps)).error?.code).toBe(-32600);
    expect((await call([rpc('ping')], deps)).error?.code).toBe(-32600);
  });
});

describe.skipIf(!hasGitSync())('MCP tools against a repository', () => {
  async function repoWithExport(opts: { kind?: 'worktree' | 'branch'; raw?: string } = {}) {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'gg-mcp-')));
    execFileSync('git', ['init', '-q', '-b', 'main', root]);
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@e', 'commit', '-q', '--allow-empty', '-m', 'init'], { cwd: root });
    const dir = join(root, '.git', 'gitgood', 'review');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'latest.json'), opts.raw ?? serializeExport(buildExportJson(run(root, opts.kind), null, 'linux', 'tok 1&2')), 'utf8');
    return root;
  }
  const tool = (name: string, args: unknown, deps: McpDeps) => call(rpc('tools/call', { name, arguments: args }), deps);
  const text = (r: Reply) => r.result!.content![0].text;

  it('latest_review returns open findings with file, line, severity, message, suggestion and the rerun link', async () => {
    const root = await repoWithExport();
    const r = await tool('gitgood_latest_review', { repoPath: root }, recorder());
    expect(r.result?.isError).toBeUndefined();
    const out = JSON.parse(text(r));
    expect(out).toMatchObject({ runId: 'run-1', summary: 'Two things to fix', dismissedCount: 1 });
    expect(out.findings).toEqual([
      { file: 'src/a.ts', line: 7, endLine: 9, severity: 'blocker', category: 'bug', title: 'Off by one', message: 'Loop skips the last item.', suggestion: 'for (const x of xs) {}', confidence: 'high' },
      { file: 'src/a.ts', line: 2, endLine: null, severity: 'nit', category: 'style', title: 'Naming', message: 'Rename it.', suggestion: null, confidence: 'low' },
    ]);
    expect(out.rerun.url).toBe(`gitgood://review/rerun?repo=${encodeURIComponent(root)}&token=${encodeURIComponent('tok 1&2')}`);
  });

  it('finds the export from a subfolder and uses the linked worktree\'s own git directory', async () => {
    const root = await repoWithExport();
    await mkdir(join(root, 'sub'));
    expect(JSON.parse(text(await tool('gitgood_latest_review', { repoPath: join(root, 'sub') }, recorder()))).runId).toBe('run-1');

    const wt = join(root, '..', `${root.split(/[\\/]/).pop()}-wt`);
    execFileSync('git', ['worktree', 'add', '-q', '-b', 'other', wt], { cwd: root });
    const miss = await tool('gitgood_latest_review', { repoPath: wt }, recorder());
    expect(miss.result?.isError).toBe(true);
    expect(text(miss)).toContain('No GitGood review export');
    expect(text(miss)).toMatch(/worktrees[\\/]/);
  });

  it('request_rereview opens exactly the tokenised link from the export', async () => {
    const root = await repoWithExport();
    const deps = recorder();
    const r = await tool('gitgood_request_rereview', { repoPath: root }, deps);
    expect(r.result?.isError).toBeUndefined();
    expect(deps.urls).toEqual([`gitgood://review/rerun?repo=${encodeURIComponent(root)}&token=${encodeURIComponent('tok 1&2')}`]);
  });

  it('request_rereview fails clearly without a link, with a foreign link, or when the opener fails', async () => {
    const deps = recorder();
    const branch = await tool('gitgood_request_rereview', { repoPath: await repoWithExport({ kind: 'branch' }) }, deps);
    expect(branch.result?.isError).toBe(true);
    expect(text(branch)).toContain('no re-review link');

    const evil = JSON.stringify({ findings: [], runId: 'r', rerun: { url: 'file:///etc/passwd', command: '' } });
    const foreign = await tool('gitgood_request_rereview', { repoPath: await repoWithExport({ raw: evil }) }, deps);
    expect(foreign.result?.isError).toBe(true);
    expect(deps.urls).toEqual([]);

    const failing = recorder({ openUrl: async () => { throw new Error('no handler'); } });
    const r = await tool('gitgood_request_rereview', { repoPath: await repoWithExport() }, failing);
    expect(r.result?.isError).toBe(true);
    expect(text(r)).toContain('no handler');
  });

  it('reports missing, corrupt and non-repository inputs as tool errors', async () => {
    const deps = recorder();
    const noExport = await realpath(await mkdtemp(join(tmpdir(), 'gg-mcp-')));
    execFileSync('git', ['init', '-q', noExport]);
    const cases: [string, unknown, RegExp][] = [
      ['gitgood_latest_review', { repoPath: noExport }, /No GitGood review export/],
      ['gitgood_latest_review', { repoPath: await repoWithExport({ raw: '{nope' }) }, /not a valid GitGood review export/],
      ['gitgood_latest_review', { repoPath: await mkdtemp(join(tmpdir(), 'gg-mcp-plain-')) }, /not inside a git repository/],
      ['gitgood_latest_review', { repoPath: join(noExport, 'missing') }, /not a directory/],
      ['gitgood_latest_review', {}, /"repoPath" must be a non-empty string/],
      ['gitgood_open_repository', { path: 42 }, /"path" must be a non-empty string/],
    ];
    for (const [name, args, re] of cases) {
      const r = await tool(name, args, deps);
      expect(r.error).toBeUndefined();
      expect(r.result?.isError).toBe(true);
      expect(text(r)).toMatch(re);
    }
  });

  it('open_repository launches GitGood on the repository root, from any folder inside it', async () => {
    const root = await repoWithExport();
    await mkdir(join(root, 'sub'));
    const deps = recorder();
    const r = await tool('gitgood_open_repository', { path: join(root, 'sub') }, deps);
    expect(r.result?.isError).toBeUndefined();
    expect(deps.dirs).toEqual([root]);
    expect(JSON.parse(text(r))).toEqual({ opened: root });

    const failing = recorder({ launchApp: async () => { throw new Error('gitgood was not found'); } });
    const bad = await tool('gitgood_open_repository', { path: root }, failing);
    expect(bad.result?.isError).toBe(true);
    expect(text(bad)).toContain('gitgood was not found');
  });
});
