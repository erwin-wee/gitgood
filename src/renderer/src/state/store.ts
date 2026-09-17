import { useSyncExternalStore } from 'react';
import type { AiResolveProgressEvent, AppSettings, Branch, Commit, CommitDetails, CommitFile, FileDiff, GitErrorInfo, ProgressEvent, PullRequest, Remote, RepositoryInfo, RepositoryStatus, Stash, Tag, ToolsState } from '@shared/types';

export type View = 'changes' | 'history';
export type Popover = 'repos' | 'branches' | null;
export type SettingsTab = 'accounts' | 'integrations' | 'git' | 'appearance' | 'prompts' | 'ai' | 'advanced';
export type RepoSettingsTab = 'remote' | 'ignored' | 'identity' | 'alias';

export interface Toast {
  id: number;
  kind: 'success' | 'error' | 'info' | 'warning';
  title: string;
  message?: string;
  action?: { label: string; onClick: () => void };
  sticky?: boolean;
}

export type DialogState =
  | { kind: 'clone'; url?: string }
  | { kind: 'new-repo' }
  | { kind: 'add-repo' }
  | { kind: 'new-branch'; startPoint?: string | null; startPointLabel?: string }
  | { kind: 'rename-branch'; branch: string }
  | { kind: 'delete-branch'; branch: Branch }
  | { kind: 'merge'; squash: boolean; preselect?: string }
  | { kind: 'rebase'; preselect?: string }
  | { kind: 'compare' }
  | { kind: 'discard'; paths: string[]; all: boolean }
  | { kind: 'discard-lines'; path: string; patch: string; count: number }
  | { kind: 'create-pr' }
  | { kind: 'pr-details'; pr: PullRequest }
  | { kind: 'settings'; tab?: SettingsTab }
  | { kind: 'about' }
  | { kind: 'repo-settings'; tab?: RepoSettingsTab }
  | { kind: 'squash'; shas: string[]; targetSha: string }
  | { kind: 'reword'; commit: Commit }
  | { kind: 'tag'; sha: string }
  | { kind: 'publish' }
  | { kind: 'force-push' }
  | { kind: 'sign-in' }
  | { kind: 'error'; title: string; error: GitErrorInfo | string; retry?: () => void }
  | { kind: 'conflicts' }
  | { kind: 'uncommitted-changes'; targetLabel: string; proceed: (strategy: 'stash' | 'move') => Promise<void> }
  | { kind: 'shortcuts' }
  | { kind: 'remove-repo'; repo: RepositoryInfo }
  | { kind: 'cherry-pick'; shas: string[] }
  | { kind: 'stash-conflict'; stash: Stash }
  | { kind: 'confirm'; title: string; message: string; confirmLabel: string; danger?: boolean; onConfirm: () => void | Promise<void>; checkbox?: { label: string; onChange: (v: boolean) => void } }
  | { kind: 'edit-commit-message'; sha: string };

export interface ChangesState {
  selectedPaths: string[];
  excluded: string[];
  partial: Record<string, string[]>;
  summary: string;
  description: string;
  coAuthors: { name: string; email: string }[];
  showCoAuthors: boolean;
  amend: boolean;
  committing: boolean;
  showingStash: Stash | null;
  stashFiles: CommitFile[];
  stashSelectedFile: string | null;
}

export interface HistoryState {
  commits: Commit[];
  hasMore: boolean;
  loading: boolean;
  search: string;
  selectedShas: string[];
  details: CommitDetails | null;
  detailsLoading: boolean;
  selectedFile: string | null;
  dragging: string[] | null;
}

export interface DiffState {
  key: string | null;
  diff: FileDiff | null;
  loading: boolean;
  error: string | null;
  /** Selected line keys "hunk:line" for the working diff (partial commit). */
  selectedLines: string[] | null;
}

export interface AppState {
  settings: AppSettings | null;
  tools: ToolsState | null;
  dark: boolean;
  repos: RepositoryInfo[];
  currentRepo: RepositoryInfo | null;
  status: RepositoryStatus | null;
  statusLoading: boolean;
  branches: Branch[];
  defaultBranch: string | null;
  stashes: Stash[];
  tags: Tag[];
  remotes: Remote[];
  view: View;
  changes: ChangesState;
  history: HistoryState;
  diff: DiffState;
  prs: { list: PullRequest[]; loading: boolean; current: PullRequest | null; loadedAt: number; error: string | null };
  dialog: DialogState | null;
  dialogStack: DialogState[];
  popover: Popover;
  toasts: Toast[];
  progress: Record<string, ProgressEvent>;
  operation: string | null;
  ai: Record<string, AiResolveProgressEvent>;
  aiBusy: boolean;
  aiCommitBusy: boolean;
  login: { inProgress: boolean; code: string | null; url: string | null; error: string | null };
  sidebarWidth: number;
  focused: boolean;
  lastSuccessfulMerge: { branch: string; at: number } | null;
  avatars: Record<string, string | null>;
}

