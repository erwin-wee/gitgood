import type { CheckRun, CreateIssueOptions, CreatePullRequestOptions, CreateReleaseOptions, GitHubAccount, GitHubRepoDetails, GitHubRepoRef, GitHubRepoSummary, Issue, IssueComment, IssueDetail, IssueFilter, PublishOptions, PullRequest, PullRequestChecksSummary } from '@shared/types';
import { ExecError, exec, type ExecResult } from '../exec';
import { GitError, toGitErrorInfo } from '../git/git';
import { log } from '../logger';
import type { ToolLocator } from '../tools';

interface GhRunOptions {
  cwd?: string;
  stdin?: string;
  signal?: AbortSignal;
  onStderr?: (chunk: string) => void;
  onStdout?: (chunk: string) => void;
  timeoutMs?: number;
  okExitCodes?: number[];
}

type RawRollup = { __typename?: string; status?: string; conclusion?: string; state?: string; name?: string; context?: string };

interface RawPr {
  number: number;
  title: string;
  url: string;
  author?: { login?: string };
  headRefName: string;
  baseRefName: string;
  headRefOid?: string;
  headRepository?: { name?: string } | null;
  headRepositoryOwner?: { login?: string } | null;
  isCrossRepository?: boolean;
  isDraft?: boolean;
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  createdAt: string;
  updatedAt: string;
  statusCheckRollup?: RawRollup[] | null;
  reviewDecision?: string | null;
  body?: string;
  additions?: number;
  deletions?: number;
  changedFiles?: number;
  mergeable?: string;
  mergeStateStatus?: string;
  labels?: { name: string }[];
  assignees?: { login: string }[];
  reviewRequests?: { login?: string; name?: string }[];
  commits?: unknown[];
  files?: { path?: string; additions?: number; deletions?: number }[];
  reviews?: unknown[];
  latestReviews?: { author?: { login?: string }; state?: string }[];
  comments?: unknown[];
}

const PR_FIELDS = 'number,title,url,author,headRefName,baseRefName,headRefOid,headRepository,headRepositoryOwner,isCrossRepository,isDraft,state,createdAt,updatedAt,statusCheckRollup,reviewDecision,body,additions,deletions,changedFiles,mergeable,mergeStateStatus,labels,assignees,reviewRequests,commits,files,reviews,latestReviews,comments';

const ISSUE_FIELDS = 'number,title,url,state,author,labels,assignees,milestone,createdAt,updatedAt,comments,body';

interface RawIssue {
  number: number;
  title: string;
  url: string;
  state: 'OPEN' | 'CLOSED';
  author?: { login?: string };
  labels?: { name: string; color: string }[];
  assignees?: { login: string }[];
  milestone?: { title?: string } | null;
  createdAt: string;
  updatedAt: string;
  comments?: number | { totalCount?: number }[];
  commentsCount?: number;
  body?: string;
}

interface RawIssueComment {
  author?: { login?: string };
  createdAt: string;
  body?: string;
  url: string;
}

function toIssue(raw: RawIssue): Issue {
  const commentsCount = typeof raw.comments === 'number' ? raw.comments : Array.isArray(raw.comments) ? raw.comments.length : (raw.commentsCount ?? 0);
  return {
    number: raw.number,
    title: raw.title,
    url: raw.url,
    state: raw.state,
    author: raw.author?.login ?? 'unknown',
    labels: (raw.labels ?? []).map((l) => ({ name: l.name, color: l.color })),
    assignees: (raw.assignees ?? []).map((a) => a.login),
    milestone: raw.milestone?.title ?? null,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
    commentsCount,
    body: raw.body ?? '',
  };
}

function toIssueComment(raw: RawIssueComment): IssueComment {
  return { author: raw.author?.login ?? 'unknown', createdAt: raw.createdAt, body: raw.body ?? '', url: raw.url };
}

/**
 * Builds the argument list for `gh issue list` from an IssueFilter. Pure so
 * the argument shape can be unit tested without spawning `gh`.
 * `beforeUpdatedAt`, when given, narrows to issues updated strictly before
 * that ISO timestamp (used for "Load more": further pages beyond gh's
 * 100-item cap are fetched via a `updated:<...` search qualifier).
 */
export function buildIssueListArgs(selector: string, filter: IssueFilter, beforeUpdatedAt?: string | null): string[] {
  const args = ['issue', 'list', '--repo', selector, '--state', filter.state, '--limit', '100'];
  const searchParts: string[] = [];
  if (filter.search.trim()) searchParts.push(filter.search.trim());
  searchParts.push('sort:updated-desc');
  if (beforeUpdatedAt) searchParts.push(`updated:<${beforeUpdatedAt}`);
  args.push('--search', searchParts.join(' '));
  if (filter.assignee === 'me') args.push('--assignee', '@me');
  if (filter.author === 'me') args.push('--author', '@me');
  if (filter.mentioned) args.push('--mention', '@me');
  if (filter.labels.length) args.push('--label', filter.labels.join(','));
  if (filter.milestone) args.push('--milestone', filter.milestone);
  args.push('--json', ISSUE_FIELDS);
  return args;
}

