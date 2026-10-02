/**
 * GitGood's MCP server: the review handoff for coding agents as three tools.
 * Pure message handling (JSON-RPC 2.0, MCP tools capability); `index.ts` wires it
 * to stdio. Read-only except opening a link or the GitGood app: findings come from
 * `<git-dir>/gitgood/review/latest.json`, which GitGood writes after every review.
 */
import { execFile, spawn } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { EXPORT_DIR_SEGMENTS, LATEST_JSON, type ReviewExport } from '../main/ai/review-export';

/** Newest first. A client asking for anything else is answered with the newest, as the spec requires. */
export const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const RERUN_PREFIX = 'gitgood://review/rerun?';

export interface McpDeps {
  /** Hands a URL to the OS opener (xdg-open / open / Start-Process). */
  openUrl(url: string): Promise<void>;
  /** Starts GitGood (or its already running instance) on a directory. */
  launchApp(dir: string): Promise<void>;
}

interface JsonRpcRequest {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
}

const REPO_PATH = { type: 'string', description: 'Path of the repository (or any folder inside it, or a linked worktree).' };
export const TOOLS = [
  {
    name: 'gitgood_latest_review',
    description: 'The latest AI review GitGood exported for a repository: open findings (file, line, severity, message, suggestion) and the re-review link. Read-only.',
    inputSchema: { type: 'object', properties: { repoPath: REPO_PATH }, required: ['repoPath'], additionalProperties: false },
  },
  {
    name: 'gitgood_request_rereview',
    description: 'Ask GitGood to re-run the pre-commit review of the working tree by opening the latest export\'s single-use re-review link. Use after fixing findings; fails when the latest review has no link (pull request and branch reviews read committed history).',
    inputSchema: { type: 'object', properties: { repoPath: REPO_PATH }, required: ['repoPath'], additionalProperties: false },
  },
  {
    name: 'gitgood_open_repository',
    description: 'Open a repository in the GitGood desktop app.',
    inputSchema: { type: 'object', properties: { path: REPO_PATH }, required: ['path'], additionalProperties: false },
  },
];

/** A failure the agent should read; reported as a tool result with `isError`, not a protocol error. */
class ToolError extends Error {}

function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((ok, fail) => {
    execFile('git', args, { cwd, encoding: 'utf8', windowsHide: true }, (err, stdout, stderr) => {
      if (err) fail(new ToolError(/ENOENT/.test(err.message) ? 'git was not found on PATH.' : `${cwd} is not inside a git repository (${stderr.trim() || err.message}).`));
      else ok(stdout.trim());
    });
  });
}

function pathArg(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== 'string' || !value.trim()) throw new ToolError(`"${key}" must be a non-empty string.`);
  return resolve(value);
}

async function directoryArg(args: Record<string, unknown>, key: string): Promise<string> {
  const dir = pathArg(args, key);
  if (!(await stat(dir).catch(() => null))?.isDirectory()) throw new ToolError(`${dir} is not a directory.`);
  return dir;
}

/** Same lookup as the app (`git rev-parse --git-dir`, so linked worktrees resolve to their own git dir). */
async function readLatest(args: Record<string, unknown>): Promise<{ file: string; doc: ReviewExport }> {
  const dir = await directoryArg(args, 'repoPath');
  const gitDir = await git(dir, ['rev-parse', '--git-dir']);
  const file = join(isAbsolute(gitDir) ? gitDir : resolve(dir, gitDir), ...EXPORT_DIR_SEGMENTS, LATEST_JSON);
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch {
    throw new ToolError(`No GitGood review export at ${file}. Run an AI review for this repository in GitGood first.`);
  }
  try {
    const doc = JSON.parse(text) as ReviewExport;
    if (!doc || !Array.isArray(doc.findings)) throw new Error('missing findings');
    return { file, doc };
  } catch (err) {
    throw new ToolError(`${file} is not a valid GitGood review export (${err instanceof Error ? err.message : String(err)}).`);
  }
}

async function latestReview(args: Record<string, unknown>): Promise<unknown> {
  const { file, doc } = await readLatest(args);
  const open = doc.findings.filter((f) => !f.dismissed);
  return {
    exportFile: file,
    runId: doc.runId,
    previousRunId: doc.previousRunId,
    target: doc.target,
    verdict: doc.verdict,
    summary: doc.summary,
    finishedAt: doc.finishedAt,
    error: doc.error,
    dismissedCount: doc.findings.length - open.length,
    findings: open.map((f) => ({ file: f.path, line: f.line, endLine: f.endLine, severity: f.severity, category: f.category, title: f.title, message: f.detail, suggestion: f.suggestion, confidence: f.confidence })),
    rerun: doc.rerun,
  };
}

