import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConflictResolver } from '../src/main/ai/resolver';
import { ErrorExplainService } from '../src/main/ai/error-explain';
import { ReviewService } from '../src/main/ai/review';
import { clientContext } from '../src/main/core/client-context';
import { GitClient } from '../src/main/git/git';
import type { GhClient } from '../src/main/gh/gh';
import type { RepositoryManager } from '../src/main/repo/manager';
import type { Store } from '../src/main/store';
import { DEFAULT_SETTINGS, type AppSettings, type GitErrorInfo } from '../src/shared/types';
import { createRepo, hasGitSync } from './helpers/repo';

/** One request the stub received and has not answered yet; `aborted` flips when the client hangs up before an answer. */
interface Held {
  res: ServerResponse;
  aborted: boolean;
}

let server: Server;
let base: string;
let held: Held[];
/** When set, requests are answered with REVIEW_REPLY on arrival instead of being held. */
let auto: boolean;
const REVIEW_REPLY = { findings: [], fileSummary: 'x', summary: 'ok', verdict: 'approve' };

beforeEach(async () => {
  held = [];
  auto = false;
  server = createServer((incoming, res) => {
    const entry: Held = { res, aborted: false };
    res.on('close', () => {
      if (!res.writableEnded) entry.aborted = true;
    });
    incoming.resume();
    held.push(entry);
    if (auto) answer(entry, REVIEW_REPLY);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/`;
});
afterEach(async () => {
  for (const h of held) h.res.destroy();
  await new Promise<void>((r) => server.close(() => r()));
});

const answer = (h: Held, content: unknown, status = 200) => {
  h.res.writeHead(status, { 'content-type': 'application/json' });
  h.res.end(JSON.stringify({ model: 'stub', choices: [{ message: { content: JSON.stringify(content) }, finish_reason: 'stop' }] }));
};
const received = async (n: number) => {
  for (let i = 0; i < 400 && held.length < n; i++) await new Promise((r) => setTimeout(r, 10));
  expect(held.length).toBeGreaterThanOrEqual(n);
};
const settle = () => new Promise((r) => setTimeout(r, 50));

const store = (): Store => {
  const settings: AppSettings = { ...DEFAULT_SETTINGS, ai: { ...DEFAULT_SETTINGS.ai, provider: 'openai-compatible', openaiBaseUrl: base, openaiModel: 'stub' } };
  return { getSettings: () => settings, getOpenaiApiKey: () => null } as unknown as Store;
};

const ERROR: GitErrorInfo = { message: 'boom', command: 'git push', exitCode: 1, stderr: 'boom', stdout: '', code: 'unknown' };
const EXPLANATION = { whatHappened: 'It failed.', likelyCause: 'Because.', fixes: [] };

describe('ErrorExplainService jobs per client', () => {
  // repoPath null skips every git call; tools.current() is only read for git.version / gh.installed.
  const service = () => {
    const tools = { current: () => ({ git: { version: '2.0.0' }, gh: { installed: false, version: null } }), ensure: async () => undefined } as never;
    return new ErrorExplainService(store(), tools, null as never);
  };
  const as = <T>(client: string, fn: () => T) => clientContext.run(client, fn);

  it("one client's cancel leaves another client's request running; isActive covers both until each finishes", async () => {
    const svc = service();
    const a = as('a', () => svc.explainError(null, ERROR, false));
    const b = as('b', () => svc.explainError(null, ERROR, false));
    await received(2);
    expect(held.map((h) => h.aborted)).toEqual([false, false]);

    const aRejected = expect(a).rejects.toMatchObject({ kind: 'cancelled' });
    as('a', () => svc.cancel());
    await aRejected;
    await settle();
    expect(held.map((h) => h.aborted)).toEqual([true, false]);
    expect(svc.isActive()).toBe(true); // B is still outstanding

    answer(held[1], EXPLANATION);
    expect((await b).whatHappened).toBe('It failed.');
    expect(svc.isActive()).toBe(false);
  });

  it('keeps isActive true until the slower client finishes when the other one finishes first', async () => {
    const svc = service();
    const a = as('a', () => svc.explainError(null, ERROR, false));
    const b = as('b', () => svc.explainError(null, ERROR, false));
    await received(2);

    answer(held[1], EXPLANATION);
    await b;
    expect(svc.isActive()).toBe(true);
    expect(held[0].aborted).toBe(false);

    answer(held[0], EXPLANATION);
    await a;
    expect(svc.isActive()).toBe(false);
  });

  it("a client's new request replaces its own earlier one and only the new one can be cancelled afterwards", async () => {
    const svc = service();
    const first = as('a', () => svc.explainError(null, ERROR, false));
    await received(1);
    const second = as('a', () => svc.explainError(null, ERROR, false));
    const firstRejected = expect(first).rejects.toMatchObject({ kind: 'cancelled' });
    await received(2);
    await firstRejected;
    expect(held.map((h) => h.aborted)).toEqual([true, false]);
    expect(svc.isActive()).toBe(true); // the replacement is still running

    as('a', () => svc.cancel());
    await expect(second).rejects.toMatchObject({ kind: 'cancelled' });
    expect(svc.isActive()).toBe(false);
  });

  it('a client without a job cannot cancel anyone else, and a failed request leaves nothing active', async () => {
    const svc = service();
    const a = as('a', () => svc.explainError(null, ERROR, false));
    await received(1);
    as('b', () => svc.cancel());
    await settle();
    expect(held[0].aborted).toBe(false);

    answer(held[0], { error: { message: 'nope' } }, 500);
    await expect(a).rejects.toThrow();
    expect(svc.isActive()).toBe(false);
  });
});

describe.skipIf(!hasGitSync())('ReviewService.startWorktree jobs per client', () => {
  it("another client's start does not abort a running review, cancel only stops the caller's, and the survivor completes", async () => {
    const repo = await createRepo({ commits: [{ message: 'init', files: { 'src/app.ts': 'export const a = 1;\n' } }] });
    const userDataDir = await mkdtemp(join(tmpdir(), 'gg-review-jobs-'));
    try {
      await repo.write('src/app.ts', 'export const a = 2;\nexport const b = 3;\n');
      const git = new GitClient(repo.tools());
      const repos = { getByPath: () => null } as unknown as RepositoryManager;
      const svc = new ReviewService(store(), repo.tools(), git, null as unknown as GhClient, repos, userDataDir);
      const opts = { files: ['src/app.ts'], partialPatches: {}, summary: 'Update app', description: '', amend: false };
      const start = (client: string) => clientContext.run(client, () => svc.startWorktree(repo.path, opts, () => undefined));

      const a = start('a');
      await received(1);
      const b = start('b');
      await received(2);
      expect(held.map((h) => h.aborted)).toEqual([false, false]);

      clientContext.run('a', () => svc.cancel());
      expect((await a).cancelled).toBe(true);
      expect(held[1].aborted).toBe(false);
      expect(svc.isActive()).toBe(true);

      // B is still alive: answer its pending request and every later one (per-file review, then summary) until it finishes.
      auto = true;
      held.forEach((h, i) => i && !h.res.writableEnded && answer(h, REVIEW_REPLY));
      const finished = b;
      const run = await finished;
      expect(run.cancelled).toBe(false);
      expect(svc.isActive()).toBe(false);
    } finally {
      await rm(userDataDir, { recursive: true, force: true });
      await repo.dispose();
    }
  });
});

describe.skipIf(!hasGitSync())('ConflictResolver jobs', () => {
  it('commit-message generation is isolated from conflict resolution, and a finished resolve leaves nothing active', async () => {
    const repo = await createRepo({ commits: [{ message: 'init', files: { 'a.txt': 'one\n' } }] });
    try {
      await repo.write('a.txt', 'two\n');
      const svc = new ConflictResolver(store(), repo.tools(), new GitClient(repo.tools()));
      const message = svc.commitMessage(repo.path, ['a.txt']);
      await received(1);

      svc.cancel('resolver'); // a conflict-resolution cancel must not touch the commit message request
      await settle();
      expect(held[0].aborted).toBe(false);
      expect(svc.isActive()).toBe(true);

      answer(held[0], { summary: 'Update a', description: '' });
      expect((await message).summary).toBe('Update a');
      expect(svc.isActive()).toBe(false);

      await svc.resolve(repo.path, 'a.txt', () => undefined).catch(() => undefined);
      expect(svc.isActive()).toBe(false);
    } finally {
      await repo.dispose();
    }
  });
});