export function summarizeChecks(rollup: RawRollup[] | null | undefined): PullRequestChecksSummary {
  const summary: PullRequestChecksSummary = { total: 0, passed: 0, failed: 0, pending: 0, skipped: 0, state: 'none' };
  for (const c of rollup ?? []) {
    summary.total++;
    if (c.__typename === 'StatusContext' || c.state !== undefined) {
      const s = (c.state ?? '').toUpperCase();
      if (s === 'SUCCESS') summary.passed++;
      else if (s === 'FAILURE' || s === 'ERROR') summary.failed++;
      else summary.pending++;
      continue;
    }
    const status = (c.status ?? '').toUpperCase();
    const conclusion = (c.conclusion ?? '').toUpperCase();
    if (status !== 'COMPLETED') summary.pending++;
    else if (conclusion === 'SUCCESS' || conclusion === 'NEUTRAL') summary.passed++;
    else if (conclusion === 'SKIPPED') summary.skipped++;
    else summary.failed++;
  }
  if (summary.total === 0) summary.state = 'none';
  else if (summary.failed > 0) summary.state = 'failure';
  else if (summary.pending > 0) summary.state = 'pending';
  else summary.state = 'success';
  return summary;
}

export function toPullRequest(raw: RawPr): PullRequest {
  const headOwner = raw.headRepositoryOwner?.login;
  const headName = raw.headRepository?.name;
  return {
    number: raw.number,
    title: raw.title,
    url: raw.url,
    author: raw.author?.login ?? 'unknown',
    headRefName: raw.headRefName,
    baseRefName: raw.baseRefName,
    headSha: raw.headRefOid ?? null,
    headRepo: headOwner && headName ? `${headOwner}/${headName}` : null,
    isCrossRepository: raw.isCrossRepository ?? false,
    isDraft: raw.isDraft ?? false,
    state: raw.state,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
    checks: summarizeChecks(raw.statusCheckRollup),
    reviewDecision: raw.reviewDecision ?? null,
    body: raw.body ?? '',
    additions: raw.additions ?? null,
    deletions: raw.deletions ?? null,
    changedFiles: raw.changedFiles ?? null,
    mergeable: raw.mergeable ?? null,
    mergeStateStatus: raw.mergeStateStatus ?? null,
    labels: (raw.labels ?? []).map((l) => l.name),
    assignees: (raw.assignees ?? []).map((a) => a.login),
    reviewRequests: (raw.reviewRequests ?? []).map((r) => r.login ?? r.name ?? '').filter(Boolean),
    commitsCount: Array.isArray(raw.commits) ? raw.commits.length : 0,
    filesChanged: (raw.files ?? []).filter((f) => f.path).map((f) => ({ path: f.path!, additions: f.additions ?? 0, deletions: f.deletions ?? 0 })),
    reviewsCount: Array.isArray(raw.reviews) ? raw.reviews.length : 0,
    latestReviews: (raw.latestReviews ?? []).map((r) => ({ author: r.author?.login ?? 'unknown', state: r.state ?? '' })),
    commentsCount: Array.isArray(raw.comments) ? raw.comments.length : 0,
  };
}

/** True when gh's error text is GitHub's primary or secondary API rate limit response. */
export function isRateLimitError(text: string): boolean {
  return /API rate limit exceeded|secondary rate limit/i.test(text);
}

/**
 * Extracts a rate-limit reset time from gh's error text, when present: an
 * explicit `X-RateLimit-Reset` header value, an ISO timestamp, or a relative
 * "in N minutes/seconds/hours" phrase (resolved against `now`). Pure so it
 * can be unit tested against sample stderr without spawning `gh`.
 */
export function parseRateLimitReset(text: string, now: number = Date.now()): string | null {
  const headerEpoch = /X-RateLimit-Reset:\s*(\d{9,13})/i.exec(text);
  if (headerEpoch) {
    const n = Number(headerEpoch[1]);
    return new Date(headerEpoch[1].length > 10 ? n : n * 1000).toISOString();
  }
  const iso = /\b(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)\b/.exec(text);
  if (iso) return new Date(iso[1]).toISOString();
  const relative = /in\s+(\d+)\s*(second|minute|hour)s?/i.exec(text);
  if (relative) {
    const n = Number(relative[1]);
    const unitMs = relative[2].toLowerCase() === 'second' ? 1000 : relative[2].toLowerCase() === 'minute' ? 60000 : 3600000;
    return new Date(now + n * unitMs).toISOString();
  }
  return null;
}

export function repoSelector(ref: GitHubRepoRef): string {
  return ref.host === 'github.com' ? `${ref.owner}/${ref.name}` : `${ref.host}/${ref.owner}/${ref.name}`;
}

// ---------------------------------------------------------------------------
// Settings sync (gists)
// ---------------------------------------------------------------------------

interface RawGist {
  id: string;
  description?: string | null;
  updated_at?: string;
}

/** Finds the gist matching `description` in a `gh api gists --paginate` listing. Pure so it can be unit tested without spawning `gh`. */
export function findGistByDescription(gists: RawGist[], description: string): { id: string; updatedAt: string } | null {
  const match = gists.find((g) => g.description === description);
  return match ? { id: match.id, updatedAt: match.updated_at ?? '' } : null;
}

/** True when a gist API call's error is a 404 (gist deleted, or never existed). Pure so it can be unit tested against canned stderr. */
export function isGistNotFound(info: { exitCode: number | null; stderr: string }): boolean {
  return info.exitCode !== 0 && /HTTP 404|Not Found|could not find gist/i.test(info.stderr);
}

/** One `HTTP/… <status>` response as printed by `gh api --include` (status line, headers, blank line, body). */
export interface HttpBlock {
  status: number;
  /** Header names lower-cased (HTTP headers are case-insensitive). */
  headers: Record<string, string>;
  body: string;
}

