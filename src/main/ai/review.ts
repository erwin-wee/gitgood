import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DiffOptions } from '@shared/ipc';
import type { AiReviewProgressEvent, CommitFile, DiffHunk, FileDiff, GitHubRepoRef, PostReviewOptions, PullRequest, ReviewFileEntry, ReviewFinding, ReviewPlan, ReviewRun, ReviewRunTarget, ReviewStartOptions, ReviewTarget, ReviewVerdict, WorkingFile, WorktreeReviewOptions, WorktreeReviewTarget } from '@shared/types';
import type { ParsedDiff } from '@shared/diff/parse';
import { parseUnifiedDiffs } from '@shared/diff/parse';
import { languageFromPath } from '@shared/util';
import { isUnborn } from '../git/commit';
import { buildTextDiff, getPatchForFiles, getRangeFileDiff, looksBinary, readBlobText, readWorktree, toFsPath } from '../git/diff';
import { EMPTY_TREE_SHA, GitError, type GitClient } from '../git/git';
import { getGitDir, getStatus } from '../git/status';
import type { GhClient } from '../gh/gh';
import { splitPrDiff } from '../gh/prdiff';
import { log } from '../logger';
import type { RepositoryManager } from '../repo/manager';
import type { Store } from '../store';
import type { ToolLocator } from '../tools';
import { AiError } from './backends';
import { createBackend } from './provider';
import { EXPORT_DIR_SEGMENTS, LATEST_JSON, RUNS_DIR, buildExportJson, exportFileNames, renderExportMarkdown, serializeExport, type ExportPlatform, type ReviewExport } from './review-export';
import { buildPrecommitFilePrompt, buildPrecommitSummaryPrompt, buildReviewFilePrompt, buildReviewSummaryPrompt, PRECOMMIT_SUMMARY_SCHEMA, PRECOMMIT_SUMMARY_SYSTEM_PROMPT, precommitReviewSystemPrompt, REVIEW_FILE_SCHEMA, REVIEW_SUMMARY_SCHEMA, REVIEW_SUMMARY_SYSTEM_PROMPT, reviewSystemPrompt, type PrecommitPromptContext, type ReviewPromptContext } from './prompts';
import { AI_FOOTER, annotateHunks, buildReviewPayload, changedLineCount, compareFindings, filterNearbyTestPaths, foldCommentsIntoBody, hashHunks, linkedIssueNumbers, replaceLinesInContent, skipReason, stableHash, validateFindings, verdictFloor } from './review-core';

const MAX_RUNS_PER_REPO = 5;
const CONTEXT_LINES = 400;
const MAX_CONTEXT_BLOB_BYTES = 200 * 1024;
const MAX_GUIDELINE_CHARS = 4000;
const CONCURRENCY = 3;
/** Byte cap for the worktree patch text sent per pre-commit review run (shared across every included file). */
const PRECOMMIT_MAX_PATCH_BYTES = 6 * 1024 * 1024;

type Reporter = (event: Omit<AiReviewProgressEvent, 'repoPath' | 'runId'>) => void;

/** Shared windowing logic behind `contextExcerpt`/`worktreeExcerpt`: up to CONTEXT_LINES lines of `content` around `hunks`, excluding lines already in the diff, with line numbers and "…" gaps. */
function excerptAroundHunks(content: string, hunks: DiffHunk[]): string | null {
  const lines = content.split(/\r?\n/);
  const inDiff = new Set<number>();
  for (const h of hunks) for (const l of h.lines) if (l.newLineNumber !== null) inDiff.add(l.newLineNumber);
  const wanted = new Set<number>();
  const perHunk = Math.max(10, Math.floor(CONTEXT_LINES / Math.max(1, hunks.length) / 2));
  for (const h of hunks) {
    const start = Math.max(1, h.newStart - perHunk);
    const end = Math.min(lines.length, h.newStart + Math.max(h.newLines, 1) + perHunk);
    for (let n = start; n <= end; n++) if (!inDiff.has(n)) wanted.add(n);
  }
  const sorted = [...wanted].sort((a, b) => a - b).slice(0, CONTEXT_LINES);
  if (!sorted.length) return null;
  const out: string[] = [];
  let prev = 0;
  for (const n of sorted) {
    if (prev && n !== prev + 1) out.push('…');
    out.push(`${String(n).padStart(5)}  ${lines[n - 1] ?? ''}`);
    prev = n;
  }
  return out.join('\n');
}

interface ResolvedTarget {
  /** Never 'worktree': resolveTarget only ever handles the pr/branch ReviewTarget input. */
  target: Exclude<ReviewRunTarget, WorktreeReviewTarget>;
  ref: GitHubRepoRef | null;
  pr: PullRequest | null;
  commitSubjects: string[];
  /** True when both SHAs exist in the local repository, so git can produce diffs and blobs. */
  local: boolean;
}

interface DiffSet {
  files: CommitFile[];
  diffs: Map<string, ParsedDiff>;
  source: 'git' | 'gh';
}

function targetKey(t: ReviewTarget | ReviewRunTarget): string {
  return t.kind === 'pr' ? `pr-${t.number}` : t.kind === 'worktree' ? 'worktree' : `branch-${t.base.replace(/[^A-Za-z0-9._-]+/g, '_')}`;
}

function newRunId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * AI pull request review: plans and runs a review of a PR or of the current
 * branch against its base, validates the model's findings against the real
 * diff, persists runs per head SHA, and posts reviews to GitHub on request.
 */
export class ReviewService {
  private controller: AbortController | null = null;
  private diffCache = new Map<string, DiffSet>();

  constructor(private readonly store: Store, private readonly tools: ToolLocator, private readonly git: GitClient, private readonly gh: GhClient, private readonly repos: RepositoryManager, private readonly userDataDir: string) {}

  cancel(): void {
    this.controller?.abort();
    this.controller = null;
  }

  /** True while a review run is in flight; used by the update install gate to refuse installing mid-review. */
  isActive(): boolean {
    return this.controller !== null;
  }

  // ---------- storage ----------

  private repoDir(repoPath: string): string {
    const id = this.repos.getByPath(repoPath)?.id ?? stableHash(repoPath);
    return join(this.userDataDir, 'reviews', id.replace(/[^A-Za-z0-9._-]+/g, '_'));
  }

  private runFile(repoPath: string, target: ReviewRunTarget): string {
    // The worktree target has no stable head SHA (it reviews the working tree); one file per
    // repository, overwritten on every run, matches "replaced on each run" in the design.
    const suffix = target.kind === 'worktree' ? '' : `-${target.headSha.slice(0, 12)}`;
    return join(this.repoDir(repoPath), `${targetKey(target)}${suffix}.json`);
  }

