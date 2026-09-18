import { afterEach, describe, expect, it } from 'vitest';
import type { RebaseApplyProgress, RebasePlan } from '../../src/shared/types';
import { GitClient } from '../../src/main/git/git';
import { useSide } from '../../src/main/git/operations';
import { RebaseApplyService } from '../../src/main/git/rebase-apply';
import { createRepo, hasGitSync, type TestRepo } from '../helpers/repo';

const noProgress = (_e: RebaseApplyProgress) => undefined;

function row(sha: string, over: Partial<RebasePlan['rows'][number]> = {}): RebasePlan['rows'][number] {
  return { sha, action: 'pick', squashInto: null, originalMessage: '', message: '', rationale: '', pushed: false, ...over };
}

describe.skipIf(!hasGitSync())('AI rebase assistant: applier', () => {
  let repo: TestRepo | undefined;
  afterEach(async () => {
    await repo?.dispose();
    repo = undefined;
  });

  it('applies a plan with one of each action and yields the previewed history', async () => {
    repo = await createRepo({ commits: [{ message: 'base', files: { 'a.txt': '1\n' } }] });
    const baseSha = repo.git(['rev-parse', 'HEAD']).trim();
    const c1 = repo.commit({ message: 'add feature', files: { 'b.txt': 'feature\n' } });
    const c2 = repo.commit({ message: 'wip', files: { 'b.txt': 'feature\nwip\n' } });
    const c3 = repo.commit({ message: 'typo commit', files: { 'c.txt': 'hello\n' } });
    const c4 = repo.commit({ message: 'oops', files: { 'd.txt': 'oops\n' } });
    const startSha = repo.git(['rev-parse', 'HEAD']).trim();
    expect(startSha).toBe(c4);

    const git = new GitClient(repo.tools({ env: { ...repo.env, GITGOOD_SEQUENCE_EDITOR: process.execPath } }));
    const applier = new RebaseApplyService();

    const plan: RebasePlan = {
      id: 'test-plan',
      base: baseSha,
      startSha,
      truncated: false,
      alreadyTidy: false,
      model: 'test',
      warnings: [],
      rows: [
        row(c1, { action: 'pick', message: 'Add feature' }),
        row(c2, { action: 'squash', squashInto: c1, message: 'Add feature' }),
        row(c3, { action: 'reword', message: 'Fix typo in c.txt' }),
        row(c4, { action: 'drop' }),
      ],
    };

    const progressEvents: RebaseApplyProgress[] = [];
    const outcome = await applier.apply(git, repo.path, plan, (e) => progressEvents.push(e));
    expect(outcome.status).toBe('complete');
    expect(progressEvents.some((e) => e.phase === 'done')).toBe(true);
    expect(progressEvents.some((e) => e.phase === 'squash')).toBe(true);
    expect(progressEvents.some((e) => e.phase === 'reword')).toBe(true);
    expect(progressEvents.some((e) => e.phase === 'drop')).toBe(true);

    const subjects = repo.git(['log', '--format=%s', `${baseSha}..HEAD`]).trim().split('\n');
    expect(subjects).toEqual(['Fix typo in c.txt', 'Add feature']);
    const bContent = await import('node:fs/promises').then((m) => m.readFile(`${repo!.path}/b.txt`, 'utf8'));
    expect(bContent).toBe('feature\nwip\n');
    const dExists = await import('node:fs/promises')
      .then((m) => m.access(`${repo!.path}/d.txt`))
      .then(() => true)
      .catch(() => false);
    expect(dExists).toBe(false);
  });

  it('aborts a conflicting reorder back to the recorded start commit', async () => {
    repo = await createRepo({ commits: [{ message: 'base', files: { 'f.txt': '1\n2\n3\n' } }] });
    const baseSha = repo.git(['rev-parse', 'HEAD']).trim();
    const c1 = repo.commit({ message: 'add A', files: { 'f.txt': '1\n2\n3\nA\n' } });
    const c2 = repo.commit({ message: 'add B', files: { 'f.txt': '1\n2\n3\nA\nB\n' } });
    const startSha = repo.git(['rev-parse', 'HEAD']).trim();
    expect(startSha).toBe(c2);

    const git = new GitClient(repo.tools({ env: { ...repo.env, GITGOOD_SEQUENCE_EDITOR: process.execPath } }));
    const applier = new RebaseApplyService();

    // Desired order (oldest-first) is [c2, c1]: swapping them forces b's patch (which assumes "A"
    // is already present) to apply before a exists, which conflicts.
    const plan: RebasePlan = {
      id: 'test-plan-2',
      base: baseSha,
      startSha,
      truncated: false,
      alreadyTidy: false,
      model: 'test',
      warnings: [],
      rows: [row(c2), row(c1)],
    };

    const outcome = await applier.apply(git, repo.path, plan, noProgress);
    expect(outcome.status).toBe('conflicts');
    expect(applier.hasPendingApply(repo.path)).toBe(true);

    await applier.abortApply(git, repo.path);
    expect(applier.hasPendingApply(repo.path)).toBe(false);
    expect(repo.git(['rev-parse', 'HEAD']).trim()).toBe(startSha);
    expect(repo.git(['status', '--porcelain']).trim()).toBe('');
  });

  it('resolving a conflict and continuing finishes the remaining plan', async () => {
    repo = await createRepo({ commits: [{ message: 'base', files: { 'f.txt': '1\n2\n3\n' } }] });
    const baseSha = repo.git(['rev-parse', 'HEAD']).trim();
    const c1 = repo.commit({ message: 'add A', files: { 'f.txt': '1\n2\n3\nA\n' } });
    const c2 = repo.commit({ message: 'add B', files: { 'f.txt': '1\n2\n3\nA\nB\n' } });
    const startSha = repo.git(['rev-parse', 'HEAD']).trim();

    const git = new GitClient(repo.tools({ env: { ...repo.env, GITGOOD_SEQUENCE_EDITOR: process.execPath } }));
    const applier = new RebaseApplyService();
    const plan: RebasePlan = { id: 'test-plan-3', base: baseSha, startSha, truncated: false, alreadyTidy: false, model: 'test', warnings: [], rows: [row(c2), row(c1)] };

    let outcome = await applier.apply(git, repo.path, plan, noProgress);
    expect(outcome.status).toBe('conflicts');
    // The replayed commits conflict against each other more than once (both were rewritten to
    // apply in the opposite order); resolve however many rounds it takes, same as a user
    // repeatedly clicking Continue in the conflicts banner.
    for (let round = 0; round < 5 && outcome.status === 'conflicts'; round++) {
      await useSide(git, repo.path, 'f.txt', 'theirs');
      outcome = await applier.continueApply(git, repo.path, false);
    }
    expect(outcome.status).toBe('complete');
    expect(applier.hasPendingApply(repo.path)).toBe(false);
    const subjects = repo.git(['log', '--format=%s', `${baseSha}..HEAD`]).trim().split('\n');
    expect(subjects).toEqual(['add A', 'add B']);
  });
});