/**
 * Parses the raw output of `gh api --include`: a status line, headers, a
 * blank line and a body, repeated back to back once per page when combined
 * with `--paginate`. Pure so it can be unit tested against canned text
 * without spawning `gh`.
 */
export function parseHttpBlocks(text: string): HttpBlock[] {
  const lines = text.split(/\r?\n/);
  const blocks: HttpBlock[] = [];
  let i = 0;
  while (i < lines.length) {
    const statusMatch = /^HTTP\/[\d.]+\s+(\d{3})/.exec(lines[i]);
    if (!statusMatch) {
      i++;
      continue;
    }
    const status = Number(statusMatch[1]);
    i++;
    const headers: Record<string, string> = {};
    while (i < lines.length && lines[i].trim() !== '') {
      const h = /^([^:]+):\s*(.*)$/.exec(lines[i]);
      if (h) headers[h[1].trim().toLowerCase()] = h[2].trim();
      i++;
    }
    i++; // skip the blank line separating headers from the body
    const bodyLines: string[] = [];
    while (i < lines.length && !/^HTTP\/[\d.]+\s+\d{3}/.test(lines[i])) {
      bodyLines.push(lines[i]);
      i++;
    }
    blocks.push({ status, headers, body: bodyLines.join('\n').trim() });
  }
  return blocks;
}

export class GhClient {
  private loginProcess: AbortController | null = null;
  private avatarCache = new Map<string, string | null>();

  constructor(private readonly tools: ToolLocator) {}

  async run(args: string[], opts: GhRunOptions = {}): Promise<ExecResult> {
    await this.tools.ensureLocated();
    const gh = this.tools.ghPath();
    const env = await this.tools.ghEnv();
    try {
      return await exec(gh, args, { cwd: opts.cwd, env, stdin: opts.stdin, signal: opts.signal, onStderr: opts.onStderr, onStdout: opts.onStdout, timeoutMs: opts.timeoutMs ?? 120000, okExitCodes: opts.okExitCodes });
    } catch (err) {
      const info = toGitErrorInfo(err, `gh ${args.join(' ')}`);
      if (err instanceof ExecError && /not logged into any GitHub hosts|authentication required|gh auth login|HTTP 401|Bad credentials/i.test(err.result.stderr)) {
        info.code = 'gh-not-authenticated';
        info.message = 'You are not signed in to GitHub. Sign in from Options → Accounts.';
      } else if (err instanceof ExecError && isRateLimitError(err.result.stderr)) {
        info.code = 'rate-limited';
        info.rateLimitResetAt = parseRateLimitReset(err.result.stderr);
      } else if (info.code === 'unknown' && /Could not resolve host|dial tcp|i\/o timeout|connection refused|no such host/i.test(info.stderr)) {
        info.code = 'network';
      }
      log.warn(`gh ${args.slice(0, 3).join(' ')} failed: ${info.message.split('\n')[0]}`);
      throw new GitError(info);
    }
  }

  async json<T>(args: string[], opts: GhRunOptions = {}): Promise<T> {
    const res = await this.run(args, opts);
    const text = res.stdout.trim();
    if (!text) return null as unknown as T;
    try {
      return JSON.parse(text) as T;
    } catch (err) {
      throw new GitError({ message: `Unexpected output from gh: ${text.slice(0, 200)}`, command: res.command, exitCode: res.exitCode, stderr: res.stderr, stdout: res.stdout, code: 'unknown' });
    }
  }

  // ---------- auth ----------

  /**
   * Runs a device-flow command (`auth login` or `auth refresh`), reporting
   * the one-time code through onCode as soon as gh prints it. Shared by
   * `login` and `refreshScopes`, which only differ in the command line.
   */
  private async runDeviceFlow(args: string[], host: string, onCode: (code: string, url: string) => void): Promise<{ ok: boolean; error: string | null }> {
    this.cancelLogin();
    const controller = new AbortController();
    this.loginProcess = controller;
    let codeSent = false;
    let stderr = '';
    const handleOutput = (chunk: string) => {
      stderr += chunk;
      if (codeSent) return;
      const code = /\b([A-Z0-9]{4}-[A-Z0-9]{4})\b/.exec(chunk);
      if (code) {
        codeSent = true;
        const url = /https?:\/\/\S+\/login\/device\S*/.exec(stderr)?.[0] ?? `https://${host}/login/device`;
        onCode(code[1], url);
      }
    };
    try {
      await this.run(args, { signal: controller.signal, onStderr: handleOutput, onStdout: handleOutput, timeoutMs: 20 * 60 * 1000 });
      return { ok: true, error: null };
    } catch (err) {
      const info = toGitErrorInfo(err);
      if (info.code === 'cancelled') return { ok: false, error: null };
      return { ok: false, error: info.message };
    } finally {
      if (this.loginProcess === controller) this.loginProcess = null;
    }
  }

  /**
   * Runs the browser device flow. The one-time code is reported through onCode
   * as soon as gh prints it; the promise resolves when the flow completes.
   */
  async login(host: string, onCode: (code: string, url: string) => void): Promise<{ ok: boolean; error: string | null }> {
    const result = await this.runDeviceFlow(['auth', 'login', '--web', '--hostname', host, '--git-protocol', 'https', '--skip-ssh-key'], host, onCode);
    if (result.ok) {
      try {
        await this.run(['auth', 'setup-git', '--hostname', host], { timeoutMs: 30000 });
      } catch (err) {
        log.warn(`gh auth setup-git failed: ${(err as Error).message}`);
      }
    }
    return result;
  }