  private async saveRun(run: ReviewRun): Promise<void> {
    const dir = this.repoDir(run.repoPath);
    await mkdir(dir, { recursive: true });
    const file = this.runFile(run.repoPath, run.target);
    await writeFile(`${file}.tmp`, JSON.stringify(run, null, 2), 'utf8');
    const { rename } = await import('node:fs/promises');
    await rename(`${file}.tmp`, file);
    await this.prune(dir);
    if (run.finishedAt) await this.exportRun(run);
  }

  // ---------- agent export ----------

  /** `<git-dir>/gitgood/review`, per worktree (linked worktrees have their own git directory). */
  private async exportDir(repoPath: string): Promise<string> {
    return join(await getGitDir(this.git, repoPath), ...EXPORT_DIR_SEGMENTS);
  }

  private static exportPlatform(): ExportPlatform {
    return process.platform === 'win32' || process.platform === 'darwin' ? process.platform : 'linux';
  }

  private async readExport(file: string): Promise<ReviewExport | null> {
    try {
      return JSON.parse(await readFile(file, 'utf8')) as ReviewExport;
    } catch {
      return null;
    }
  }

  /** When a run happened, for ordering exports: its finish time, falling back to its start. */
  private static exportTime(run: Pick<ReviewRun, 'startedAt' | 'finishedAt'>): string {
    return run.finishedAt ?? run.startedAt;
  }

  /**
   * The run this one supersedes: the newest earlier export of the same target.
   * Read from the exported `runs/` directory rather than the review store,
   * because the store keeps only one pre-commit run per repository and would
   * lose the chain as soon as a second run replaced the first.
   */
  private async previousExportId(runsDir: string, run: ReviewRun): Promise<string | null> {
    let best: ReviewExport | null = null;
    const key = targetKey(run.target);
    let entries: string[];
    try {
      entries = (await readdir(runsDir)).filter((f) => f.endsWith('.json'));
    } catch {
      return null;
    }
    for (const entry of entries) {
      const doc = await this.readExport(join(runsDir, entry));
      if (!doc || doc.runId === run.id || targetKey(doc.target) !== key) continue;
      if (ReviewService.exportTime(doc) > ReviewService.exportTime(run)) continue;
      if (!best || ReviewService.exportTime(doc) > ReviewService.exportTime(best)) best = doc;
    }
    return best?.runId ?? null;
  }

  private async writeExportFile(file: string, text: string): Promise<void> {
    const { rename } = await import('node:fs/promises');
    await writeFile(`${file}.tmp`, text, 'utf8');
    await rename(`${file}.tmp`, file);
  }

  /**
   * Writes the run as JSON and Markdown for terminal coding agents (see
   * review-export.ts): one immutable pair under runs/, plus the latest.*
   * copies when this run is the newest the repository has finished. Throws on
   * failure; `saveRun` swallows it so a failed export never fails a review or
   * a dismissal, while `exportPath` reports it rather than handing an agent a
   * stale file.
   */
  private async writeExport(run: ReviewRun): Promise<void> {
    const dir = await this.exportDir(run.repoPath);
    const runsDir = join(dir, RUNS_DIR);
    await mkdir(runsDir, { recursive: true });
    const names = exportFileNames(run.id);
    const previousRunId = await this.previousExportId(runsDir, run);
    const platform = ReviewService.exportPlatform();
    const json = serializeExport(buildExportJson(run, previousRunId, platform));
    const md = renderExportMarkdown(run, previousRunId, platform);
    await this.writeExportFile(join(dir, ...names.json.split('/')), json);
    await this.writeExportFile(join(dir, ...names.md.split('/')), md);
    // Dismissing a finding on an older run re-exports it; that must not make it
    // the latest again, or an agent would be pointed at superseded findings.
    const latest = await this.readExport(join(dir, LATEST_JSON));
    if (!latest || latest.runId === run.id || ReviewService.exportTime(latest) <= ReviewService.exportTime(run)) {
      await this.writeExportFile(join(dir, names.latestJson), json);
      await this.writeExportFile(join(dir, names.latestMd), md);
    }
    await this.pruneExports(runsDir);
  }

  private async exportRun(run: ReviewRun): Promise<void> {
    try {
      await this.writeExport(run);
    } catch (err) {
      log.warn(`Could not export review ${run.id} for agents: ${(err as Error).message}`);
    }
  }

  private async pruneExports(runsDir: string): Promise<void> {
    const entries = (await readdir(runsDir)).filter((f) => f.endsWith('.json'));
    if (entries.length <= MAX_RUNS_PER_REPO) return;
    const stats = await Promise.all(entries.map(async (f) => ({ f, mtime: (await stat(join(runsDir, f))).mtimeMs })));
    stats.sort((a, b) => b.mtime - a.mtime);
    for (const s of stats.slice(MAX_RUNS_PER_REPO)) {
      await rm(join(runsDir, s.f), { force: true });
      await rm(join(runsDir, s.f.replace(/\.json$/, '.md')), { force: true });
    }
  }

  /** The most recently finished run for the repository, any target; what the re-review deep link acts on. */
  async latest(repoPath: string): Promise<ReviewRun | null> {
    // loadRuns sorts by start time; a long pull request review can start before
    // and finish after a quick pre-commit one, so order by finish time here.
    const finished = (await this.loadRuns(repoPath)).filter((r) => r.finishedAt !== null);
    return finished.sort((a, b) => b.finishedAt!.localeCompare(a.finishedAt!))[0] ?? null;
  }

  /** (Re)writes the agent export for `runId` so it is the `latest.*` pair, and returns the absolute path of latest.md. */
  async exportPath(repoPath: string, runId: string): Promise<string> {
    const run = await this.findRun(repoPath, runId);
    if (!run) throw new AiError('The review run was not found. Run the review again.', 'other');
    try {
      await this.writeExport(run);
    } catch (err) {
      throw new AiError(`The review findings could not be written to the repository's git directory: ${(err as Error).message}`, 'other');
    }
    // The run is the newest one only when it was written as latest.*; an older
    // run that is being re-exported keeps its own runs/ copy, which is what the
    // agent must be pointed at.
    const dir = await this.exportDir(repoPath);
    const names = exportFileNames(runId);
    const latest = await this.readExport(join(dir, LATEST_JSON));
    return latest?.runId === runId ? join(dir, names.latestMd) : join(dir, ...names.md.split('/'));
  }