async function requestRereview(args: Record<string, unknown>, deps: McpDeps): Promise<unknown> {
  const { doc } = await readLatest(args);
  const url = doc.rerun?.url;
  if (!url) throw new ToolError('The latest review has no re-review link: pull request and branch reviews read committed history, so re-reviewing would change nothing. Ask the user to commit the changes in GitGood and press Re-review.');
  // The export is a file in the repository; never hand the OS opener anything but our own link.
  if (!url.startsWith(RERUN_PREFIX)) throw new ToolError('The re-review link in the export is not a gitgood://review/rerun link; refusing to open it.');
  try {
    await deps.openUrl(url);
  } catch (err) {
    throw new ToolError(`Could not open the re-review link (is GitGood installed and registered for gitgood:// links?): ${err instanceof Error ? err.message : String(err)}`);
  }
  return { opened: true, note: `GitGood re-reviews the working tree; re-read latest.json afterwards — its runId changes and previousRunId is ${doc.runId}.` };
}

async function openRepository(args: Record<string, unknown>, deps: McpDeps): Promise<unknown> {
  const root = resolve(await git(await directoryArg(args, 'path'), ['rev-parse', '--show-toplevel']));
  try {
    await deps.launchApp(root);
  } catch (err) {
    throw new ToolError(`Could not start GitGood: ${err instanceof Error ? err.message : String(err)}`);
  }
  return { opened: root };
}

export const defaultDeps: McpDeps = {
  openUrl(url) {
    const [cmd, ...args] = process.platform === 'win32' ? ['powershell', '-NoProfile', '-Command', `Start-Process '${url.replace(/'/g, "''")}'`] : process.platform === 'darwin' ? ['open', url] : ['xdg-open', url];
    return new Promise((ok, fail) => execFile(cmd, args, { windowsHide: true }, (err) => (err ? fail(err) : ok())));
  },
  launchApp(dir) {
    // Under the app's own runtime (ELECTRON_RUN_AS_NODE, how the plugin starts this) execPath is GitGood itself;
    // otherwise GITGOOD_APP, or the `gitgood` launcher the Linux installer puts on PATH.
    const exe = process.versions.electron ? process.env.APPIMAGE || process.execPath : process.env.GITGOOD_APP || 'gitgood';
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    return new Promise((ok, fail) => {
      // `dir` is absolute, so it cannot be mistaken for an option; the app opens it via its command-line support.
      const child = spawn(exe, [dir], { detached: true, stdio: 'ignore', env, windowsHide: true });
      child.once('error', (err) => fail(/ENOENT/.test(err.message) ? new Error(`${exe} was not found; set GITGOOD_APP to the GitGood executable.`) : err));
      child.once('spawn', () => {
        child.unref();
        ok();
      });
    });
  },
};

const rpcError = (id: unknown, code: number, message: string) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });

/** One decoded JSON-RPC message in, the response out (null for notifications). */
export async function handleMessage(msg: unknown, deps: McpDeps = defaultDeps): Promise<object | null> {
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return rpcError(null, -32600, 'Invalid Request');
  const { jsonrpc, id, method, params } = msg as JsonRpcRequest;
  if (jsonrpc !== '2.0' || typeof method !== 'string' || (id !== undefined && typeof id !== 'string' && typeof id !== 'number')) return rpcError(id, -32600, 'Invalid Request');
  if (id === undefined) return null; // notification (notifications/initialized, notifications/cancelled, …)
  const reply = (result: unknown) => ({ jsonrpc: '2.0', id, result });
  const p = (params && typeof params === 'object' ? params : {}) as Record<string, unknown>;
  switch (method) {
    case 'initialize': {
      const requested = typeof p.protocolVersion === 'string' ? p.protocolVersion : '';
      return reply({
        protocolVersion: PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSIONS[0],
        capabilities: { tools: {} },
        serverInfo: { name: 'gitgood', version: typeof __GITGOOD_VERSION__ === 'string' ? __GITGOOD_VERSION__ : 'dev' },
        instructions: 'Read the exported AI review with gitgood_latest_review, fix the findings, then call gitgood_request_rereview. Never commit on the user\'s behalf.',
      });
    }
    case 'ping':
      return reply({});
    case 'tools/list':
      return reply({ tools: TOOLS });
    case 'tools/call': {
      const name = p.name;
      if (!TOOLS.some((t) => t.name === name)) return rpcError(id, -32602, `Unknown tool: ${String(name)}`);
      const args = (p.arguments && typeof p.arguments === 'object' ? p.arguments : {}) as Record<string, unknown>;
      try {
        const result = name === 'gitgood_latest_review' ? await latestReview(args) : name === 'gitgood_request_rereview' ? await requestRereview(args, deps) : await openRepository(args, deps);
        return reply({ content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] });
      } catch (err) {
        if (!(err instanceof ToolError)) throw err;
        return reply({ content: [{ type: 'text', text: err.message }], isError: true });
      }
    }
    default:
      return rpcError(id, -32601, `Method not found: ${method}`);
  }
}

declare const __GITGOOD_VERSION__: string | undefined;
