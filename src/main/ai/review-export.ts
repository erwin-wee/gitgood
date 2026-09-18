/**
 * Pure rendering of a review run into the files GitGood leaves in the
 * repository's git directory for terminal coding agents (Claude Code, Codex,
 * omp, …): a machine-readable JSON document and a Markdown twin that opens
 * with instructions for the agent. No Electron or Node imports so the shape,
 * ordering and text can be unit tested in isolation; `ReviewService` decides
 * where the files go and writes them.
 */
import type { ReviewFinding, ReviewRun, ReviewSeverity } from '@shared/types';

export const EXPORT_VERSION = 1;
/** Path segments below the repository's git directory. */
export const EXPORT_DIR_SEGMENTS = ['gitgood', 'review'] as const;
export const LATEST_JSON = 'latest.json';
export const LATEST_MD = 'latest.md';
export const RUNS_DIR = 'runs';

export type ExportPlatform = 'linux' | 'darwin' | 'win32';

const SEVERITY_RANK: Record<ReviewSeverity, number> = { blocker: 0, warning: 1, nit: 2 };

export interface ReviewExportFile {
  path: string;
  status: ReviewRun['files'][number]['status'];
  reason: string | null;
}

export interface ReviewExport {
  version: typeof EXPORT_VERSION;
  runId: string;
  /** Most recent earlier run for the same target, or null. */
  previousRunId: string | null;
  repoPath: string;
  target: ReviewRun['target'];
  provider: string;
  model: string;
  effort: ReviewRun['effort'];
  strictness: ReviewRun['strictness'];
  startedAt: string;
  finishedAt: string | null;
  verdict: ReviewRun['verdict'];
  summary: string;
  cancelled: boolean;
  error: string | null;
  files: ReviewExportFile[];
  droppedInvalid: number;
  /** Every finding, dismissed ones included, sorted blocker → warning → nit, then path, then line. */
  findings: ReviewFinding[];
  /**
   * How to ask GitGood to re-review, or null when re-reviewing would be
   * pointless: a pull request or branch review reads committed history, so an
   * agent's uncommitted edits cannot change its result. The user commits
   * first and re-reviews from GitGood.
   */
  rerun: { url: string; command: string } | null;
}

/** Only the pre-commit review reads the working tree, so only it can confirm an agent's uncommitted edits. */
export function rerunUseful(target: ReviewRun['target']): boolean {
  return target.kind === 'worktree';
}

export function rerunUrl(repoPath: string): string {
  return `gitgood://review/rerun?repo=${encodeURIComponent(repoPath)}`;
}

/** The shell command an agent runs to ask GitGood for a re-review on this platform. */
export function rerunCommand(repoPath: string, platform: ExportPlatform): string {
  const url = rerunUrl(repoPath);
  if (platform === 'win32') return `Start-Process "${url}"`;
  if (platform === 'darwin') return `open '${url}'`;
  return `xdg-open '${url}'`;
}

function normalizePath(p: string): string {
  return p.replace(/\\/g, '/');
}

export function sortFindings(findings: ReviewFinding[]): ReviewFinding[] {
  return [...findings].sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0) || a.line - b.line);
}

export function buildExportJson(run: ReviewRun, previousRunId: string | null, platform: ExportPlatform): ReviewExport {
  return {
    version: EXPORT_VERSION,
    runId: run.id,
    previousRunId,
    repoPath: run.repoPath,
    target: run.target,
    provider: run.provider,
    model: run.model,
    effort: run.effort,
    strictness: run.strictness,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    verdict: run.verdict,
    summary: run.summary,
    cancelled: run.cancelled,
    error: run.error,
    files: run.files.map((f) => ({ path: normalizePath(f.file.path), status: f.status, reason: f.reason })),
    droppedInvalid: run.droppedInvalid,
    findings: sortFindings(run.findings).map((f) => ({ ...f, path: normalizePath(f.path) })),
    rerun: rerunUseful(run.target) ? { url: rerunUrl(run.repoPath), command: rerunCommand(run.repoPath, platform) } : null,
  };
}

/**
 * Two-space pretty printing is part of the contract: the plugin's session-start
 * hook counts `"dismissed": false` lines with grep when node is unavailable.
 */
export function serializeExport(doc: ReviewExport): string {
  return JSON.stringify(doc, null, 2) + '\n';
}