  private async prune(dir: string): Promise<void> {
    try {
      const entries = (await readdir(dir)).filter((f) => f.endsWith('.json'));
      if (entries.length <= MAX_RUNS_PER_REPO) return;
      const stats = await Promise.all(entries.map(async (f) => ({ f, mtime: (await stat(join(dir, f))).mtimeMs })));
      stats.sort((a, b) => b.mtime - a.mtime);
      for (const s of stats.slice(MAX_RUNS_PER_REPO)) await rm(join(dir, s.f), { force: true });
    } catch (err) {
      log.warn(`Could not prune review runs in ${dir}: ${(err as Error).message}`);
    }
  }

  private async loadRuns(repoPath: string): Promise<ReviewRun[]> {
    const dir = this.repoDir(repoPath);
    if (!existsSync(dir)) return [];
    const runs: ReviewRun[] = [];
    for (const f of await readdir(dir)) {
      if (!f.endsWith('.json')) continue;
      try {
        runs.push(JSON.parse(await readFile(join(dir, f), 'utf8')) as ReviewRun);
      } catch {
        /* corrupt file; ignore */
      }
    }
    return runs.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  private async latestRun(repoPath: string, target: ReviewTarget | ReviewRunTarget): Promise<ReviewRun | null> {
    const key = targetKey(target);
    return (await this.loadRuns(repoPath)).find((r) => targetKey(r.target) === key) ?? null;
  }

  private async findRun(repoPath: string, runId: string): Promise<ReviewRun | null> {
    return (await this.loadRuns(repoPath)).find((r) => r.id === runId) ?? null;
  }

  // ---------- target resolution ----------

  private async hasCommit(repoPath: string, sha: string): Promise<boolean> {
    return (await this.git.tryRun(repoPath, ['cat-file', '-e', `${sha}^{commit}`], { readOnly: true })) !== null;
  }

  private async resolveTarget(repoPath: string, input: ReviewTarget): Promise<ResolvedTarget> {
    if (input.kind === 'branch') {
      const head = (await this.git.stdout(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD'], { readOnly: true })).trim();
      const headSha = (await this.git.stdout(repoPath, ['rev-parse', 'HEAD'], { readOnly: true })).trim();
      const baseResolved = (await this.git.tryRun(repoPath, ['rev-parse', '--verify', '--quiet', `${input.base}^{commit}`], { readOnly: true })) ?? (await this.git.tryRun(repoPath, ['rev-parse', '--verify', '--quiet', `origin/${input.base}^{commit}`], { readOnly: true }));
      if (!baseResolved) throw new GitError({ message: `Base branch "${input.base}" was not found locally. Fetch first.`, command: '', exitCode: null, stderr: '', stdout: '', code: 'unknown' });
      const baseRef = baseResolved.stdout.trim();
      const mergeBase = (await this.git.stdout(repoPath, ['merge-base', baseRef, headSha], { readOnly: true })).trim();
      const subjects = (await this.git.stdout(repoPath, ['log', '--format=%s', `${mergeBase}..${headSha}`], { readOnly: true })).split('\n').filter(Boolean);
      return { target: { kind: 'branch', base: input.base, head, headSha, baseSha: mergeBase }, ref: null, pr: null, commitSubjects: subjects, local: true };
    }
    const ref = await this.repos.detectGitHub(repoPath);
    if (!ref) throw new GitError({ message: 'This repository does not have a GitHub remote.', command: '', exitCode: null, stderr: '', stdout: '', code: 'remote-not-found' });
    const [pr, refs] = await Promise.all([this.gh.prView(ref, input.number), this.gh.prRefs(ref, input.number)]);
    const local = (await this.hasCommit(repoPath, refs.headSha)) && (await this.hasCommit(repoPath, refs.baseSha));
    return { target: { kind: 'pr', number: input.number, headSha: refs.headSha, baseSha: refs.baseSha, title: pr.title, url: pr.url }, ref, pr, commitSubjects: refs.commitSubjects, local };
  }

  // ---------- diffs ----------

  private async diffSet(repoPath: string, resolved: ResolvedTarget, signal?: AbortSignal): Promise<DiffSet> {
    const key = `${repoPath}\0${targetKey(resolved.target)}\0${resolved.target.headSha}`;
    const cached = this.diffCache.get(key);
    if (cached) return cached;
    let text: string;
    let source: DiffSet['source'];
    if (resolved.local) {
      text = (await this.git.run(repoPath, ['diff', '--no-color', '--no-ext-diff', '--src-prefix=a/', '--dst-prefix=b/', '-M', '--no-relative', '--unified=3', `${resolved.target.baseSha}...${resolved.target.headSha}`], { readOnly: true, okExitCodes: [1], maxBuffer: 256 * 1024 * 1024, signal })).stdout;
      source = 'git';
    } else if (resolved.ref && resolved.target.kind === 'pr') {
      text = await this.gh.prDiff(resolved.ref, resolved.target.number, signal);
      source = 'gh';
    } else {
      throw new GitError({ message: 'The pull request commits are not available locally and gh could not fetch the diff.', command: '', exitCode: null, stderr: '', stdout: '', code: 'unknown' });
    }
    const split = splitPrDiff(text);
    const set: DiffSet = { ...split, source };
    if (this.diffCache.size > 20) this.diffCache.delete(this.diffCache.keys().next().value!);
    this.diffCache.set(key, set);
    return set;
  }

  /** Files changed in a pull request plus its SHAs (for the PR file list). */
  async prFiles(repoPath: string, number: number): Promise<{ files: CommitFile[]; headSha: string; baseSha: string }> {
    const resolved = await this.resolveTarget(repoPath, { kind: 'pr', number });
    const set = await this.diffSet(repoPath, resolved);
    return { files: set.files, headSha: resolved.target.headSha, baseSha: resolved.target.baseSha };
  }

  /** Diff of one file in a pull request for the diff viewer. */
  async prFileDiff(repoPath: string, number: number, path: string, opts: DiffOptions): Promise<FileDiff> {
    const resolved = await this.resolveTarget(repoPath, { kind: 'pr', number });
    const set = await this.diffSet(repoPath, resolved);
    const file = set.files.find((f) => f.path === path) ?? { path, oldPath: null, status: 'modified' as const, additions: null, deletions: null, binary: false, lfs: false };
    if (resolved.local) return getRangeFileDiff(this.git, repoPath, resolved.target.baseSha, resolved.target.headSha, file, opts);
    const parsed = set.diffs.get(path);
    if (!parsed) return { kind: 'empty', reason: 'This file is not part of the pull request diff.' };
    if (parsed.header.isBinary || file.binary) return { kind: 'binary', oldBytes: null, newBytes: null };
    if (!parsed.hunks.length) return { kind: 'empty', reason: file.status === 'renamed' ? `Renamed from ${file.oldPath} with no content changes.` : 'No changes to display.' };
    return buildTextDiff(parsed, path, null, null);
  }

  // ---------- planning ----------

  private async generatedPaths(repoPath: string, paths: string[]): Promise<Set<string>> {
    const out = new Set<string>();
    if (!paths.length) return out;
    const res = await this.git.tryRun(repoPath, ['check-attr', 'linguist-generated', '-z', '--', ...paths], { readOnly: true });
    if (!res) return out;
    const tokens = res.stdout.split('\0');
    for (let i = 0; i + 2 < tokens.length; i += 3) if (tokens[i + 2] === 'true' || tokens[i + 2] === 'set') out.add(tokens[i]);
    return out;
  }

  private async planEntries(repoPath: string, set: DiffSet, maxFiles: number, only: string[] | null): Promise<{ entries: ReviewFileEntry[]; changedLines: number }> {
    const generated = await this.generatedPaths(repoPath, set.files.map((f) => f.path));
    let reviewable = 0;
    let changedLines = 0;
    const entries: ReviewFileEntry[] = set.files.map((file) => {
      const parsed = set.diffs.get(file.path);
      const hunks = parsed?.hunks ?? [];
      const lines = changedLineCount(hunks);
      const hash = hunks.length ? hashHunks(hunks) : null;
      if (only && !only.includes(file.path)) return { file, status: 'skipped', reason: 'not selected', hash };
      const reason = skipReason(file, lines, generated) ?? (hunks.length === 0 ? 'no text changes' : null);
      if (reason) return { file, status: 'skipped', reason, hash };
      reviewable++;
      if (reviewable > maxFiles) return { file, status: 'skipped', reason: `over the ${maxFiles}-file limit`, hash };
      changedLines += lines;
      return { file, status: 'pending', reason: null, hash };
    });
    return { entries, changedLines };
  }

  async plan(repoPath: string, input: ReviewTarget): Promise<ReviewPlan> {
    // The plan only needs settings; the backend itself is validated when the run starts.
    const settings = this.store.getSettings().ai;
    if (settings.provider === 'disabled') throw new AiError('AI features are turned off. Enable them in Options → AI.', 'not-configured');
    const resolved = await this.resolveTarget(repoPath, input);
    const set = await this.diffSet(repoPath, resolved);
    const { entries, changedLines } = await this.planEntries(repoPath, set, settings.reviewMaxFiles, null);
    const previous = await this.latestRun(repoPath, resolved.target);
    const login = resolved.pr ? await this.gh.viewerLogin() : null;
    return {
      target: resolved.target,
      files: entries,
      changedLines,
      model: settings.model,
      provider: settings.provider,
      effort: settings.effort,
      strictness: settings.reviewStrictness,
      maxFiles: settings.reviewMaxFiles,
      ownPullRequest: !!(resolved.pr && login && resolved.pr.author.toLowerCase() === login.toLowerCase()),
      previousRun: previous && previous.target.kind !== 'worktree' ? { id: previous.id, headSha: previous.target.headSha, finishedAt: previous.finishedAt } : null,
    };
  }

  async get(repoPath: string, input: ReviewTarget): Promise<ReviewRun | null> {
    return this.latestRun(repoPath, input);
  }

  async dismiss(repoPath: string, runId: string, findingId: string, dismissed: boolean): Promise<void> {
    const run = await this.findRun(repoPath, runId);
    if (!run) return;
    const f = run.findings.find((x) => x.id === findingId);
    if (!f) return;
    f.dismissed = dismissed;
    await this.saveRun(run);
  }

  // ---------- running ----------

  private async guidelines(repoPath: string): Promise<string | null> {
    const candidates = ['.gitgood/review.md', 'CONTRIBUTING.md', '.github/CONTRIBUTING.md', 'docs/CONTRIBUTING.md', '.github/PULL_REQUEST_TEMPLATE.md', '.github/pull_request_template.md'];
    const parts: string[] = [];
    let budget = MAX_GUIDELINE_CHARS;
    for (const c of candidates) {
      const p = join(repoPath, ...c.split('/'));
      if (!existsSync(p) || budget <= 0) continue;
      try {
        const text = (await readFile(p, 'utf8')).trim();
        if (!text) continue;
        const slice = text.slice(0, budget);
        budget -= slice.length;
        parts.push(`## ${c}\n${slice}`);
      } catch {
        /* unreadable */
      }
    }
    return parts.length ? parts.join('\n\n') : null;
  }

  private async promptContext(repoPath: string, resolved: ResolvedTarget): Promise<ReviewPromptContext> {
    const pr = resolved.pr;
    const linked: ReviewPromptContext['linkedIssues'] = [];
    if (pr && resolved.ref) {
      for (const n of linkedIssueNumbers(pr.body)) {
        const issue = await this.gh.issueView(resolved.ref, n);
        if (issue) linked.push(issue);
      }
    }
    let failingChecks: string[] = [];
    if (pr && resolved.ref && pr.checks.failed > 0) {
      try {
        failingChecks = (await this.gh.prChecks(resolved.ref, pr.number)).filter((c) => c.bucket === 'fail').map((c) => (c.workflow ? `${c.workflow} / ${c.name}` : c.name));
      } catch {
        /* checks unavailable */
      }
    }
    const t = resolved.target;
    return {
      title: pr?.title ?? (t.kind === 'branch' ? `${t.head} → ${t.base}` : `#${t.number}`),
      body: pr?.body ?? '',
      baseBranch: pr?.baseRefName ?? (t.kind === 'branch' ? t.base : ''),
      headBranch: pr?.headRefName ?? (t.kind === 'branch' ? t.head : ''),
      author: pr?.author ?? null,
      commitSubjects: resolved.commitSubjects,
      linkedIssues: linked,
      failingChecks,
      guidelines: await this.guidelines(repoPath),
    };
  }

  /** Head-side excerpt around the hunks, with line numbers, or null when unavailable. */
  private async contextExcerpt(repoPath: string, resolved: ResolvedTarget, path: string, parsed: ParsedDiff): Promise<string | null> {
    let content: string | null = null;
    if (resolved.local) content = await readBlobText(this.git, repoPath, resolved.target.headSha, path);
    else if (resolved.ref) content = await this.gh.fileContents(resolved.ref, path, resolved.target.headSha, MAX_CONTEXT_BLOB_BYTES);
    return content === null ? null : excerptAroundHunks(content, parsed.hunks);
  }

  /** Working-tree excerpt around the hunks, for the pre-commit reviewer (no ref to read a blob from). */
  private async worktreeExcerpt(repoPath: string, path: string, parsed: ParsedDiff): Promise<string | null> {
    const buf = await readWorktree(repoPath, path);
    if (!buf || looksBinary(buf) || buf.length > MAX_CONTEXT_BLOB_BYTES) return null;
    return excerptAroundHunks(buf.toString('utf8'), parsed.hunks);
  }

  async start(repoPath: string, input: ReviewTarget, opts: ReviewStartOptions, report: (e: AiReviewProgressEvent) => void): Promise<ReviewRun> {
    this.controller?.abort();
    const controller = new AbortController();
    this.controller = controller;
    // `finally`, not a tail assignment: anything that throws on the way (AI
    // disabled, an unknown base branch, gh failing) would otherwise leave the
    // controller set, so `isActive()` stays true for the rest of the process
    // and blocks installing an update forever.
    try {
      return await this.runReview(repoPath, input, opts, report, controller);
    } finally {
      if (this.controller === controller) this.controller = null;
    }
  }

  private async runReview(repoPath: string, input: ReviewTarget, opts: ReviewStartOptions, report: (e: AiReviewProgressEvent) => void, controller: AbortController): Promise<ReviewRun> {
    const signal = controller.signal;
    const runId = newRunId();
    const emit: Reporter = (e) => report({ ...e, repoPath, runId });

    const { backend, settings } = await createBackend(this.store, this.tools);
    emit({ phase: 'preparing', path: null, index: 0, total: 0, message: 'Reading the diff…' });
    const resolved = await this.resolveTarget(repoPath, input);
    const set = await this.diffSet(repoPath, resolved, signal);
    const { entries } = await this.planEntries(repoPath, set, settings.reviewMaxFiles, opts.files?.length ? opts.files : null);
    const login = resolved.pr ? await this.gh.viewerLogin() : null;

    const run: ReviewRun = {
      id: runId,
      repoPath,
      target: resolved.target,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      model: settings.model,
      provider: backend.name,
      effort: settings.effort,
      strictness: settings.reviewStrictness,
      summary: '',
      verdict: null,
      findings: [],
      files: entries,
      droppedInvalid: 0,
      error: null,
      cancelled: false,
      ownPullRequest: !!(resolved.pr && login && resolved.pr.author.toLowerCase() === login.toLowerCase()),
      commitMessageMatches: null,
      commitMessageNote: '',
    };

    // Re-review: carry over findings for files whose hunks are unchanged.
    const previous = opts.rereviewOf ? await this.findRun(repoPath, opts.rereviewOf) : null;
    if (previous) {
      const prevByPath = new Map(previous.files.map((f) => [f.file.path, f]));
      for (const entry of run.files) {
        const prev = prevByPath.get(entry.file.path);
        if (entry.status === 'pending' && prev && prev.status === 'reviewed' && prev.hash && prev.hash === entry.hash) {
          entry.status = 'reviewed';
          entry.reason = 'unchanged since the previous review';
          run.findings.push(...previous.findings.filter((f) => f.path === entry.file.path));
        }
      }
    }

    const pending = run.files.filter((f) => f.status === 'pending');
    const total = pending.length;
    const fileSummaries: { path: string; summary: string }[] = [];
    let context: ReviewPromptContext;
    try {
      context = await this.promptContext(repoPath, resolved);
    } catch (err) {
      log.warn(`Review context unavailable: ${(err as Error).message}`);
      context = { title: resolved.pr?.title ?? '', body: '', baseBranch: '', headBranch: '', author: null, commitSubjects: resolved.commitSubjects, linkedIssues: [], failingChecks: [], guidelines: null };
    }
    const system = reviewSystemPrompt(settings.reviewStrictness);

    let done = 0;
    const reviewOne = async (entry: ReviewFileEntry) => {
      const path = entry.file.path;
      const parsed = set.diffs.get(path)!;
      emit({ phase: 'file', path, index: done + 1, total, message: `Reviewing ${done + 1} of ${total}: ${path}` });
      try {
        const excerpt = await this.contextExcerpt(repoPath, resolved, path, parsed);
        const response = await backend.complete({
          system,
          prompt: buildReviewFilePrompt({ context, path, oldPath: entry.file.oldPath, status: entry.file.status, language: languageFromPath(path), annotatedDiff: annotateHunks(parsed.hunks), contextExcerpt: excerpt, truncated: false }),
          schema: REVIEW_FILE_SCHEMA as unknown as Record<string, unknown>,
          model: settings.model,
          effort: settings.effort,
          signal,
        });
        const { findings, dropped } = validateFindings(response.json, path, parsed.hunks, settings.reviewStrictness);
        run.findings.push(...findings);
        run.droppedInvalid += dropped;
        const summary = (response.json as { fileSummary?: unknown })?.fileSummary;
        fileSummaries.push({ path, summary: typeof summary === 'string' ? summary : '' });
        entry.status = 'reviewed';
      } catch (err) {
        if (signal.aborted) {
          entry.status = 'cancelled';
          entry.reason = 'cancelled';
          return;
        }
        entry.status = 'failed';
        entry.reason = err instanceof Error ? err.message : String(err);
        if (err instanceof AiError && (err.kind === 'auth' || err.kind === 'not-configured' || err.kind === 'rate-limit')) throw err;
        log.warn(`Review of ${path} failed: ${entry.reason}`);
      } finally {
        done++;
      }
    };

    let fatal: Error | null = null;
    let index = 0;
    const worker = async () => {
      while (index < pending.length && !signal.aborted && !fatal) {
        const entry = pending[index++];
        try {
          await reviewOne(entry);
        } catch (err) {
          fatal = err as Error;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, pending.length) }, worker));
    for (const entry of run.files) {
      if (entry.status === 'pending') {
        entry.status = 'cancelled';
        entry.reason = signal.aborted ? 'cancelled' : 'not started';
      }
    }

    run.findings = run.findings.sort(compareFindings);
    run.cancelled = signal.aborted;
    if (fatal) run.error = (fatal as Error).message;

    if (!signal.aborted && !fatal && run.files.some((f) => f.status === 'reviewed')) {
      emit({ phase: 'summarizing', path: null, index: total, total, message: 'Writing the summary…' });
      try {
        const response = await backend.complete({
          system: REVIEW_SUMMARY_SYSTEM_PROMPT,
          prompt: buildReviewSummaryPrompt(
            context,
            fileSummaries,
            run.findings.map((f) => ({ path: f.path, line: f.line, severity: f.severity, title: f.title })),
            run.files.filter((f) => f.status === 'skipped').length,
            run.droppedInvalid,
          ),
          schema: REVIEW_SUMMARY_SCHEMA as unknown as Record<string, unknown>,
          model: settings.model,
          effort: settings.effort === 'max' ? 'high' : settings.effort,
          signal,
        });
        const json = response.json as { summary?: unknown; verdict?: unknown };
        run.summary = typeof json.summary === 'string' ? json.summary.trim() : '';
        const floor = verdictFloor(run.findings);
        const modelVerdict = json.verdict === 'approve' || json.verdict === 'comment' || json.verdict === 'request-changes' ? (json.verdict as ReviewVerdict) : floor;
        run.verdict = stricter(modelVerdict, floor);
      } catch (err) {
        if (signal.aborted) run.cancelled = true;
        else {
          run.error = run.error ?? `Summary failed: ${(err as Error).message}`;
          run.verdict = verdictFloor(run.findings);
        }
      }
    } else if (!run.verdict) {
      run.verdict = run.files.some((f) => f.status === 'reviewed') ? verdictFloor(run.findings) : null;
    }
    if (!run.summary && run.files.some((f) => f.status === 'reviewed')) {
      const n = run.findings.length;
      run.summary = n ? `${n} finding${n === 1 ? '' : 's'} across ${new Set(run.findings.map((f) => f.path)).size} file${new Set(run.findings.map((f) => f.path)).size === 1 ? '' : 's'}.` : 'No findings.';
    }

    run.finishedAt = new Date().toISOString();
    await this.saveRun(run);
    emit({ phase: run.cancelled ? 'cancelled' : run.error ? 'error' : 'done', path: null, index: total, total, message: run.cancelled ? 'Review cancelled' : run.error ?? 'Review complete' });
    log.info(`AI review ${runId} (${targetKey(run.target)}): ${run.findings.length} finding(s), ${run.droppedInvalid} dropped, ${run.files.filter((f) => f.status === 'reviewed').length}/${run.files.length} files via ${backend.name}/${settings.model}`);
    return run;
  }

  // ---------- posting ----------

  async post(repoPath: string, opts: PostReviewOptions): Promise<{ url: string }> {
    const run = await this.findRun(repoPath, opts.runId);
    if (!run) throw new AiError('The review run was not found. Run the review again.', 'other');
    if (run.target.kind !== 'pr') throw new AiError('Only pull request reviews can be posted to GitHub.', 'other');
    const ref = await this.repos.detectGitHub(repoPath);
    if (!ref) throw new GitError({ message: 'This repository does not have a GitHub remote.', command: '', exitCode: null, stderr: '', stdout: '', code: 'remote-not-found' });
    const refs = await this.gh.prRefs(ref, run.target.number);
    if (refs.headSha !== run.target.headSha) throw new AiError('The pull request was updated since this review ran. Re-review before posting.', 'other');
    if (run.ownPullRequest && opts.event !== 'COMMENT') throw new AiError('GitHub does not allow approving or requesting changes on your own pull request. Post as a comment instead.', 'other');
    const chosen = new Set(opts.findingIds);
    const findings: ReviewFinding[] = run.findings.filter((f) => chosen.has(f.id) && !f.dismissed);
    const login = await this.gh.viewerLogin();
    const payload = buildReviewPayload({ commitId: run.target.headSha, event: opts.event, body: opts.body, findings, footer: this.store.getSettings().ai.reviewPostFooter ? AI_FOOTER(login) : null });
    if (!payload.body && !payload.comments.length && opts.event !== 'APPROVE') throw new AiError('Write a review body or select at least one finding to post.', 'other');
    try {
      return await this.gh.createReview(ref, run.target.number, payload);
    } catch (err) {
      if (err instanceof GitError && /HTTP 422/i.test(err.info.stderr) && payload.comments.length) {
        log.warn('GitHub rejected inline comments (422); retrying with findings in the review body');
        return this.gh.createReview(ref, run.target.number, foldCommentsIntoBody(payload));
      }
      throw err;
    }
  }

  // ---------- pre-commit review (the exact patch the pending commit would apply) ----------

  /** Blob sha of a file's current worktree content, or null when the file no longer exists. Used as the per-file staleness hash. */
  private async blobHash(repoPath: string, path: string): Promise<string | null> {
    const res = await this.git.tryRun(repoPath, ['hash-object', '--', path], { readOnly: true });
    return res ? res.stdout.trim() : null;
  }

  /** Tree hash of a temporary index built from the same selection `createCommit` would stage, isolated from the repository's real index via GIT_INDEX_FILE. */
  private async indexTreeSha(repoPath: string, files: string[], partialPatches: Record<string, string>): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'gitgood-review-index-'));
    const env = { GIT_INDEX_FILE: join(dir, 'index') };
    try {
      if (!(await isUnborn(this.git, repoPath))) await this.git.tryRun(repoPath, ['read-tree', 'HEAD'], { env });
      const whole = files.filter((p) => !Object.prototype.hasOwnProperty.call(partialPatches, p));
      if (whole.length) await this.git.run(repoPath, ['add', '-A', '--', ...whole], { env });
      for (const [path, patch] of Object.entries(partialPatches)) {
        if (!files.includes(path)) continue;
        await this.git.run(repoPath, ['apply', '--cached', '--unidiff-zero', '--whitespace=nowarn', '-'], { stdin: patch, env });
      }
      return (await this.git.stdout(repoPath, ['write-tree'], { env })).trim();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  /** `git ls-files` filtered to test-looking paths near the changed files (see filterNearbyTestPaths), capped at 200. */
  private async nearbyTestFiles(repoPath: string, changedPaths: string[]): Promise<string[]> {
    const res = await this.git.tryRun(repoPath, ['ls-files', '-z', '--', '**/*test*', '**/*spec*'], { readOnly: true });
    if (!res) return [];
    return filterNearbyTestPaths(res.stdout.split('\0').filter(Boolean), changedPaths, 200);
  }

  /** The patch text `createCommit` would apply: `--cached` during a merge (selection is ignored), otherwise the working tree against HEAD (or HEAD~1 while amending), honouring partial selections and untracked files. */
  private async worktreeDiffText(repoPath: string, status: Awaited<ReturnType<typeof getStatus>>, files: string[], partialPatches: Record<string, string>, amend: boolean, merging: boolean): Promise<string> {
    if (merging) {
      const res = await this.git.run(repoPath, ['diff', '--no-color', '--no-ext-diff', '--src-prefix=a/', '--dst-prefix=b/', '-M', '--no-relative', '--unified=3', '--cached', '--', ...files], { readOnly: true, okExitCodes: [1], maxBuffer: 256 * 1024 * 1024 });
      return res.stdout;
    }
    const byPath = new Map(status.files.map((f) => [f.path, f]));
    const included = files.map((p) => byPath.get(p)).filter((f): f is WorkingFile => !!f);
    const baseRef = amend ? ((await this.hasCommit(repoPath, 'HEAD~1')) ? 'HEAD~1' : EMPTY_TREE_SHA) : 'HEAD';
    const { patch } = await getPatchForFiles(this.git, repoPath, included, PRECOMMIT_MAX_PATCH_BYTES, partialPatches, baseRef);
    return patch;
  }

  async startWorktree(repoPath: string, opts: WorktreeReviewOptions, report: (e: AiReviewProgressEvent) => void): Promise<ReviewRun> {
    this.controller?.abort();
    const controller = new AbortController();
    this.controller = controller;
    try {
      return await this.runWorktreeReview(repoPath, opts, report, controller);
    } finally {
      if (this.controller === controller) this.controller = null;
    }
  }

  private async runWorktreeReview(repoPath: string, opts: WorktreeReviewOptions, report: (e: AiReviewProgressEvent) => void, controller: AbortController): Promise<ReviewRun> {
    const signal = controller.signal;
    const runId = newRunId();
    const emit: Reporter = (e) => report({ ...e, repoPath, runId });

    const { backend, settings } = await createBackend(this.store, this.tools);
    emit({ phase: 'preparing', path: null, index: 0, total: 0, message: 'Reading the diff…' });

    const status = await getStatus(this.git, repoPath);
    const merging = status.operation.kind === 'merge' || status.operation.kind === 'cherry-pick' || status.operation.kind === 'revert';
    const partialPatches = merging ? {} : opts.partialPatches;
    const partialPaths = Object.keys(partialPatches).filter((p) => opts.files.includes(p));

    const [diffText, indexSha] = await Promise.all([
      this.worktreeDiffText(repoPath, status, opts.files, partialPatches, opts.amend, merging),
      merging ? this.git.stdout(repoPath, ['write-tree']).then((s) => s.trim()) : this.indexTreeSha(repoPath, opts.files, partialPatches),
    ]);
    const diffs = new Map<string, ParsedDiff>();
    for (const p of parseUnifiedDiffs(diffText)) {
      const key = p.header.newPath ?? p.header.oldPath;
      if (key) diffs.set(key, p);
    }

    const byPath = new Map(status.files.map((f) => [f.path, f]));
    const generated = await this.generatedPaths(repoPath, opts.files);
    const only = opts.only?.length ? new Set(opts.only) : null;
    const previous = opts.rereviewOf ? await this.findRun(repoPath, opts.rereviewOf) : null;
    const prevByPath = new Map((previous?.files ?? []).map((f) => [f.file.path, f]));

    const entries: ReviewFileEntry[] = [];
    for (const path of opts.files) {
      const hash = await this.blobHash(repoPath, path);
      if (only && !only.has(path)) {
        const prev = prevByPath.get(path);
        if (prev) {
          entries.push({ ...prev, hash });
          continue;
        }
      }
      const wf = byPath.get(path);
      const parsed = diffs.get(path);
      const file: CommitFile = { path, oldPath: wf?.oldPath ?? null, status: wf?.status ?? 'modified', additions: null, deletions: null, binary: parsed?.header.isBinary ?? false, lfs: wf?.lfs ?? false };
      entries.push({ file, status: 'pending', reason: null, hash });
    }

    let reviewable = 0;
    for (const entry of entries) {
      if (entry.status !== 'pending') continue;
      const hunks = diffs.get(entry.file.path)?.hunks ?? [];
      const reason = skipReason(entry.file, changedLineCount(hunks), generated) ?? (hunks.length === 0 ? 'no text changes' : null);
      if (reason) {
        entry.status = 'skipped';
        entry.reason = reason;
        continue;
      }
      reviewable++;
      if (reviewable > settings.reviewMaxFiles) {
        entry.status = 'skipped';
        entry.reason = `over the ${settings.reviewMaxFiles}-file limit`;
      }
    }

    const run: ReviewRun = {
      id: runId,
      repoPath,
      target: { kind: 'worktree', paths: [...opts.files], partialPaths, indexSha },
      startedAt: new Date().toISOString(),
      finishedAt: null,
      model: settings.model,
      provider: backend.name,
      effort: settings.effort,
      strictness: settings.reviewStrictness,
      summary: '',
      verdict: null,
      findings: only ? (previous?.findings.filter((f) => !only.has(f.path)) ?? []) : [],
      files: entries,
      droppedInvalid: only ? (previous?.droppedInvalid ?? 0) : 0,
      error: null,
      cancelled: false,
      ownPullRequest: false,
      commitMessageMatches: null,
      commitMessageNote: '',
    };

    const context: PrecommitPromptContext = {
      branch: status.branch.name,
      summary: opts.summary,
      description: opts.description,
      amend: opts.amend,
      merging,
      guidelines: await this.guidelines(repoPath),
      nearbyTestFiles: await this.nearbyTestFiles(repoPath, opts.files),
    };
    const system = precommitReviewSystemPrompt(settings.reviewStrictness);

    const pending = run.files.filter((f) => f.status === 'pending');
    const total = pending.length;
    const fileSummaries: { path: string; summary: string }[] = [];
    let done = 0;
    const reviewOne = async (entry: ReviewFileEntry) => {
      const path = entry.file.path;
      const parsed = diffs.get(path)!;
      emit({ phase: 'file', path, index: done + 1, total, message: `Reviewing ${done + 1} of ${total}: ${path}` });
      try {
        const excerpt = await this.worktreeExcerpt(repoPath, path, parsed);
        const response = await backend.complete({
          system,
          prompt: buildPrecommitFilePrompt({ context, path, oldPath: entry.file.oldPath, status: entry.file.status, language: languageFromPath(path), annotatedDiff: annotateHunks(parsed.hunks), contextExcerpt: excerpt, partial: partialPaths.includes(path), truncated: false }),
          schema: REVIEW_FILE_SCHEMA as unknown as Record<string, unknown>,
          model: settings.model,
          effort: settings.effort,
          signal,
        });
        const { findings, dropped } = validateFindings(response.json, path, parsed.hunks, settings.reviewStrictness);
        run.findings.push(...findings);
        run.droppedInvalid += dropped;
        const summary = (response.json as { fileSummary?: unknown })?.fileSummary;
        fileSummaries.push({ path, summary: typeof summary === 'string' ? summary : '' });
        entry.status = 'reviewed';
      } catch (err) {
        if (signal.aborted) {
          entry.status = 'cancelled';
          entry.reason = 'cancelled';
          return;
        }
        entry.status = 'failed';
        entry.reason = err instanceof Error ? err.message : String(err);
        if (err instanceof AiError && (err.kind === 'auth' || err.kind === 'not-configured' || err.kind === 'rate-limit')) throw err;
        log.warn(`Pre-commit review of ${path} failed: ${entry.reason}`);
      } finally {
        done++;
      }
    };

    let fatal: Error | null = null;
    let index = 0;
    const worker = async () => {
      while (index < pending.length && !signal.aborted && !fatal) {
        const entry = pending[index++];
        try {
          await reviewOne(entry);
        } catch (err) {
          fatal = err as Error;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, pending.length) }, worker));
    for (const entry of run.files) {
      if (entry.status === 'pending') {
        entry.status = 'cancelled';
        entry.reason = signal.aborted ? 'cancelled' : 'not started';
      }
    }

    run.findings = run.findings.sort(compareFindings);
    run.cancelled = signal.aborted;
    if (fatal) run.error = (fatal as Error).message;

    if (!signal.aborted && !fatal && run.files.some((f) => f.status === 'reviewed')) {
      emit({ phase: 'summarizing', path: null, index: total, total, message: 'Writing the summary…' });
      try {
        const response = await backend.complete({
          system: PRECOMMIT_SUMMARY_SYSTEM_PROMPT,
          prompt: buildPrecommitSummaryPrompt(
            context,
            fileSummaries,
            run.findings.map((f) => ({ path: f.path, line: f.line, severity: f.severity, title: f.title })),
            run.files.filter((f) => f.status === 'skipped').length,
            run.droppedInvalid,
          ),
          schema: PRECOMMIT_SUMMARY_SCHEMA as unknown as Record<string, unknown>,
          model: settings.model,
          effort: settings.effort === 'max' ? 'high' : settings.effort,
          signal,
        });
        const json = response.json as { summary?: unknown; verdict?: unknown; commitMessageMatches?: unknown; commitMessageNote?: unknown };
        run.summary = typeof json.summary === 'string' ? json.summary.trim() : '';
        const floor = verdictFloor(run.findings);
        const modelVerdict = json.verdict === 'approve' || json.verdict === 'comment' || json.verdict === 'request-changes' ? (json.verdict as ReviewVerdict) : floor;
        run.verdict = stricter(modelVerdict, floor);
        run.commitMessageMatches = typeof json.commitMessageMatches === 'boolean' ? json.commitMessageMatches : null;
        run.commitMessageNote = json.commitMessageMatches === false && typeof json.commitMessageNote === 'string' ? json.commitMessageNote.trim().slice(0, 300) : '';
      } catch (err) {
        if (signal.aborted) run.cancelled = true;
        else {
          run.error = run.error ?? `Summary failed: ${(err as Error).message}`;
          run.verdict = verdictFloor(run.findings);
        }
      }
    } else if (!run.verdict) {
      run.verdict = run.files.some((f) => f.status === 'reviewed') ? verdictFloor(run.findings) : null;
    }
    if (!run.summary && run.files.some((f) => f.status === 'reviewed')) {
      const n = run.findings.length;
      run.summary = n ? `${n} finding${n === 1 ? '' : 's'} across ${new Set(run.findings.map((f) => f.path)).size} file${new Set(run.findings.map((f) => f.path)).size === 1 ? '' : 's'}.` : 'No findings.';
    }

    run.finishedAt = new Date().toISOString();
    await this.saveRun(run);
    emit({ phase: run.cancelled ? 'cancelled' : run.error ? 'error' : 'done', path: null, index: total, total, message: run.cancelled ? 'Review cancelled' : run.error ?? 'Review complete' });
    log.info(`AI pre-commit review ${runId}: ${run.findings.length} finding(s), ${run.droppedInvalid} dropped, ${run.files.filter((f) => f.status === 'reviewed').length}/${run.files.length} files via ${backend.name}/${settings.model}`);
    return run;
  }

