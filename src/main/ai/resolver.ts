import { readFile, writeFile } from 'node:fs/promises';
import type { AiSettings, ConflictBlockResolution, ConflictResolutionResult, InProgressOperation, WorkingFile } from '@shared/types';
import { applyResolutions, hasConflictMarkers, normalizeResolutionText, parseConflicts } from '@shared/diff/conflicts';
import { languageFromPath } from '@shared/util';
import { toFsPath, getPatchForFiles } from '../git/diff';
import type { GitClient } from '../git/git';
import { markResolved } from '../git/operations';
import { getStatus } from '../git/status';
import { log } from '../logger';
import type { Store } from '../store';
import type { ToolLocator } from '../tools';
import { AiError, AnthropicBackend, ClaudeCliBackend, type AiBackend } from './backends';
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

export class ConflictResolver {
  private controller: AbortController | null = null;

  constructor(private readonly store: Store, private readonly tools: ToolLocator, private readonly git: GitClient) {}

  private async backend(): Promise<{ backend: AiBackend; settings: AiSettings }> {
    const settings = this.store.getSettings().ai;
    if (settings.provider === 'disabled') throw new AiError('AI features are turned off. Enable them in Options → AI.', 'not-configured');
    if (settings.provider === 'claude-cli') {
      const path = this.tools.claudePath();
      if (!path) throw new AiError('Claude Code CLI was not found. Install it or switch to an Anthropic API key in Options → AI.', 'not-configured');
      return { backend: new ClaudeCliBackend(path, await this.tools.env()), settings };
    }
    const key = this.store.getApiKey();
    if (!key && !process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
      throw new AiError('No Anthropic API key is configured. Add one in Options → AI, or switch to the Claude Code CLI.', 'not-configured');
    }
    return { backend: new AnthropicBackend(key), settings };
  }

  cancel(): void {
    this.controller?.abort();
    this.controller = null;
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

  async resolveFile(repoPath: string, path: string, report: ProgressReporter, signal: AbortSignal, file?: WorkingFile): Promise<ConflictResolutionResult> {
    const base: ConflictResolutionResult = { path, ok: false, error: null, blocks: [], staged: false, model: null, provider: null, original: null };
    try {
      report(path, 'started', 'Reading conflict…');
      const { backend, settings } = await this.backend();
      base.provider = backend.name;
      const fsPath = toFsPath(repoPath, path);
      const original = await readFile(fsPath, 'utf8');
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
      const blocks: ConflictBlockResolution[] = [];
      for (const r of response.json.resolutions) {
        if (!parsed.blocks.some((b) => b.id === r.id)) continue;
        if (hasConflictMarkers(r.resolved) || /^(<{7}|={7}|>{7})/m.test(r.resolved)) throw new AiError(`The resolution for conflict ${r.id} still contained conflict markers.`, 'invalid-output');
        resolutions.set(r.id, normalizeResolutionText(r.resolved));
        blocks.push({ id: r.id, rationale: r.rationale ?? '', confidence: r.confidence ?? 'medium' });
      }
      const missing = parsed.blocks.filter((b) => !resolutions.has(b.id));
      if (missing.length) throw new AiError(`The model did not resolve conflict${missing.length > 1 ? 's' : ''} ${missing.map((b) => b.id).join(', ')}.`, 'invalid-output');
      const resolved = applyResolutions(parsed, resolutions);
      // Guard against the file changing under us while the model was working.
      const current = await readFile(fsPath, 'utf8');
      if (current !== original) throw new AiError('The file changed while the resolution was being generated; try again.', 'other');
      await writeFile(fsPath, resolved, 'utf8');
      let staged = false;
      if (settings.autoStageAfterResolve) {
        await markResolved(this.git, repoPath, [path]);
        staged = true;
      }
      report(path, 'done', 'Resolved');
      log.info(`AI resolved ${blocks.length} conflict block(s) in ${path} via ${backend.name}/${response.model}`);
      return { ...base, ok: true, blocks, staged, model: response.model };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      report(path, 'error', message);
      return { ...base, ok: false, error: message };
    }
  }

  async resolve(repoPath: string, path: string, report: ProgressReporter): Promise<ConflictResolutionResult> {
    this.controller = new AbortController();
    const status = await getStatus(this.git, repoPath);
    const file = status.files.find((f) => f.path === path);
    return this.resolveFile(repoPath, path, report, this.controller.signal, file);
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
