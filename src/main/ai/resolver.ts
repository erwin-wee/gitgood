import { readFile, writeFile } from 'node:fs/promises';
import type { AiSettings, ConflictBlockResolution, ConflictResolutionResult, InProgressOperation, ManualResolutionExample, PostResolveCheckResult, WorkingFile } from '@shared/types';
import { applyResolutions, hasConflictMarkers, normalizeResolutionText, parseConflicts, resolutionForChoice, type BlockChoice } from '@shared/diff/conflicts';
import { languageFromPath, splitLines } from '@shared/util';
import { runPostResolveCheck, resolveCheckCommand } from './check-runner';
import { capExamples, trimManualResolution } from './resolve-examples';
import { toFsPath, getPatchForFiles } from '../git/diff';
import type { GitClient } from '../git/git';
import { markResolved } from '../git/operations';
import { readRepoConfig } from '../repo/config';
import { getStatus } from '../git/status';
import { log } from '../logger';
import type { Store } from '../store';
import type { ToolLocator } from '../tools';
import { AiError, type AiBackend } from './backends';
import { createBackend } from './provider';
import { buildCommitMessagePrompt, buildResolvePrompt, COMMIT_MESSAGE_SCHEMA, COMMIT_MESSAGE_SYSTEM_PROMPT, RESOLUTION_SCHEMA, RESOLVE_SYSTEM_PROMPT } from './prompts';

export type ProgressReporter = (path: string, phase: 'started' | 'thinking' | 'writing' | 'done' | 'error', message: string) => void;

interface ResolutionPayload {
  resolutions: { id: number; resolved: string; rationale: string; confidence: 'high' | 'medium' | 'low' }[];
}

function isResolutionPayload(v: unknown): v is ResolutionPayload {
  if (!v || typeof v !== 'object') return false;
  const arr = (v as { resolutions?: unknown }).resolutions;
  return Array.isArray(arr) && arr.every((r) => r && typeof r === 'object' && typeof (r as { id?: unknown }).id === 'number' && typeof (r as { resolved?: unknown }).resolved === 'string');
}

export interface ResolveFileOptions {
  /** Worked examples for a guided run (see resolveAllGuided); omitted for a normal run. */
  examples?: ManualResolutionExample[];
  /**
   * Set only for the single allowed retry after a failed post-resolution
   * check. `original` is the true pre-resolution conflicted content (with
   * markers) from the failed run's result: by this point the file on disk
   * holds that run's marker-free (but check-failing) output, not markers, so
   * it cannot be re-read from disk the way a normal run's `original` is.
   */
  checkOutput?: { command: string; tail: string; original: string };
}

export interface UseSideForBlockResult {
  content: string;
  /**
   * Updated ranges for every block in the file, including the one whose side
   * was just picked (its own current range, at the new location). Callers
   * that only tint AI-authored blocks should drop the picked block id from
   * what they *display*, but MUST still keep its range in whatever they pass
   * back into a further `useSideForBlock` call — the ranges given here are
   * how the location of every other block is re-derived from the immutable
   * `original` snapshot, and a missing entry make a later call fail even
   * though nothing actually changed for that block.
   */
  ranges: { id: number; start: number; end: number }[];
}

export class ConflictResolver {
  private controller: AbortController | null = null;
  /** Manual resolutions recorded for the current operation, keyed by repository path, most recent first. Cleared once the repository's operation ends (see getExamplePaths) or on app exit (in-memory only, never persisted). */
  private examples = new Map<string, ManualResolutionExample[]>();

  constructor(private readonly store: Store, private readonly tools: ToolLocator, private readonly git: GitClient) {}

  private backend(): Promise<{ backend: AiBackend; settings: AiSettings }> {
    return createBackend(this.store, this.tools);
  }

  cancel(): void {
    this.controller?.abort();
    this.controller = null;
  }

  /** True while a resolve/resolveAll run is in flight; used by the update install gate to refuse installing mid-resolution. */
  isActive(): boolean {
    return this.controller !== null;
  }