/** A fence long enough that no backtick run inside `text` can close it early. */
function fenceFor(text: string): string {
  const longest = Math.max(2, ...(text.match(/`+/g) ?? []).map((m) => m.length));
  return '`'.repeat(longest + 1);
}

function lineRange(f: ReviewFinding): string {
  return f.endLine !== null && f.endLine !== f.line ? `L${f.line}-L${f.endLine}` : `L${f.line}`;
}

function targetLine(run: ReviewRun): string {
  const t = run.target;
  if (t.kind === 'pr') return `Pull request #${t.number} (${t.title}) — head ${t.headSha.slice(0, 12)} against ${t.baseSha.slice(0, 12)}`;
  if (t.kind === 'branch') return `Branch ${t.head} against ${t.base} — head ${t.headSha.slice(0, 12)}, base ${t.baseSha.slice(0, 12)}`;
  return `Pending commit — ${t.paths.length} file${t.paths.length === 1 ? '' : 's'} selected in the working tree`;
}

export function renderExportMarkdown(run: ReviewRun, previousRunId: string | null, platform: ExportPlatform): string {
  const live = sortFindings(run.findings.filter((f) => !f.dismissed));
  const jsonName = `${RUNS_DIR}/${safeRunId(run.id)}.json`;
  const rerun = rerunCommand(run.repoPath, platform);
  const out: string[] = [];
  out.push(`# GitGood review findings`);
  out.push('');
  out.push(`Run \`${run.id}\`${previousRunId ? ` (supersedes \`${previousRunId}\`)` : ''} · ${targetLine(run)}`);
  out.push(`Reviewed with ${run.provider}/${run.model}${run.finishedAt ? ` · finished ${run.finishedAt}` : ''}${run.verdict ? ` · verdict: ${run.verdict}` : ''}`);
  if (run.summary) out.push('', run.summary);
  out.push('');
  out.push('## Instructions for the agent');
  out.push('');
  out.push('1. Work through the findings below in severity order (blocker, then warning, then nit), one file at a time.');
  out.push('2. Line numbers refer to the file as it was when the review ran. Once you have edited a file, trust each finding\'s title and detail over its line number.');
  out.push('3. Apply a `suggestion` block only when it still fits the surrounding code; otherwise fix the issue in your own way.');
  out.push('4. Do not commit, stage, stash or otherwise run git write operations. Leave that to the user.');
  if (rerunUseful(run.target)) {
    out.push(`5. When you are done, ask GitGood to re-review by running: \`${rerun}\``);
    if (platform === 'win32') out.push(`   From Command Prompt instead: \`start "" "${rerunUrl(run.repoPath)}"\``);
    out.push(`6. Then re-read \`${LATEST_JSON}\` next to this file: its \`runId\` changes when the re-review finishes and its \`previousRunId\` names this run. Finding ids are not stable across runs, so compare by title and path. If its target differs from the one above, say so instead of comparing.`);
  } else {
    out.push('5. Do not ask GitGood to re-review. This review covers committed changes, so it would read the same commits again and report the same findings no matter what you fixed.');
    out.push('6. Instead, finish by listing what you changed for each finding and telling the user to commit those changes in GitGood and press Re-review.');
  }
  out.push('');
  out.push(`The same data is in \`${LATEST_JSON}\` (this run) and \`${jsonName}\`. Dismissed findings appear only in the JSON, with \`"dismissed": true\`.`);
  out.push('');
  if (!live.length) {
    out.push('## Findings', '', run.error ? `The review failed: ${run.error}` : run.cancelled ? 'The review was cancelled before it produced findings.' : 'No open findings. Nothing to fix.');
    out.push('');
    return out.join('\n');
  }
  const counts = { blocker: 0, warning: 0, nit: 0 };
  for (const f of live) counts[f.severity]++;
  out.push(`## Findings (${live.length}: ${counts.blocker} blocker, ${counts.warning} warning, ${counts.nit} nit)`);
  out.push('');
  const byPath = new Map<string, ReviewFinding[]>();
  for (const f of live) {
    const key = normalizePath(f.path);
    const list = byPath.get(key);
    if (list) list.push(f);
    else byPath.set(key, [f]);
  }
  for (const [path, findings] of byPath) {
    out.push(`### ${path}`);
    out.push('');
    for (const f of findings) {
      out.push(`- **[${f.severity}] ${f.title}** — ${lineRange(f)} · ${f.category} · confidence ${f.confidence} · id \`${f.id}\``);
      out.push(`  ${f.detail.replace(/\r?\n/g, '\n  ')}`);
      if (f.suggestion !== null) {
        const fence = fenceFor(f.suggestion);
        out.push(`  Suggested replacement for ${lineRange(f)}:`);
        out.push(`  ${fence}`);
        // Drop one trailing LF (keeping a CR before it) so the join below does not add a blank line before the closing fence.
        out.push(f.suggestion.replace(/\n$/, '').split(/(?<=\n)/).map((l) => `  ${l}`).join(''));
        out.push(`  ${fence}`);
      }
    }
    out.push('');
  }
  if (run.droppedInvalid) out.push(`_${run.droppedInvalid} model finding${run.droppedInvalid === 1 ? ' was' : 's were'} dropped by validation for not pointing at lines in the diff._`, '');
  return out.join('\n');
}

export function safeRunId(runId: string): string {
  return runId.replace(/[^A-Za-z0-9._-]+/g, '_');
}

export function exportFileNames(runId: string): { json: string; md: string; latestJson: string; latestMd: string } {
  const id = safeRunId(runId);
  return { json: `${RUNS_DIR}/${id}.json`, md: `${RUNS_DIR}/${id}.md`, latestJson: LATEST_JSON, latestMd: LATEST_MD };
}
