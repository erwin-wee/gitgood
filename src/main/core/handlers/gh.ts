import { discoverIssueTemplates } from '../../gh/issue-templates';
import { getCurrentBranchName } from '../../git/branches';
import { isUnborn } from '../../git/commit';
import { findPullRequestTemplate } from '../../gh/pr-template';
import type { ApiMethods } from '@shared/ipc';
import type { HandlerContext } from './context';

export function ghHandlers(ctx: HandlerContext) {
  const { gh, git, inbox, issueSelector, repos, requireGitHub, review, send, store, tools, withBusy } = ctx;
  return {
    // ---------------- gh ----------------
    'gh.auth.status': async () => gh.account(),
    'gh.auth.login': async (host) => {
      const result = await gh.login(host, (code, url) => send('gh.auth.code', { code, url }));
      await tools.refreshAuth();
      send('gh.auth.finished', result);
      return result;
    },
    'gh.auth.cancelLogin': async () => gh.cancelLogin(),
    'gh.auth.logout': async (host, login) => {
      await gh.logout(host, login);
      await tools.refreshAuth();
      store.clearInboxCache(); // the inbox belongs to whichever account is active now
      inbox.resetCache();
    },
    'gh.auth.switch': async (host, login) => {
      await gh.switchAccount(host, login);
      await tools.refreshAuth();
      store.clearInboxCache();
      inbox.resetCache();
    },
    'gh.auth.setupGit': async () => {
      await gh.setupGit();
      await tools.refreshAuth();
    },
    'gh.auth.refreshScopes': async (scopes) => {
      const host = tools.current().ghAccount?.host ?? 'github.com';
      const result = await gh.refreshScopes(host, scopes, (code, url) => send('gh.auth.code', { code, url }));
      await tools.refreshAuth();
      send('gh.auth.finished', result);
      return result;
    },
    'gh.repos.list': async () => gh.viewerRepositories(),
    'gh.orgs.list': async () => gh.organizations(),
    'gh.repo.view': async (repoPath) => {
      const ref = await repos.detectGitHub(repoPath);
      return ref ? gh.repoView(ref) : null;
    },
    'gh.repo.publish': async (repoPath, opts) => {
      const unborn = await isUnborn(git, repoPath);
      const ref = await gh.publish(repoPath, opts, !unborn);
      await repos.refreshGitHub(repoPath);
      if (!unborn) {
        const branch = await getCurrentBranchName(git, repoPath);
        if (branch) await git.tryRun(repoPath, ['branch', `--set-upstream-to=origin/${branch}`, branch]);
      }
      return ref;
    },
    'gh.repo.fork': async (repoPath) => {
      const ref = await gh.fork(repoPath);
      await repos.refreshGitHub(repoPath);
      return ref;
    },
    'gh.pr.list': async (repoPath, state) => gh.prList(await requireGitHub(repoPath), state),
    'gh.pr.forBranch': async (repoPath, branch) => {
      const ref = await repos.detectGitHub(repoPath);
      return ref ? gh.prForBranch(ref, branch) : null;
    },
    'gh.pr.view': async (repoPath, number) => gh.prView(await requireGitHub(repoPath), number),
    'gh.pr.checks': async (repoPath, number) => gh.prChecks(await requireGitHub(repoPath), number),
    'gh.pr.checkout': async (repoPath, number) => withBusy(repoPath, () => gh.prCheckout(repoPath, number)),
    'gh.pr.create': async (repoPath, opts) => gh.prCreate(repoPath, opts),
    'gh.pr.merge': async (repoPath, number, method, deleteBranch, auto) => gh.prMerge(await requireGitHub(repoPath), number, method, deleteBranch, auto),
    'gh.pr.disableAutoMerge': async (repoPath, number) => gh.prDisableAutoMerge(await requireGitHub(repoPath), number),
    'gh.pr.ready': async (repoPath, number, ready) => gh.prReady(await requireGitHub(repoPath), number, ready),
    'gh.pr.close': async (repoPath, number) => gh.prClose(await requireGitHub(repoPath), number),
    'gh.pr.reopen': async (repoPath, number) => gh.prReopen(await requireGitHub(repoPath), number),
    'gh.pr.review': async (repoPath, number, action, body) => gh.prReview(await requireGitHub(repoPath), number, action, body),
    'gh.pr.comment': async (repoPath, number, body) => gh.prComment(await requireGitHub(repoPath), number, body),
    'gh.pr.diff': async (repoPath, number) => review.prFiles(repoPath, number),
    'gh.pr.fileDiff': async (repoPath, number, path, opts) => review.prFileDiff(repoPath, number, path, opts),
    'gh.pr.template': async (repoPath) => findPullRequestTemplate(repoPath),
    'gh.gitignoreTemplates': async () => gh.gitignoreTemplates(),
    'gh.licenses': async () => gh.licenses(),
    'gh.avatar': async (email) => gh.avatarForEmail(email),
    'gh.issue.createUrl': async (repoPath) => {
      const ref = await repos.detectGitHub(repoPath);
      return ref ? `${ref.url}/issues/new` : null;
    },
    'gh.issue.list': async (repoPath, filter, owner, beforeUpdatedAt) => gh.issueList(await issueSelector(repoPath, owner), filter, beforeUpdatedAt),
    'gh.issue.view': async (repoPath, number, owner) => gh.issueDetail(await issueSelector(repoPath, owner), number),
    'gh.issue.create': async (repoPath, opts, owner) => gh.issueCreate(await issueSelector(repoPath, owner), opts),
    'gh.issue.setState': async (repoPath, number, state, owner) => gh.issueSetState(await issueSelector(repoPath, owner), number, state),
    'gh.issue.comment': async (repoPath, number, body, owner) => gh.issueCommentAdd(await issueSelector(repoPath, owner), number, body),
    'gh.labels': async (repoPath, owner) => gh.labelList(await issueSelector(repoPath, owner)),
    'gh.milestones': async (repoPath, owner) => gh.milestoneList(await issueSelector(repoPath, owner)),
    'gh.issue.templates': async (repoPath) => discoverIssueTemplates(repoPath),
    'app.issueFilters.get': async (repoId) => store.getIssueFilter(repoId),
    'app.issueFilters.set': async (repoId, filter) => store.setIssueFilter(repoId, filter),

    // ---------------- notifications inbox ----------------
    'gh.inbox.get': async () => inbox.getState(),
    'gh.inbox.refresh': async () => inbox.refresh(),
    'gh.inbox.markRead': async (threadIds) => inbox.markRead(threadIds),
    'gh.inbox.markAllRead': async () => inbox.markAllRead(),
    'gh.inbox.unsubscribe': async (threadId) => inbox.unsubscribe(threadId),
    'app.inbox.clearCache': async () => {
      store.clearInboxCache();
      inbox.resetCache();
    },
  } satisfies Partial<ApiMethods>;
}
