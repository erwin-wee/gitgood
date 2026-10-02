import { readFile, writeFile } from 'node:fs/promises';
import type { AiFeature } from '@shared/types';
import { AiError } from '../../ai/backends';
import { readUsage } from '../../ai/usage';
import { insertIntoChangelog } from '../../ai/release-notes-core';
import { toFsPath } from '../../git/diff';
import { openShellWithCommand } from '../../integrations/shells';
import { readRepoConfig } from '../../repo/config';
import { agentTemplate, expandAgentCommand, quotingFor, validateAgentTemplate } from '@shared/agent-presets';
import type { ApiMethods } from '@shared/ipc';
import type { HandlerContext } from './context';

/** Synthetic `ai.progress` path used for the PR draft service, which has no single file of its own. */
const PR_DRAFT_PROGRESS_PATH = '<pull request>';
/** Synthetic `ai.progress` path used for the release notes service, which has no single file of its own. */
const RELEASE_NOTES_PROGRESS_PATH = '<release notes>';

export function aiHandlers(ctx: HandlerContext) {
  const { errorExplain, explain, gh, host, nlPalette, prDraft, rebasePlan, releaseNotes, repos, requireGitHub, resolver, review, send, splitter, store, tools, triage, withBusy } = ctx;
  return {
    // ---------------- ai ----------------
    'ai.resolve': async (repoPath, path, checkOutput) => {
      const resume = repos.pauseWatcher(repoPath);
      try {
        return await resolver.resolve(repoPath, path, (p, phase, message) => send('ai.progress', { repoPath, path: p, phase, message }), checkOutput);
      } finally {
        resume();
        send('repo.changed', { repoPath, reason: 'both' });
      }
    },
    'ai.resolveAll': async (repoPath) => {
      const resume = repos.pauseWatcher(repoPath);
      try {
        return await resolver.resolveAll(repoPath, (p, phase, message) => send('ai.progress', { repoPath, path: p, phase, message }));
      } finally {
        resume();
        send('repo.changed', { repoPath, reason: 'both' });
      }
    },
    'ai.resolveAllGuided': async (repoPath) => {
      const resume = repos.pauseWatcher(repoPath);
      try {
        return await resolver.resolveAllGuided(repoPath, (p, phase, message) => send('ai.progress', { repoPath, path: p, phase, message }));
      } finally {
        resume();
        send('repo.changed', { repoPath, reason: 'both' });
      }
    },
    'ai.resolve.useSideForBlock': async (repoPath, path, original, ranges, blockId, side) => {
      const resume = repos.pauseWatcher(repoPath);
      try {
        return await resolver.useSideForBlock(repoPath, path, original, ranges, blockId, side);
      } finally {
        resume();
        send('repo.changed', { repoPath, reason: 'worktree' });
      }
    },
    'ai.resolve.runCheck': async (repoPath, command) => resolver.runCheck(repoPath, command),
    'ai.resolve.examples': async (repoPath) => resolver.getExamplePaths(repoPath),
    'ai.resolve.clearExamples': async (repoPath) => resolver.clearExamples(repoPath),
    'repo.checkConfig': async (repoPath) => {
      const command = (await readRepoConfig(repoPath)).postResolveCheck;
      const trust = store.getRepoConfigTrust(repoPath, command);
      return { command, trustState: trust === true ? 'trusted' : trust === false ? 'declined' : 'unknown' };
    },
    'repo.trustConfig': async (repoPath, trusted, command) => {
      // A grant is bound to the command the user was shown. If the file changed since, refuse and report the current command so the renderer re-prompts.
      const current = (await readRepoConfig(repoPath)).postResolveCheck;
      if (trusted && current !== command) return { ok: false, command: current };
      store.setRepoConfigTrust(repoPath, trusted, command);
      return { ok: true };
    },
    'ai.cancel': async (feature) => {
      const cancel: Record<AiFeature, () => void> = {
        resolver: () => resolver.cancel('resolver'),
        commitMessage: () => resolver.cancel('commitMessage'),
        review: () => review.cancel(),
        split: () => splitter.cancel(),
        triage: () => triage.cancel(),
        prDraft: () => prDraft.cancel(),
        rebase: () => rebasePlan.cancel(),
        releaseNotes: () => releaseNotes.cancel(),
        explain: () => explain.cancel(),
        errorExplain: () => errorExplain.cancel(),
        nlPalette: () => nlPalette.cancel(),
      };
      cancel[feature]?.();
    },
    'ai.usage.get': async () => readUsage(),
    'ai.review.plan': async (repoPath, target) => review.plan(repoPath, target),
    'ai.review.start': async (repoPath, target, opts) => review.start(repoPath, target, opts ?? {}, (e) => send('ai.review.progress', e)),
    'ai.review.get': async (repoPath, target) => review.get(repoPath, target),
    'ai.review.dismiss': async (repoPath, runId, findingId, dismissed) => review.dismiss(repoPath, runId, findingId, dismissed),
    'ai.review.post': async (repoPath, opts) => review.post(repoPath, opts),
    'ai.review.startWorktree': async (repoPath, opts) => review.startWorktree(repoPath, opts, (e) => send('ai.review.progress', e)),
    'ai.review.worktreeStale': async (repoPath, runId) => review.worktreeStale(repoPath, runId),
    'ai.review.applySuggestion': async (repoPath, runId, findingId) => review.applySuggestion(repoPath, runId, findingId),
    'ai.review.latest': async (repoPath) => review.latest(repoPath),
    'ai.review.exportPath': async (repoPath, runId) => review.exportPath(repoPath, runId),
    'ai.review.consumeRerunToken': async (repoPath, token) => review.consumeRerunToken(repoPath, token),
    'ai.review.fixWithAgent': async (repoPath, runId) => {
      const settings = store.getSettings();
      const template = agentTemplate(settings.ai);
      const invalid = validateAgentTemplate(template, quotingFor(settings.shell, process.platform));
      if (invalid) throw new AiError(`${invalid} Set the agent command under Options → AI → Agent for fixes.`, 'not-configured');
      const file = await review.exportPath(repoPath, runId);
      // The path is quoted for whichever shell the chosen terminal parses the command with.
      const { launched, command } = await openShellWithCommand(settings.shell, settings.shell === 'custom' ? settings.customShellPath : null, repoPath, (quoting) => expandAgentCommand(template, file, quoting), (await tools.env()).PATH);
      if (!launched) await host.clipboardWrite(command);
      return { launched, command };
    },
    'ai.explain': async (repoPath, target) => explain.explain(repoPath, target),
    'ai.explain.followUp': async (repoPath, target, history, question) => explain.followUp(repoPath, target, history, question),
    'ai.test': async () => resolver.test(),
    'ai.commitMessage': async (repoPath, files) => resolver.commitMessage(repoPath, files),
    'ai.split.preflight': async (repoPath, files) => splitter.preflight(repoPath, files),
    'ai.split.plan': async (repoPath, files, fileOnly) => splitter.plan(repoPath, files, fileOnly),
    'ai.split.apply': async (repoPath, plan) => {
      const resume = repos.pauseWatcher(repoPath);
      try {
        return await splitter.apply(repoPath, plan, (e) => send('ai.split.progress', e));
      } finally {
        resume();
        send('repo.changed', { repoPath, reason: 'both' });
      }
    },
    'ai.split.undo': async (repoPath, startSha) => {
      const resume = repos.pauseWatcher(repoPath);
      try {
        await splitter.undo(repoPath, startSha);
      } finally {
        resume();
        send('repo.changed', { repoPath, reason: 'both' });
      }
    },
    'ai.rebase.preflight': async (repoPath, base, shas) => rebasePlan.preflight(repoPath, base, shas),
    'ai.rebase.plan': async (repoPath, base, shas) => rebasePlan.plan(repoPath, base, shas),
    'ai.rebase.apply': async (repoPath, plan) => {
      const resume = repos.pauseWatcher(repoPath);
      try {
        return await withBusy(repoPath, () => rebasePlan.apply(repoPath, plan, (e) => send('ai.rebase.progress', e)));
      } finally {
        resume();
        send('repo.changed', { repoPath, reason: 'both' });
      }
    },
    'ai.rebase.undo': async (repoPath, startSha) => {
      const resume = repos.pauseWatcher(repoPath);
      try {
        await rebasePlan.undo(repoPath, startSha);
      } finally {
        resume();
        send('repo.changed', { repoPath, reason: 'both' });
      }
    },
    'ai.explainError': async (repoPath, error, retryable) => errorExplain.explainError(repoPath, error, retryable),
    'ai.prDraft': async (repoPath, input) => prDraft.draft(repoPath, input, (phase, message) => send('ai.progress', { repoPath, path: PR_DRAFT_PROGRESS_PATH, phase, message })),
    'repo.release.range': async (repoPath, query) => releaseNotes.range(repoPath, query),
    'ai.releaseNotes': async (repoPath, input) => releaseNotes.generate(repoPath, input, (phase, message) => send('ai.progress', { repoPath, path: RELEASE_NOTES_PROGRESS_PATH, phase, message })),
    'repo.changelog.insert': async (repoPath, markdown) => {
      const fsPath = toFsPath(repoPath, 'CHANGELOG.md');
      let existing: string | null = null;
      try {
        existing = await readFile(fsPath, 'utf8');
      } catch {
        existing = null;
      }
      const { content, created } = insertIntoChangelog(existing, markdown);
      await writeFile(fsPath, content, 'utf8');
      return { created };
    },
    'gh.release.create': async (repoPath, opts) => gh.releaseCreate(await requireGitHub(repoPath), opts),
    'gh.release.view': async (repoPath, tag) => {
      const ref = await repos.detectGitHub(repoPath);
      return ref ? gh.releaseView(ref, tag) : null;
    },
    'ai.triage.get': async (repoPath) => triage.get(repoPath),
    'ai.triage.run': async (repoPath, numbers) => triage.run(repoPath, numbers, (e) => send('ai.triage.progress', e)),
    'ai.triage.clear': async (repoPath) => triage.clear(repoPath),
    'git.removeLockFile': async (repoPath) => errorExplain.removeLockFile(repoPath),

    // ---------------- ai command palette ----------------
    'ai.nl.plan': async (repoPath, request, priorQuestion, answer) => nlPalette.plan(repoPath, request, priorQuestion, answer),
    'ai.nl.preview': async (repoPath, step) => nlPalette.preview(repoPath, step),
    'ai.nl.run': async (repoPath, plan, confirmedStepIds) => {
      const resume = repos.pauseWatcher(repoPath);
      try {
        return await nlPalette.run(repoPath, plan, confirmedStepIds, (e) => send('ai.nl.progress', { ...e, repoPath }));
      } finally {
        resume();
        send('repo.changed', { repoPath, reason: 'both' });
      }
    },
  } satisfies Partial<ApiMethods>;
}