  async test(): Promise<{ ok: boolean; message: string }> {
    try {
      const { backend, settings } = await this.backend();
      const res = await backend.complete({
        system: 'Reply using the requested JSON schema.',
        prompt: 'Return {"ok": true}.',
        schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false },
        model: settings.model,
        effort: 'low',
      });
      return { ok: true, message: `Connected via ${backend.name === 'anthropic' ? 'the Anthropic API' : 'Claude Code'} (model ${res.model}).` };
    } catch (err) {
      return { ok: false, message: (err as Error).message };
    }
  }

  private async sideCommits(repoPath: string, ref: string, path: string): Promise<string[]> {
    const out = await this.git.tryRun(repoPath, ['log', '--max-count=5', '--format=%h %s', ref, '--', path], { readOnly: true });
    return out ? out.stdout.split('\n').filter(Boolean) : [];
  }

  private sideRefs(op: InProgressOperation): { ours: string; theirs: string | null } {
    switch (op.kind) {
      case 'merge':
        return { ours: 'HEAD', theirs: 'MERGE_HEAD' };
      case 'rebase':
        return { ours: 'HEAD', theirs: 'REBASE_HEAD' };
      case 'cherry-pick':
        return { ours: 'HEAD', theirs: 'CHERRY_PICK_HEAD' };
      case 'revert':
        return { ours: 'HEAD', theirs: 'REVERT_HEAD' };
      default:
        return { ours: 'HEAD', theirs: null };
    }
  }

  async resolveFile(repoPath: string, path: string, report: ProgressReporter, signal: AbortSignal, file?: WorkingFile, opts: ResolveFileOptions = {}): Promise<ConflictResolutionResult> {
    const base: ConflictResolutionResult = { path, ok: false, error: null, blocks: [], staged: false, model: null, provider: null, original: null, check: null, guidedBy: opts.examples?.map((e) => e.path) ?? [] };
    try {
      report(path, 'started', 'Reading conflict…');
      const { backend, settings } = await this.backend();
      base.provider = backend.name;
      const fsPath = toFsPath(repoPath, path);
      // A checkOutput retry's "original" is the true pre-resolution conflicted content carried over
      // from the failed run; the file on disk at this point holds that run's (marker-free) output.
      const original = opts.checkOutput?.original ?? (await readFile(fsPath, 'utf8'));
      base.original = original;
      if (!hasConflictMarkers(original)) {
        if (file?.conflict && file.conflict !== 'both-modified' && file.conflict !== 'both-added') {
          throw new AiError(`This conflict (${file.conflict.replace(/-/g, ' ')}) has no text markers; choose "Use ours" or "Use theirs" instead.`, 'other');
        }
        throw new AiError('No conflict markers found in this file; it may already be resolved.', 'other');
      }
      const parsed = parseConflicts(original);
      if (!parsed.blocks.length) throw new AiError('Conflict markers are malformed; resolve this file manually.', 'other');
      const status = await getStatus(this.git, repoPath);
      const refs = this.sideRefs(status.operation);
      const [oursCommits, theirsCommits] = await Promise.all([this.sideCommits(repoPath, refs.ours, path), refs.theirs ? this.sideCommits(repoPath, refs.theirs, path) : Promise.resolve([])]);
      if (opts.examples?.length) log.info(`AI resolving ${path} guided by manual resolution(s) of: ${opts.examples.map((e) => e.path).join(', ')}`);
      const prompt = buildResolvePrompt({
        filePath: path,
        language: languageFromPath(path),
        operation: status.operation,
        currentBranch: status.branch.name,
        oursLabel: parsed.oursLabel,
        theirsLabel: parsed.theirsLabel,
        oursCommits,
        theirsCommits,
        lines: parsed.lines,
        blocks: parsed.blocks,
        hasBase: parsed.blocks.some((b) => b.base !== null),
        examples: opts.examples,
        checkOutput: opts.checkOutput,
      });
      report(path, 'thinking', `Resolving ${parsed.blocks.length} conflict${parsed.blocks.length === 1 ? '' : 's'} with ${settings.model}…`);
      const response = await backend.complete({
        system: RESOLVE_SYSTEM_PROMPT,
        prompt,
        schema: RESOLUTION_SCHEMA as unknown as Record<string, unknown>,
        model: settings.model,
        effort: settings.effort,
        signal,
        onProgress: (m) => report(path, 'writing', m),
      });
      if (!isResolutionPayload(response.json)) throw new AiError('The model returned an unexpected structure.', 'invalid-output');
      const resolutions = new Map<number, string[]>();
      const meta = new Map<number, { rationale: string; confidence: 'high' | 'medium' | 'low' }>();
      for (const r of response.json.resolutions) {
        if (!parsed.blocks.some((b) => b.id === r.id)) continue;
        if (hasConflictMarkers(r.resolved) || /^(<{7}|={7}|>{7})/m.test(r.resolved)) throw new AiError(`The resolution for conflict ${r.id} still contained conflict markers.`, 'invalid-output');
        resolutions.set(r.id, normalizeResolutionText(r.resolved));
        meta.set(r.id, { rationale: r.rationale ?? '', confidence: r.confidence ?? 'medium' });
      }
      const missing = parsed.blocks.filter((b) => !resolutions.has(b.id));
      if (missing.length) throw new AiError(`The model did not resolve conflict${missing.length > 1 ? 's' : ''} ${missing.map((b) => b.id).join(', ')}.`, 'invalid-output');
      const { content: resolved, ranges } = applyResolutions(parsed, resolutions);
      const blocks: ConflictBlockResolution[] = [...meta.entries()].map(([id, m]) => ({ id, ...m, range: ranges.get(id) ?? { start: 0, end: 0 } }));
      // Guard against the file changing under us while the model was working. Not meaningful for a
      // checkOutput retry: by design the file on disk holds the previous (failed-check) attempt's
      // output at this point, not `original`, so there is nothing to compare it against here.
      if (!opts.checkOutput) {
        const current = await readFile(fsPath, 'utf8');
        if (current !== original) throw new AiError('The file changed while the resolution was being generated; try again.', 'other');
      }
      await writeFile(fsPath, resolved, 'utf8');

      const check = await this.runConfiguredCheck(repoPath, settings, report, path, signal);
      let staged = false;
      if (settings.autoStageAfterResolve && (!check || check.ok)) {
        await markResolved(this.git, repoPath, [path]);
        staged = true;
      }
      report(path, 'done', 'Resolved');
      log.info(`AI resolved ${blocks.length} conflict block(s) in ${path} via ${backend.name}/${response.model}`);
      return { ...base, ok: true, blocks, staged, model: response.model, check };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      report(path, 'error', message);
      return { ...base, ok: false, error: message };
    }
  }

  /**
   * Runs the post-resolution check for the resolved file, if one is configured
   * and (for a repository-provided command) trusted. Returns null when nothing
   * is configured. `signal` must be forwarded: "Resolve all" runs up to three
   * files concurrently, so without it a cancel leaves that many check commands
   * running to completion.
   */
  private async runConfiguredCheck(repoPath: string, settings: AiSettings, report: ProgressReporter, path: string, signal: AbortSignal): Promise<PostResolveCheckResult | null> {
    const repoConfig = await readRepoConfig(repoPath);
    const chosen = resolveCheckCommand({
      userCommand: settings.postResolveCheck,
      repoCommand: repoConfig.postResolveCheck,
      fromRepoEnabled: settings.postResolveCheckFromRepo,
      trusted: this.store.getRepoConfigTrust(repoPath, repoConfig.postResolveCheck),
    });
    if (!chosen) return null;
    report(path, 'writing', `Running ${chosen.fromRepo ? 'the repository' : 'the configured'} check…`);
    const env = await this.git.baseEnv();
    return runPostResolveCheck(chosen.command, repoPath, env, chosen.fromRepo, signal);
  }

  /** Runs an arbitrary check command against the repository, for the Settings "Test command" button. Never gated by trust: the user is typing the command directly in this call. */
  async runCheck(repoPath: string, command: string): Promise<PostResolveCheckResult> {
    const env = await this.git.baseEnv();
    return runPostResolveCheck(command, repoPath, env, false);
  }

  async resolve(repoPath: string, path: string, report: ProgressReporter, checkOutput?: { command: string; tail: string; original: string }): Promise<ConflictResolutionResult> {
    this.controller = new AbortController();
    const status = await getStatus(this.git, repoPath);
    const file = status.files.find((f) => f.path === path);
    return this.resolveFile(repoPath, path, report, this.controller.signal, file, { checkOutput });
  }

  async resolveAll(repoPath: string, report: ProgressReporter): Promise<ConflictResolutionResult[]> {
    this.controller = new AbortController();
    const signal = this.controller.signal;
    const status = await getStatus(this.git, repoPath);
    const conflicted = status.files.filter((f) => f.conflict !== null);
    const results: ConflictResolutionResult[] = [];
    // Resolve a few files concurrently; each request is independent.
    const concurrency = 3;
    let index = 0;
    const worker = async () => {
      while (index < conflicted.length && !signal.aborted) {
        const file = conflicted[index++];
        results.push(await this.resolveFile(repoPath, file.path, report, signal, file));
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, conflicted.length) }, worker));
    return results.sort((a, b) => a.path.localeCompare(b.path));
  }

  /** Resolves every remaining conflicted file, guided by the manual resolutions recorded for this operation (see recordExample). */
  async resolveAllGuided(repoPath: string, report: ProgressReporter): Promise<ConflictResolutionResult[]> {
    this.controller = new AbortController();
    const signal = this.controller.signal;
    const status = await getStatus(this.git, repoPath);
    const conflicted = status.files.filter((f) => f.conflict !== null);
    const examples = capExamples(await this.getExamples(repoPath));
    const results: ConflictResolutionResult[] = [];
    const concurrency = 3;
    let index = 0;
    const worker = async () => {
      while (index < conflicted.length && !signal.aborted) {
        const file = conflicted[index++];
        results.push(await this.resolveFile(repoPath, file.path, report, signal, file, { examples }));
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, conflicted.length) }, worker));
    return results.sort((a, b) => a.path.localeCompare(b.path));
  }

  /** Records a manual resolution (edited by hand, or via per-block side selection) as a worked example for the rest of this operation. Silently ignored when `original` has no parseable conflict blocks. */
  recordExample(repoPath: string, path: string, original: string, resolved: string): void {
    const example = trimManualResolution({ path, original, resolved });
    if (!example) return;
    const existing = (this.examples.get(repoPath) ?? []).filter((e) => e.path !== path);
    this.examples.set(repoPath, [example, ...existing]);
  }

  /** Raw (uncapped) examples for a repository; use capExamples before sending to the model. Clears and returns empty once the operation has ended. */
  private async getExamples(repoPath: string): Promise<ManualResolutionExample[]> {
    const status = await getStatus(this.git, repoPath);
    if (status.operation.kind === 'none') {
      this.examples.delete(repoPath);
      return [];
    }
    return this.examples.get(repoPath) ?? [];
  }

  /** Paths available as "Resolve remaining like …" examples right now. */
  async getExamplePaths(repoPath: string): Promise<string[]> {
    return (await this.getExamples(repoPath)).map((e) => e.path);
  }

  clearExamples(repoPath: string): void {
    this.examples.delete(repoPath);
  }

  /**
   * Rewrites a single conflict block from the pre-resolution `original`
   * snapshot to one side, leaving every other block's AI resolution intact.
   * `ranges` must be the caller's current record of where each block's AI
   * resolution sits in the file (as returned by the last resolve/guided run);
   * this is used to both locate the other blocks' text and to detect drift
   * (refusing if the file on disk no longer matches what those ranges say).
   */
  async useSideForBlock(repoPath: string, path: string, original: string, ranges: { id: number; start: number; end: number }[], blockId: number, side: 'ours' | 'theirs' | 'base'): Promise<UseSideForBlockResult> {
    const fsPath = toFsPath(repoPath, path);
    const current = await readFile(fsPath, 'utf8');
    const parsed = parseConflicts(original);
    if (!parsed.blocks.length) throw new AiError('Conflict markers are malformed; resolve this file manually.', 'other');
    const rangeById = new Map(ranges.map((r) => [r.id, r]));
    const { lines: curLines } = splitLines(current);
    const verify = new Map<number, string[]>();
    for (const block of parsed.blocks) {
      const r = rangeById.get(block.id);
      if (!r) throw new AiError('Missing resolution data for this file; resolve it again.', 'other');
      verify.set(block.id, curLines.slice(r.start, r.end));
    }
    const { content: reconstructed } = applyResolutions(parsed, verify);
    if (reconstructed !== current) throw new AiError('The file changed on disk since it was resolved; try again.', 'other');
    const target = parsed.blocks.find((b) => b.id === blockId);
    if (!target) throw new AiError('That conflict block no longer exists in this file.', 'other');
    if (side === 'base' && !target.base) throw new AiError('This conflict has no base version to restore.', 'other');
    const final = new Map(verify);
    final.set(blockId, resolutionForChoice(target, side as BlockChoice));
    const { content, ranges: newRanges } = applyResolutions(parsed, final);
    await writeFile(fsPath, content, 'utf8');
    const outRanges = [...newRanges.entries()].map(([id, r]) => ({ id, ...r }));
    return { content, ranges: outRanges };
  }

  async commitMessage(repoPath: string, paths: string[]): Promise<{ summary: string; description: string }> {
    const { backend, settings } = await this.backend();
    const status = await getStatus(this.git, repoPath);
    const files = status.files.filter((f) => paths.includes(f.path));
    if (!files.length) throw new AiError('Select at least one changed file first.', 'other');
    const { patch, truncated, stat } = await getPatchForFiles(this.git, repoPath, files, 120_000);
    this.controller = new AbortController();
    const response = await backend.complete({
      system: COMMIT_MESSAGE_SYSTEM_PROMPT,
      prompt: buildCommitMessagePrompt(stat, patch, truncated, status.branch.name),
      schema: COMMIT_MESSAGE_SCHEMA as unknown as Record<string, unknown>,
      model: settings.model,
      effort: settings.effort === 'max' ? 'high' : settings.effort,
      signal: this.controller.signal,
    });
    const json = response.json as { summary?: unknown; description?: unknown };
    const summary = typeof json.summary === 'string' ? json.summary.trim().replace(/\.$/, '') : '';
    if (!summary) throw new AiError('The model returned an empty summary.', 'invalid-output');
    return { summary, description: typeof json.description === 'string' ? json.description.trim() : '' };
  }
}