  /** Paths whose recorded content hash no longer matches the file's current content (edited or deleted since the review ran). */
  async worktreeStale(repoPath: string, runId: string): Promise<string[]> {
    const run = await this.findRun(repoPath, runId);
    if (!run || run.target.kind !== 'worktree') return [];
    const stale: string[] = [];
    for (const entry of run.files) {
      if (entry.hash === null) continue;
      const current = await this.blobHash(repoPath, entry.file.path);
      if (current !== entry.hash) stale.push(entry.file.path);
    }
    return stale;
  }

  /** Writes a finding's suggestion into the working tree, replacing [line, endLine] and preserving the file's line endings. Refuses when the file changed since the review or the file was partially selected. */
  async applySuggestion(repoPath: string, runId: string, findingId: string): Promise<void> {
    const run = await this.findRun(repoPath, runId);
    if (!run) throw new AiError('The review run was not found. Run the review again.', 'other');
    if (run.target.kind !== 'worktree') throw new AiError('Applying a suggestion is only available for the pre-commit review.', 'other');
    const finding = run.findings.find((f) => f.id === findingId);
    if (!finding) throw new AiError('This finding is no longer part of the review.', 'other');
    if (finding.suggestion === null) throw new AiError('This finding has no suggested replacement.', 'other');
    if (run.target.partialPaths.includes(finding.path)) throw new AiError('This file is only partially selected for the commit; adjust the selection or re-review before applying.', 'other');
    const entry = run.files.find((f) => f.file.path === finding.path);
    const recordedHash = entry?.hash ?? null;
    const currentHash = await this.blobHash(repoPath, finding.path);
    if (recordedHash === null || currentHash === null || currentHash !== recordedHash) {
      throw new AiError('The file changed since the review ran. Re-review before applying.', 'other');
    }
    const fsPath = toFsPath(repoPath, finding.path);
    const content = await readFile(fsPath, 'utf8');
    const next = replaceLinesInContent(content, finding.line, finding.endLine ?? finding.line, finding.suggestion);
    await writeFile(fsPath, next, 'utf8');
    if (entry) entry.hash = await this.blobHash(repoPath, finding.path);
    await this.saveRun(run);
  }
}

const VERDICT_RANK: Record<ReviewVerdict, number> = { approve: 0, comment: 1, 'request-changes': 2 };

function stricter(a: ReviewVerdict, b: ReviewVerdict): ReviewVerdict {
  return VERDICT_RANK[a] >= VERDICT_RANK[b] ? a : b;
}
