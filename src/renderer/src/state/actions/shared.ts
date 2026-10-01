import type { UncommittedChangesStrategy, AppSettings } from '@shared/types';
import type { OperationOutcome } from '@shared/ipc';
import { invoke } from '../../api';
import { openDialog, showToast, store } from '../store';
import { refreshAll } from './repo';
import { hasUncommittedChanges } from './branches';

export function applyTheme(settings: AppSettings | null, systemDark: boolean): void {
  const theme = settings?.theme ?? 'system';
  const dark = theme === 'dark' || (theme === 'system' && systemDark);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  // Browser/PWA chrome (status bar, address bar) matches the toolbar surface, --bg-subtle.
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#161b22' : '#f6f8fa');
  store.set({ dark });
}

export function reportOutcome(outcome: OperationOutcome | undefined, verb: string): void {
  if (!outcome) return;
  if (outcome.status === 'conflicts') {
    void refreshAll().then(() => openDialog({ kind: 'conflicts' }));
  } else if (outcome.status === 'up-to-date') {
    showToast({ kind: 'info', title: 'Already up to date' });
  } else if (outcome.status === 'complete') {
    showToast({ kind: 'success', title: `${verb} complete` });
  }
}

/** Re-checks every path with an active confidence tint against what is actually on disk, dropping any whose content no longer matches the snapshot taken right after it was resolved (see the "Tints cleared on external edit" scenario). */
export async function pruneStaleConflictTints(repoPath: string): Promise<void> {
  const tracked = Object.keys(store.get().conflictResolutions);
  if (!tracked.length) return;
  await Promise.all(
    tracked.map(async (path) => {
      const expected = store.get().conflictSnapshots[path];
      if (expected === undefined) return;
      let actual: string | null;
      try {
        actual = await invoke('repo.readFile', repoPath, path);
      } catch {
        actual = null;
      }
      if (actual !== expected) {
        store.set((s) => {
          const conflictResolutions = { ...s.conflictResolutions };
          delete conflictResolutions[path];
          const conflictSnapshots = { ...s.conflictSnapshots };
          delete conflictSnapshots[path];
          const conflictBlockRanges = { ...s.conflictBlockRanges };
          delete conflictBlockRanges[path];
          return { conflictResolutions, conflictSnapshots, conflictBlockRanges, checkBanner: s.checkBanner?.path === path ? null : s.checkBanner };
        });
      }
    }),
  );
}

/** Captures the pre-resolution conflicted content the first time a path is seen as conflicted, so a later manual resolution can be recorded as a worked example. A no-op once already captured (edits after the first load must not overwrite the true original). */
export function captureConflictOriginal(path: string, content: string): void {
  store.set((s) => (s.conflictOriginals[path] !== undefined ? {} : { conflictOriginals: { ...s.conflictOriginals, [path]: content } }));
}

export async function withUncommittedChanges(targetLabel: string, perform: (strategy: UncommittedChangesStrategy) => Promise<void>): Promise<void> {
  const settings = store.get().settings;
  const strategy = settings?.uncommittedChangesStrategy ?? 'ask';
  if (!hasUncommittedChanges()) {
    await perform('move');
    return;
  }
  if (strategy === 'ask') {
    openDialog({ kind: 'uncommitted-changes', targetLabel, proceed: perform });
    return;
  }
  await perform(strategy);
}