  /**
   * Requests additional OAuth scopes for an already-signed-in host through
   * the same device flow as `login` (used to grant the `notifications`
   * scope from the Inbox panel without signing out first).
   */
  async refreshScopes(host: string, scopes: string[], onCode: (code: string, url: string) => void): Promise<{ ok: boolean; error: string | null }> {
    return this.runDeviceFlow(['auth', 'refresh', '--hostname', host, '-s', scopes.join(',')], host, onCode);
  }

  cancelLogin(): void {
    this.loginProcess?.abort();
    this.loginProcess = null;
  }

  async logout(host: string): Promise<void> {
    await this.run(['auth', 'logout', '--hostname', host], { okExitCodes: [1] });
  }

  async setupGit(): Promise<void> {
    await this.run(['auth', 'setup-git'], { timeoutMs: 30000 });
  }

  async account(): Promise<GitHubAccount | null> {
    return (await this.tools.refresh()).ghAccount;
  }

  // ---------- repositories ----------

  async viewerRepositories(): Promise<GitHubRepoSummary[]> {
    const query = `query($cursor: String) {
      viewer {
        repositories(first: 100, after: $cursor, affiliations: [OWNER, COLLABORATOR, ORGANIZATION_MEMBER], ownerAffiliations: [OWNER, COLLABORATOR, ORGANIZATION_MEMBER], orderBy: {field: PUSHED_AT, direction: DESC}) {
          pageInfo { hasNextPage endCursor }
          nodes { nameWithOwner name url isPrivate isFork description pushedAt owner { login avatarUrl } defaultBranchRef { name } }
        }
      }
    }`;
    const repos: GitHubRepoSummary[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 20; page++) {
      const args = ['api', 'graphql', '-f', `query=${query}`];
      if (cursor) args.push('-F', `cursor=${cursor}`);
      const data: { data?: { viewer?: { repositories?: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: { nameWithOwner: string; name: string; url: string; isPrivate: boolean; isFork: boolean; description: string | null; pushedAt: string | null; owner: { login: string; avatarUrl: string | null }; defaultBranchRef: { name: string } | null }[] } } } } = await this.json(args, { timeoutMs: 120000 });
      const conn = data?.data?.viewer?.repositories;
      if (!conn) break;
      for (const n of conn.nodes) {
        repos.push({
          nameWithOwner: n.nameWithOwner,
          name: n.name,
          owner: n.owner.login,
          ownerAvatar: n.owner.avatarUrl,
          url: n.url,
          cloneUrl: `${n.url}.git`,
          isPrivate: n.isPrivate,
          isFork: n.isFork,
          description: n.description,
          defaultBranch: n.defaultBranchRef?.name ?? null,
          pushedAt: n.pushedAt,
        });
      }
      if (!conn.pageInfo.hasNextPage) break;
      cursor = conn.pageInfo.endCursor;
    }
    return repos;
  }

  async organizations(): Promise<string[]> {
    const res = await this.run(['api', 'user/orgs', '--paginate', '--jq', '.[].login'], { timeoutMs: 60000 });
    return res.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
  }

  async repoView(ref: GitHubRepoRef): Promise<GitHubRepoDetails | null> {
    try {
      const raw = await this.json<{ nameWithOwner: string; url: string; defaultBranchRef: { name: string } | null; isPrivate: boolean; isFork: boolean; parent: { nameWithOwner: string } | null; description: string | null; viewerCanAdminister: boolean; hasIssuesEnabled: boolean }>(
        ['repo', 'view', repoSelector(ref), '--json', 'nameWithOwner,url,defaultBranchRef,isPrivate,isFork,parent,description,viewerCanAdminister,hasIssuesEnabled'],
        { timeoutMs: 60000 },
      );
      if (!raw) return null;
      return {
        nameWithOwner: raw.nameWithOwner,
        url: raw.url,
        defaultBranch: raw.defaultBranchRef?.name ?? null,
        isPrivate: raw.isPrivate,
        isFork: raw.isFork,
        parent: raw.parent?.nameWithOwner ?? null,
        description: raw.description,
        viewerCanAdminister: raw.viewerCanAdminister,
        hasIssuesEnabled: raw.hasIssuesEnabled,
      };
    } catch (err) {
      if (err instanceof GitError && (err.info.code === 'remote-not-found' || /Could not resolve to a Repository|HTTP 404/i.test(err.info.stderr))) return null;
      throw err;
    }
  }

  async publish(repoPath: string, opts: PublishOptions, hasCommits: boolean): Promise<GitHubRepoRef> {
    const name = opts.organization ? `${opts.organization}/${opts.name}` : opts.name;
    const args = ['repo', 'create', name, opts.isPrivate ? '--private' : '--public', '--source', repoPath, '--remote', 'origin'];
    if (hasCommits) args.push('--push');
    if (opts.description) args.push('--description', opts.description);
    const res = await this.run(args, { cwd: repoPath, timeoutMs: 10 * 60 * 1000 });
    const url = /https?:\/\/\S+/.exec(res.stdout + res.stderr)?.[0] ?? '';
    const m = /https?:\/\/([^/]+)\/([^/]+)\/([^/\s]+)/.exec(url);
    if (!m) throw new GitError({ message: 'Repository created but its URL could not be determined.', command: res.command, exitCode: res.exitCode, stderr: res.stderr, stdout: res.stdout, code: 'unknown' });
    return { host: m[1], owner: m[2], name: m[3].replace(/\.git$/, ''), url: `https://${m[1]}/${m[2]}/${m[3].replace(/\.git$/, '')}` };
  }

  async fork(repoPath: string): Promise<GitHubRepoRef> {
    const res = await this.run(['repo', 'fork', '--remote=true', '--remote-name', 'fork'], { cwd: repoPath, timeoutMs: 5 * 60 * 1000 });
    const m = /https?:\/\/([^/]+)\/([^/]+)\/([^/\s]+)/.exec(res.stdout + res.stderr);
    if (!m) throw new GitError({ message: 'Fork created but its URL could not be determined.', command: res.command, exitCode: res.exitCode, stderr: res.stderr, stdout: res.stdout, code: 'unknown' });
    return { host: m[1], owner: m[2], name: m[3].replace(/\.git$/, ''), url: `https://${m[1]}/${m[2]}/${m[3].replace(/\.git$/, '')}` };
  }

  // ---------- pull requests ----------

  async prList(ref: GitHubRepoRef, state: 'open' | 'closed' | 'merged' | 'all'): Promise<PullRequest[]> {
    const raw = await this.json<RawPr[]>(['pr', 'list', '--repo', repoSelector(ref), '--state', state, '--limit', '100', '--json', PR_FIELDS], { timeoutMs: 120000 });
    return (raw ?? []).map(toPullRequest);
  }

  async prForBranch(ref: GitHubRepoRef, branch: string): Promise<PullRequest | null> {
    const raw = await this.json<RawPr[]>(['pr', 'list', '--repo', repoSelector(ref), '--head', branch, '--state', 'all', '--limit', '5', '--json', PR_FIELDS], { timeoutMs: 60000 });
    const prs = (raw ?? []).map(toPullRequest);
    return prs.find((p) => p.state === 'OPEN') ?? prs[0] ?? null;
  }

  async prView(ref: GitHubRepoRef, number: number): Promise<PullRequest> {
    const raw = await this.json<RawPr>(['pr', 'view', String(number), '--repo', repoSelector(ref), '--json', PR_FIELDS], { timeoutMs: 60000 });
    return toPullRequest(raw);
  }

  async prChecks(ref: GitHubRepoRef, number: number): Promise<CheckRun[]> {
    const raw = await this.json<{ name: string; state: string; bucket: CheckRun['bucket']; link: string; workflow: string; description: string; startedAt: string; completedAt: string }[]>(
      ['pr', 'checks', String(number), '--repo', repoSelector(ref), '--json', 'name,state,bucket,link,workflow,description,startedAt,completedAt'],
      { timeoutMs: 60000, okExitCodes: [8] },
    );
    return (raw ?? []).map((c) => ({ name: c.name, state: c.state, bucket: c.bucket, link: c.link, workflow: c.workflow, description: c.description, startedAt: c.startedAt || null, completedAt: c.completedAt || null }));
  }

  async prCheckout(repoPath: string, number: number): Promise<void> {
    await this.run(['pr', 'checkout', String(number)], { cwd: repoPath, timeoutMs: 10 * 60 * 1000 });
  }

  async prCreate(repoPath: string, opts: CreatePullRequestOptions): Promise<{ url: string | null }> {
    const args = ['pr', 'create', '--base', opts.base, '--head', opts.head];
    if (opts.web) {
      args.push('--web');
      if (opts.title) args.push('--title', opts.title);
      if (opts.body) args.push('--body', opts.body);
      await this.run(args, { cwd: repoPath, timeoutMs: 60000 });
      return { url: null };
    }
    args.push('--title', opts.title, '--body-file', '-');
    if (opts.draft) args.push('--draft');
    const res = await this.run(args, { cwd: repoPath, stdin: opts.body, timeoutMs: 120000 });
    return { url: /https?:\/\/\S+\/pull\/\d+/.exec(res.stdout + res.stderr)?.[0] ?? null };
  }

  async prMerge(ref: GitHubRepoRef, number: number, method: 'merge' | 'squash' | 'rebase', deleteBranch: boolean): Promise<void> {
    const args = ['pr', 'merge', String(number), '--repo', repoSelector(ref), `--${method}`];
    if (deleteBranch) args.push('--delete-branch');
    await this.run(args, { timeoutMs: 120000 });
  }

  async prReady(ref: GitHubRepoRef, number: number, ready: boolean): Promise<void> {
    await this.run(['pr', 'ready', String(number), '--repo', repoSelector(ref), ...(ready ? [] : ['--undo'])]);
  }

  async prClose(ref: GitHubRepoRef, number: number): Promise<void> {
    await this.run(['pr', 'close', String(number), '--repo', repoSelector(ref)]);
  }

  async prReopen(ref: GitHubRepoRef, number: number): Promise<void> {
    await this.run(['pr', 'reopen', String(number), '--repo', repoSelector(ref)]);
  }

  async prReview(ref: GitHubRepoRef, number: number, action: 'approve' | 'comment' | 'request-changes', body: string): Promise<void> {
    const args = ['pr', 'review', String(number), '--repo', repoSelector(ref), `--${action}`];
    if (body.trim() || action !== 'approve') args.push('--body-file', '-');
    await this.run(args, { stdin: body });
  }

  async prComment(ref: GitHubRepoRef, number: number, body: string): Promise<void> {
    await this.run(['pr', 'comment', String(number), '--repo', repoSelector(ref), '--body-file', '-'], { stdin: body });
  }

  /** Raw unified diff of a pull request, as GitHub computes it (merge-base to head). */
  async prDiff(ref: GitHubRepoRef, number: number, signal?: AbortSignal): Promise<string> {
    const res = await this.run(['pr', 'diff', String(number), '--repo', repoSelector(ref), '--color', 'never'], { timeoutMs: 5 * 60 * 1000, signal });
    return res.stdout;
  }

  /** Head/base SHAs and commit subjects for a pull request. */
  async prRefs(ref: GitHubRepoRef, number: number): Promise<{ headSha: string; baseSha: string; commitSubjects: string[] }> {
    const raw = await this.json<{ headRefOid?: string; baseRefOid?: string; commits?: { messageHeadline?: string }[] }>(['pr', 'view', String(number), '--repo', repoSelector(ref), '--json', 'headRefOid,baseRefOid,commits'], { timeoutMs: 60000 });
    if (!raw?.headRefOid || !raw.baseRefOid) throw new GitError({ message: `Could not read the head and base commits of pull request #${number}.`, command: 'gh pr view', exitCode: null, stderr: '', stdout: '', code: 'unknown' });
    return { headSha: raw.headRefOid, baseSha: raw.baseRefOid, commitSubjects: (raw.commits ?? []).map((c) => c.messageHeadline ?? '').filter(Boolean) };
  }

  /** Title, body and state of one issue, or null when it cannot be read (including when signed out — never attempts the call in that case). */
  async issueView(ref: GitHubRepoRef, number: number): Promise<{ number: number; title: string; body: string; state: 'OPEN' | 'CLOSED' } | null> {
    if (!this.tools.current().ghAccount) return null;
    try {
      const raw = await this.json<{ title?: string; body?: string; state?: string }>(['issue', 'view', String(number), '--repo', repoSelector(ref), '--json', 'title,body,state'], { timeoutMs: 30000 });
      return raw ? { number, title: raw.title ?? '', body: raw.body ?? '', state: raw.state === 'CLOSED' ? 'CLOSED' : 'OPEN' } : null;
    } catch {
      return null;
    }
  }

  // ---------- issues ----------

  /**
   * Lists issues matching `filter`. `beforeUpdatedAt` (an ISO timestamp of
   * the oldest issue already shown) fetches the next page, since `gh issue
   * list` caps at 100 results and has no cursor of its own.
   */
  async issueList(selector: string, filter: IssueFilter, beforeUpdatedAt?: string | null): Promise<Issue[]> {
    const raw = await this.json<RawIssue[]>(buildIssueListArgs(selector, filter, beforeUpdatedAt), { timeoutMs: 60000 });
    return (raw ?? []).map(toIssue);
  }

  async issueDetail(selector: string, number: number): Promise<IssueDetail> {
    const raw = await this.json<Omit<RawIssue, 'comments'> & { comments?: RawIssueComment[] }>(['issue', 'view', String(number), '--repo', selector, '--json', ISSUE_FIELDS], { timeoutMs: 30000 });
    const comments = Array.isArray(raw.comments) ? raw.comments : [];
    return { ...toIssue({ ...raw, comments: comments.length }), comments: comments.slice(-20).map(toIssueComment) };
  }

  async issueCreate(selector: string, opts: CreateIssueOptions): Promise<{ number: number; url: string }> {
    const args = ['issue', 'create', '--repo', selector, '--title', opts.title, '--body-file', '-'];
    if (opts.labels.length) args.push('--label', opts.labels.join(','));
    for (const a of opts.assignees) args.push('--assignee', a);
    const res = await this.run(args, { stdin: opts.body, timeoutMs: 60000 });
    const url = /https?:\/\/\S+\/issues\/\d+/.exec(res.stdout + res.stderr)?.[0] ?? '';
    const number = Number(/\/issues\/(\d+)/.exec(url)?.[1] ?? 0);
    if (!url || !number) throw new GitError({ message: 'Issue created but its number and URL could not be determined.', command: res.command, exitCode: res.exitCode, stderr: res.stderr, stdout: res.stdout, code: 'unknown' });
    return { number, url };
  }

  async issueSetState(selector: string, number: number, state: 'open' | 'closed'): Promise<void> {
    await this.run(['issue', state === 'open' ? 'reopen' : 'close', String(number), '--repo', selector], { timeoutMs: 30000 });
  }

  async issueCommentAdd(selector: string, number: number, body: string): Promise<void> {
    await this.run(['issue', 'comment', String(number), '--repo', selector, '--body-file', '-'], { stdin: body, timeoutMs: 30000 });
  }

  async labelList(selector: string): Promise<{ name: string; color: string; description: string | null }[]> {
    const raw = await this.json<{ name: string; color: string; description?: string | null }[]>(['label', 'list', '--repo', selector, '--limit', '200', '--json', 'name,color,description'], { timeoutMs: 30000 });
    return (raw ?? []).map((l) => ({ name: l.name, color: l.color, description: l.description ?? null }));
  }

  async milestoneList(selector: string): Promise<{ number: number; title: string }[]> {
    try {
      const raw = await this.json<{ number: number; title: string }[]>(['api', `repos/${selector}/milestones`], { timeoutMs: 30000 });
      return (raw ?? []).map((m) => ({ number: m.number, title: m.title }));
    } catch {
      return [];
    }
  }

  /** Raw file contents at a commit via the REST API (used for fork PRs whose commits are not fetched locally). */
  async fileContents(ref: GitHubRepoRef, path: string, sha: string, maxBytes: number): Promise<string | null> {
    try {
      const hostArgs = ref.host !== 'github.com' ? ['--hostname', ref.host] : [];
      const res = await this.run(['api', ...hostArgs, '-H', 'Accept: application/vnd.github.raw+json', `repos/${ref.owner}/${ref.name}/contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(sha)}`], { timeoutMs: 60000 });
      if (res.stdout.length > maxBytes || res.stdout.includes('\0')) return null;
      return res.stdout;
    } catch {
      return null;
    }
  }

  /**
   * Creates a pull request review with inline comments through the REST API.
   * Throws a GitError whose info.code is 'unknown' and stderr contains "HTTP 422" when
   * a comment does not map onto the diff; callers may retry without comments.
   */
  async createReview(ref: GitHubRepoRef, number: number, payload: unknown): Promise<{ url: string }> {
    const hostArgs = ref.host !== 'github.com' ? ['--hostname', ref.host] : [];
    const raw = await this.json<{ html_url?: string }>(['api', ...hostArgs, '-X', 'POST', `repos/${ref.owner}/${ref.name}/pulls/${number}/reviews`, '--input', '-'], { stdin: JSON.stringify(payload), timeoutMs: 120000 });
    return { url: raw?.html_url ?? `https://${ref.host}/${ref.owner}/${ref.name}/pull/${number}` };
  }

  // ---------- releases ----------

  /** `gh release view <tag> --json url`, or null when no release exists for that tag yet. */
  async releaseView(ref: GitHubRepoRef, tag: string): Promise<{ url: string } | null> {
    try {
      const raw = await this.json<{ url?: string }>(['release', 'view', tag, '--repo', repoSelector(ref), '--json', 'url']);
      return raw?.url ? { url: raw.url } : null;
    } catch (err) {
      if (err instanceof GitError && /release not found|HTTP 404/i.test(err.info.stderr)) return null;
      throw err;
    }
  }

  /** `gh release create <tag> --title <t> --notes-file - [--draft] [--prerelease] [--target <sha>]`, body on stdin. `opts.targetSha` lets gh create the tag itself when it does not exist yet. */
  async releaseCreate(ref: GitHubRepoRef, opts: CreateReleaseOptions): Promise<{ url: string }> {
    const args = ['release', 'create', opts.tag, '--repo', repoSelector(ref), '--title', opts.title, '--notes-file', '-'];
    if (opts.draft) args.push('--draft');
    if (opts.prerelease) args.push('--prerelease');
    if (opts.targetSha) args.push('--target', opts.targetSha);
    const res = await this.run(args, { stdin: opts.body, timeoutMs: 120000 });
    const url = /https?:\/\/\S+\/releases\/tag\/\S+/.exec(res.stdout + res.stderr)?.[0] ?? '';
    if (!url) throw new GitError({ message: 'Release created but its URL could not be determined.', command: res.command, exitCode: res.exitCode, stderr: res.stderr, stdout: res.stdout, code: 'unknown' });
    return { url };
  }

  /** Login of the signed-in user, from the cached auth status or the API. */
  async viewerLogin(): Promise<string | null> {
    const cached = this.tools.current().ghAccount?.login;
    if (cached) return cached;
    try {
      const res = await this.run(['api', 'user', '--jq', '.login'], { timeoutMs: 30000 });
      return res.stdout.trim() || null;
    } catch {
      return null;
    }
  }

  // ---------- notifications inbox ----------

  /**
   * Polls the notifications API with a conditional request. `ifModifiedSince`
   * should be the server's own `Last-Modified` value from the previous poll,
   * sent back verbatim to avoid clock-skew issues. A "not modified" response
   * (an empty body, whether gh reports it as a 304 success or, per observed
   * behaviour, exits non-zero for it) is reported as `notModified: true`
   * rather than thrown, so the poller can treat it as "nothing changed".
   * `--paginate` combined with `--include` prints one raw HTTP block per
   * page; every page's array is concatenated.
   */
  async notificationsPoll(ifModifiedSince: string | null): Promise<{ notModified: true; pollIntervalSeconds: number | null } | { notModified: false; items: unknown[]; lastModified: string | null; pollIntervalSeconds: number | null }> {
    const args = ['api', 'notifications', '--paginate', '--include'];
    if (ifModifiedSince) args.push('-H', `If-Modified-Since: ${ifModifiedSince}`);
    let stdout: string;
    try {
      stdout = (await this.run(args, { timeoutMs: 60000 })).stdout;
    } catch (err) {
      if (err instanceof GitError && err.info.code === 'unknown' && !err.info.stdout.trim() && (!err.info.stderr.trim() || /\b304\b/.test(err.info.stderr))) {
        return { notModified: true, pollIntervalSeconds: null };
      }
      throw err;
    }
    const blocks = parseHttpBlocks(stdout);
    const pollIntervalSeconds = blocks[0]?.headers['x-poll-interval'] ? Number(blocks[0].headers['x-poll-interval']) : null;
    if (blocks.length && blocks.every((b) => b.status === 304)) return { notModified: true, pollIntervalSeconds };
    const items: unknown[] = [];
    for (const b of blocks) {
      if (!b.body) continue;
      try {
        const parsed = JSON.parse(b.body);
        if (Array.isArray(parsed)) items.push(...parsed);
      } catch (err) {
        log.warn(`Could not parse a page of notifications: ${(err as Error).message}`);
      }
    }
    return { notModified: false, items, lastModified: blocks[0]?.headers['last-modified'] ?? null, pollIntervalSeconds };
  }

  async markThreadRead(threadId: string): Promise<void> {
    await this.run(['api', '-X', 'PATCH', `notifications/threads/${encodeURIComponent(threadId)}`], { timeoutMs: 30000 });
  }

  async markAllNotificationsRead(lastReadAt: string): Promise<void> {
    await this.run(['api', '-X', 'PUT', 'notifications', '-f', `last_read_at=${lastReadAt}`], { timeoutMs: 30000 });
  }

  async unsubscribeThread(threadId: string): Promise<void> {
    await this.run(['api', '-X', 'DELETE', `notifications/threads/${encodeURIComponent(threadId)}/subscription`], { timeoutMs: 30000 });
  }

  // ---------- misc ----------

  async gitignoreTemplates(): Promise<string[]> {
    return (await this.json<string[]>(['api', 'gitignore/templates'], { timeoutMs: 60000 })) ?? [];
  }

  async licenses(): Promise<{ key: string; name: string }[]> {
    const raw = await this.json<{ key: string; name: string }[]>(['api', 'licenses'], { timeoutMs: 60000 });
    return (raw ?? []).map((l) => ({ key: l.key, name: l.name }));
  }

  async gitignoreTemplate(name: string): Promise<string> {
    const raw = await this.json<{ source: string }>(['api', `gitignore/templates/${encodeURIComponent(name)}`], { timeoutMs: 60000 });
    return raw?.source ?? '';
  }

  async licenseText(key: string): Promise<string> {
    const raw = await this.json<{ body: string }>(['api', `licenses/${encodeURIComponent(key)}`], { timeoutMs: 60000 });
    return raw?.body ?? '';
  }

  // ---------- settings sync (gists) ----------

  /** Finds an existing gist by its description (`gh gist list` output is not JSON in all versions, so the search goes through the API instead). */
  async gistFind(description: string): Promise<{ id: string; updatedAt: string } | null> {
    const raw = await this.json<RawGist[]>(['api', 'gists', '--paginate'], { timeoutMs: 60000 });
    return findGistByDescription(raw ?? [], description);
  }

  /** Creates a new secret gist from `content` (sent over stdin to avoid command-line length limits) and returns its id. */
  async gistCreate(content: string, filename: string, description: string): Promise<string> {
    const res = await this.run(['gist', 'create', '--desc', description, '--filename', filename, '-'], { stdin: content, timeoutMs: 60000 });
    const url = /https?:\/\/\S+/.exec(res.stdout + res.stderr)?.[0] ?? '';
    const id = url.split('/').filter(Boolean).pop() ?? '';
    if (!id) throw new GitError({ message: 'Gist created but its id could not be determined.', command: res.command, exitCode: res.exitCode, stderr: res.stderr, stdout: res.stdout, code: 'unknown' });
    return id;
  }

  /** Raw content of one file in a gist, or null when the gist no longer exists. */
  async gistView(id: string, filename: string): Promise<string | null> {
    try {
      const res = await this.run(['gist', 'view', id, '--filename', filename, '--raw'], { timeoutMs: 60000 });
      return res.stdout;
    } catch (err) {
      if (err instanceof GitError && isGistNotFound(err.info)) return null;
      throw err;
    }
  }

  /** Overwrites one file in a gist with `content` (sent over stdin). */
  async gistEdit(id: string, filename: string, content: string): Promise<void> {
    await this.run(['gist', 'edit', id, '--filename', filename, '-'], { stdin: content, timeoutMs: 60000 });
  }

  /** The gist's `updated_at`, or null when it no longer exists (used to detect a deleted gist without treating it as an error). */
  async gistMetadata(id: string): Promise<{ updatedAt: string } | null> {
    try {
      const raw = await this.json<{ updated_at?: string }>(['api', `gists/${id}`], { timeoutMs: 30000 });
      return raw ? { updatedAt: raw.updated_at ?? '' } : null;
    } catch (err) {
      if (err instanceof GitError && isGistNotFound(err.info)) return null;
      throw err;
    }
  }

  async gistDelete(id: string): Promise<void> {
    try {
      await this.run(['gist', 'delete', id], { timeoutMs: 30000 });
    } catch (err) {
      if (err instanceof GitError && isGistNotFound(err.info)) return; // already gone
      throw err;
    }
  }

  async avatarForEmail(email: string): Promise<string | null> {
    const key = email.trim().toLowerCase();
    if (this.avatarCache.has(key)) return this.avatarCache.get(key)!;
    let url: string | null = null;
    const noreply = /^(?:(\d+)\+)?([^@]+)@users\.noreply\.github\.com$/i.exec(key);
    if (noreply) {
      url = noreply[1] ? `https://avatars.githubusercontent.com/u/${noreply[1]}?s=64` : `https://github.com/${noreply[2]}.png?size=64`;
    } else if (this.tools.current().ghAccount) {
      try {
        const res = await this.run(['api', `search/users?q=${encodeURIComponent(`${key} in:email`)}&per_page=1`, '--jq', '.items[0].avatar_url // empty'], { timeoutMs: 30000 });
        const found = res.stdout.trim();
        url = found ? `${found}${found.includes('?') ? '&' : '?'}s=64` : null;
      } catch {
        url = null;
      }
    }
    this.avatarCache.set(key, url);
    return url;
  }
}
