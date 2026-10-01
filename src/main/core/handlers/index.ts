import type { ApiMethodName, ApiMethods, EventPayloads } from '@shared/ipc';
import type { GitErrorInfo, IpcResult } from '@shared/types';
import { AiError } from '../../ai/backends';
import { guardAiHandlers } from '../../ai/repo-guard';
import type { ErrorExplainService } from '../../ai/error-explain';
import type { ExplainService } from '../../ai/explain';
import type { NlPaletteService } from '../../ai/nlPalette';
import type { PrDraftService } from '../../ai/prDraft';
import type { RebasePlanService } from '../../ai/rebasePlan';
import type { ReleaseNotesService } from '../../ai/release-notes';
import type { ConflictResolver } from '../../ai/resolver';
import type { ReviewService } from '../../ai/review';
import type { SplitterService } from '../../ai/splitter';
import type { TriageService } from '../../ai/triage';
import type { InboxPoller } from '../../gh/inbox-poller';
import type { SettingsSyncService } from '../../gh/settings-sync';
import { toGitErrorInfo, type GitClient } from '../../git/git';
import { scopeRepoHandlers } from '../client-context';
import type { GhClient } from '../../gh/gh';
import { log } from '../../logger';
import { readRepoConfig } from '../../repo/config';
import type { RepositoryManager } from '../../repo/manager';
import type { WatchedFolderScanner } from '../../repo/watched-folders';
import type { Store } from '../../store';
import type { ToolLocator } from '../../tools';
import type { Updater } from '../../update/updater';
import { UnsupportedCapabilityError, type HostCapabilities } from '../host';
import { createHandlerContext } from './context';
import { appHandlers } from './app';
import { ghHandlers } from './gh';
import { repoHandlers } from './repo';
import { gitReadHandlers } from './gitRead';
import { gitWriteHandlers } from './gitWrite';
import { aiHandlers } from './ai';

/** Everything the handlers need, transport-agnostic: services, the native host, the event bus emitter, and the shared busy set. */
export interface HandlerDeps {
  store: Store;
  tools: ToolLocator;
  git: GitClient;
  gh: GhClient;
  repos: RepositoryManager;
  resolver: ConflictResolver;
  review: ReviewService;
  splitter: SplitterService;
  triage: TriageService;
  prDraft: PrDraftService;
  rebasePlan: RebasePlanService;
  releaseNotes: ReleaseNotesService;
  nlPalette: NlPaletteService;
  explain: ExplainService;
  errorExplain: ErrorExplainService;
  inbox: InboxPoller;
  settingsSync: SettingsSyncService;
  updater: Updater;
  watchedFolders: WatchedFolderScanner;
  host: HostCapabilities;
  emit: <K extends keyof EventPayloads>(event: K, payload: EventPayloads[K]) => void;
  busy: Set<string>;
}

function toErrorInfo(err: unknown): GitErrorInfo {
  if (err instanceof UnsupportedCapabilityError) {
    return { message: err.message, command: '', exitCode: null, stderr: '', stdout: '', code: 'unsupported' };
  }
  if (err instanceof AiError) {
    const code = err.kind === 'not-configured' ? 'ai-not-configured' : err.kind === 'cancelled' ? 'cancelled' : err.kind === 'stale' ? 'split-stale' : 'unknown';
    return { message: err.message, command: '', exitCode: null, stderr: '', stdout: '', code };
  }
  return toGitErrorInfo(err);
}

/** The transport-agnostic dispatch function: runs a handler and wraps the outcome in the `IpcResult` shape. */
export type CoreDispatch = (method: ApiMethodName, args: unknown[]) => Promise<IpcResult<unknown>>;

/** The handler registry plus its `dispatch` wrapper, mounted by both the Electron app and the server. */
export interface CoreHandlers {
  handlers: ApiMethods;
  dispatch: CoreDispatch;
}

/**
 * Builds the transport-agnostic handler registry and a `dispatch` that wraps a
 * call in the `IpcResult` shape. The Electron app binds this to `ipcMain`; the
 * server binds it to `POST /invoke`.
 */
export function createHandlers(deps: HandlerDeps): CoreHandlers {
  const { nlPalette, repos } = deps;
  const ctx = createHandlerContext(deps);

  const handlers: ApiMethods = {
    ...appHandlers(ctx),
    ...ghHandlers(ctx),
    ...repoHandlers(ctx),
    ...gitReadHandlers(ctx),
    ...gitWriteHandlers(ctx),
    ...aiHandlers(ctx),
  };

  // One chokepoint for the per-repository AI opt-out: the local toggle (Repositories menu) or `"ai": false` in .gitgood/config.json.
  guardAiHandlers(handlers as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>, async (repoPath) => {
    if ((await repos.policyRepo(repoPath))?.aiDisabled) return 'AI is turned off for this repository on this machine. Turn it back on from the repository list menu.';
    if (!(await readRepoConfig(repoPath)).ai) return 'AI is turned off for this repository by "ai": false in .gitgood/config.json.';
    return null;
  });

  // A repository's chosen GitHub account applies to every gh/git call its handlers make (see ToolLocator.repoAccount).
  scopeRepoHandlers(handlers as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>);

  // The palette's execution step calls back into these same handlers (never a shell, never a
  // bespoke code path) so it gets identical behaviour to a manual action for the same ApiMethods key.
  nlPalette.setDispatcher(async (action, repoPath, args) => (handlers[action] as (...a: unknown[]) => Promise<unknown>)(repoPath, ...args));

  const dispatch = async (method: ApiMethodName, args: unknown[]): Promise<IpcResult<unknown>> => {
    const handler = handlers[method] as ((...a: unknown[]) => Promise<unknown>) | undefined;
    if (!handler) return { ok: false, error: { message: `Unknown method ${String(method)}`, command: '', exitCode: null, stderr: '', stdout: '', code: 'unknown' } };
    try {
      const value = await handler(...args);
      return { ok: true, value };
    } catch (err) {
      const info = toErrorInfo(err);
      if (info.code !== 'cancelled') log.warn(`${method} failed: ${info.message.split('\n')[0]}`);
      return { ok: false, error: info };
    }
  };

  return { handlers, dispatch };
}
