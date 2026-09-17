import type { CheckRun, CreatePullRequestOptions, GitHubAccount, GitHubRepoDetails, GitHubRepoRef, GitHubRepoSummary, PublishOptions, PullRequest, PullRequestChecksSummary } from '@shared/types';
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
}

const PR_FIELDS = 'number,title,url,author,headRefName,baseRefName,headRepository,headRepositoryOwner,isCrossRepository,isDraft,state,createdAt,updatedAt,statusCheckRollup,reviewDecision,body,additions,deletions,changedFiles,mergeable,mergeStateStatus,labels,assignees,reviewRequests';

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

function toPullRequest(raw: RawPr): PullRequest {
  const headOwner = raw.headRepositoryOwner?.login;
  const headName = raw.headRepository?.name;
  return {
    number: raw.number,
    title: raw.title,
    url: raw.url,
    author: raw.author?.login ?? 'unknown',
    headRefName: raw.headRefName,
    baseRefName: raw.baseRefName,
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
  };
}

export function repoSelector(ref: GitHubRepoRef): string {
  return ref.host === 'github.com' ? `${ref.owner}/${ref.name}` : `${ref.host}/${ref.owner}/${ref.name}`;
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
   * Runs the browser device flow. The one-time code is reported through onCode
   * as soon as gh prints it; the promise resolves when the flow completes.
   */
  async login(host: string, onCode: (code: string, url: string) => void): Promise<{ ok: boolean; error: string | null }> {
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
      await this.run(['auth', 'login', '--web', '--hostname', host, '--git-protocol', 'https', '--skip-ssh-key'], {
        signal: controller.signal,
        onStderr: handleOutput,
        onStdout: handleOutput,
        timeoutMs: 20 * 60 * 1000,
      });
      try {
        await this.run(['auth', 'setup-git', '--hostname', host], { timeoutMs: 30000 });
      } catch (err) {
        log.warn(`gh auth setup-git failed: ${(err as Error).message}`);
      }
      return { ok: true, error: null };
    } catch (err) {
      const info = toGitErrorInfo(err);
      if (info.code === 'cancelled') return { ok: false, error: null };
      return { ok: false, error: info.message };
    } finally {
      if (this.loginProcess === controller) this.loginProcess = null;
    }
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