export const initialChanges: ChangesState = {
  selectedPaths: [],
  excluded: [],
  partial: {},
  summary: '',
  description: '',
  coAuthors: [],
  showCoAuthors: false,
  amend: false,
  committing: false,
  showingStash: null,
  stashFiles: [],
  stashSelectedFile: null,
};

export const initialHistory: HistoryState = { commits: [], hasMore: false, loading: false, search: '', selectedShas: [], details: null, detailsLoading: false, selectedFile: null, dragging: null };

export const initialDiff: DiffState = { key: null, diff: null, loading: false, error: null, selectedLines: null };

const initialState: AppState = {
  settings: null,
  tools: null,
  dark: window.matchMedia('(prefers-color-scheme: dark)').matches,
  repos: [],
  currentRepo: null,
  status: null,
  statusLoading: false,
  branches: [],
  defaultBranch: null,
  stashes: [],
  tags: [],
  remotes: [],
  view: 'changes',
  changes: initialChanges,
  history: initialHistory,
  diff: initialDiff,
  prs: { list: [], loading: false, current: null, loadedAt: 0, error: null },
  dialog: null,
  dialogStack: [],
  popover: null,
  toasts: [],
  progress: {},
  operation: null,
  ai: {},
  aiBusy: false,
  aiCommitBusy: false,
  login: { inProgress: false, code: null, url: null, error: null },
  sidebarWidth: 300,
  focused: true,
  lastSuccessfulMerge: null,
  avatars: {},
};

type Listener = () => void;

class Store {
  private state: AppState = initialState;
  private listeners = new Set<Listener>();

  get = (): AppState => this.state;

  set = (patch: Partial<AppState> | ((s: AppState) => Partial<AppState>)): void => {
    const p = typeof patch === 'function' ? patch(this.state) : patch;
    let changed = false;
    for (const k of Object.keys(p) as (keyof AppState)[]) {
      if (!Object.is(this.state[k], p[k])) {
        changed = true;
        break;
      }
    }
    if (!changed) return;
    this.state = { ...this.state, ...p };
    for (const l of this.listeners) l();
  };

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
}

export const store = new Store();

export function useAppStore<R>(selector: (s: AppState) => R): R {
  return useSyncExternalStore(store.subscribe, () => selector(store.get()), () => selector(store.get()));
}

export function patchChanges(patch: Partial<ChangesState> | ((c: ChangesState) => Partial<ChangesState>)): void {
  store.set((s) => ({ changes: { ...s.changes, ...(typeof patch === 'function' ? patch(s.changes) : patch) } }));
}

export function patchHistory(patch: Partial<HistoryState> | ((h: HistoryState) => Partial<HistoryState>)): void {
  store.set((s) => ({ history: { ...s.history, ...(typeof patch === 'function' ? patch(s.history) : patch) } }));
}

export function patchDiff(patch: Partial<DiffState>): void {
  store.set((s) => ({ diff: { ...s.diff, ...patch } }));
}

let toastId = 0;
export function showToast(toast: Omit<Toast, 'id'>, timeoutMs = 6000): number {
  const id = ++toastId;
  store.set((s) => ({ toasts: [...s.toasts, { ...toast, id }] }));
  if (!toast.sticky) setTimeout(() => dismissToast(id), timeoutMs);
  return id;
}

export function dismissToast(id: number): void {
  store.set((s) => (s.toasts.some((t) => t.id === id) ? { toasts: s.toasts.filter((t) => t.id !== id) } : {}));
}

export function openDialog(dialog: DialogState): void {
  store.set((s) => ({ dialog, dialogStack: s.dialog ? [...s.dialogStack, s.dialog] : s.dialogStack, popover: null }));
}

export function closeDialog(): void {
  store.set((s) => {
    const stack = [...s.dialogStack];
    const previous = stack.pop() ?? null;
    return { dialog: previous, dialogStack: stack };
  });
}

export function closeAllDialogs(): void {
  store.set({ dialog: null, dialogStack: [] });
}

export function setPopover(popover: Popover): void {
  store.set((s) => ({ popover: s.popover === popover ? null : popover }));
}
