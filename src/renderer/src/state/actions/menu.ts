import { invoke } from '../../api';
import { openDialog, showToast, store } from '../store';
import { reviewBranch, reviewCurrentPullRequest } from '../review';
import { tidyBranch } from '../rebase';
import { openSplitDialog } from '../split';
import { openInboxItemById, toggleInboxPanel } from '../inbox';
import { openCommandPalette } from '../nlPalette';
import { undoLastOperation } from '../reflog';
import { scanWatchedFolders } from './repo';
import { searchHistoryForSelection, setView, toggleBlame } from './view';
import { fetchRemote, pull, pushWithErrorHandling, updateFromDefaultBranch } from './branches';
import { requestDiscard, stashAll } from './stash';
import { compareOnGitHub, draftPullRequest, openExternal, openIssuesDialog, openPullRequestFlow, openReleaseNotes, viewOnGitHub } from './github';
import { checkForUpdates, openHealth, openInEditor, openInShell, showInFolder, updateSettings } from './app';

// ---------------------------------------------------------------------------
// Menu
// ---------------------------------------------------------------------------

export async function handleMenuAction(action: string, args?: unknown): Promise<void> {
  const s = store.get();
  const repo = s.currentRepo;
  const needsRepo = () => {
    if (!repo) showToast({ kind: 'info', title: 'Open a repository first' });
    return !!repo;
  };
  switch (action) {
    case 'new-repository':
      return openDialog({ kind: 'new-repo' });
    case 'add-local-repository':
      return openDialog({ kind: 'add-repo' });
    case 'clone-repository':
      return openDialog({ kind: 'clone' });
    case 'settings':
      return openDialog({ kind: 'settings' });
    case 'command-palette':
      return openCommandPalette();
    case 'export-settings':
      return openDialog({ kind: 'export-settings' });
    case 'import-settings':
      return openDialog({ kind: 'import-settings' });
    case 'show-changes':
      return setView('changes');
    case 'show-history':
      return setView('history');
    case 'show-stashes':
      if (needsRepo()) return setView('stashes');
      return;
    case 'show-worktrees':
      if (needsRepo()) openDialog({ kind: 'worktrees' });
      return;
    case 'show-submodules':
      if (needsRepo()) openDialog({ kind: 'submodules' });
      return;
    case 'show-lfs':
      if (needsRepo()) openDialog({ kind: 'lfs' });
      return;
    case 'show-health':
      if (needsRepo()) return openHealth();
      return;
    case 'show-reflog':
      if (needsRepo()) openDialog({ kind: 'reflog' });
      return;
    case 'undo-last-operation':
      if (needsRepo()) return undoLastOperation();
      return;
    case 'show-repository-list':
      return store.set((st) => ({ popover: st.popover === 'repos' ? null : 'repos' }));
    case 'show-branches-list':
      if (needsRepo()) store.set((st) => ({ popover: st.popover === 'branches' ? null : 'branches' }));
      return;
    case 'focus-commit-summary':
      setView('changes');
      document.getElementById('commit-summary')?.focus();
      return;
    case 'toggle-split-diff':
      return updateSettings({ diffViewMode: s.settings?.diffViewMode === 'split' ? 'unified' : 'split' });
    case 'toggle-whitespace':
      return updateSettings({ diffHideWhitespace: !s.settings?.diffHideWhitespace });
    case 'toggle-blame':
      return toggleBlame();
    case 'toggle-history-graph':
      return updateSettings({ historyGraph: !s.settings?.historyGraph });
    case 'zoom-in':
    case 'zoom-out':
    case 'zoom-reset':
      await invoke('app.zoom', action === 'zoom-in' ? 'in' : action === 'zoom-out' ? 'out' : 'reset');
      return;
    case 'push':
      if (needsRepo()) return pushWithErrorHandling();
      return;
    case 'pull':
      if (needsRepo()) return pull();
      return;
    case 'fetch':
      if (needsRepo()) return fetchRemote();
      return;
    case 'scan-watched-folders':
      return void scanWatchedFolders();
    case 'remove-repository':
      if (repo) openDialog({ kind: 'remove-repo', repo });
      return;
    case 'view-on-github':
      return viewOnGitHub();
    case 'open-in-shell':
      if (needsRepo()) return openInShell();
      return;
    case 'show-in-folder':
      if (needsRepo()) return showInFolder();
      return;
    case 'open-in-editor':
      if (needsRepo()) return openInEditor();
      return;
    case 'create-issue':
      if (repo?.github) void openExternal(`${repo.github.url}/issues/new`);
      return;
    case 'show-issues':
      if (needsRepo()) openIssuesDialog();
      return;
    case 'show-inbox':
      return toggleInboxPanel();
    case 'open-inbox-item':
      return openInboxItemById((args as { id: string }).id);
    case 'repository-settings':
      if (needsRepo()) openDialog({ kind: 'repo-settings' });
      return;
    case 'release-notes':
      if (needsRepo()) openReleaseNotes();
      return;
    case 'split-commits':
      if (needsRepo()) openSplitDialog();
      return;
    case 'tidy-branch-ai':
      if (needsRepo()) tidyBranch();
      return;
    case 'new-branch':
      if (needsRepo()) openDialog({ kind: 'new-branch' });
      return;
    case 'rename-branch':
      if (repo && s.status?.branch.name) openDialog({ kind: 'rename-branch', branch: s.status.branch.name });
      return;
    case 'delete-branch': {
      const current = s.branches.find((b) => b.isCurrent);
      if (repo && current) openDialog({ kind: 'delete-branch', branch: current });
      return;
    }
    case 'discard-all-changes':
      if (repo && s.status?.files.length) requestDiscard(s.status.files.map((f) => f.path), true);
      return;
    case 'stash-all-changes':
      if (repo && s.status?.files.length) return stashAll();
      return;
    case 'update-from-default':
      if (needsRepo()) return updateFromDefaultBranch();
      return;
    case 'compare-branch':
      if (needsRepo()) openDialog({ kind: 'compare' });
      return;
    case 'merge-branch':
      if (needsRepo()) openDialog({ kind: 'merge', squash: false });
      return;
    case 'squash-merge-branch':
      if (needsRepo()) openDialog({ kind: 'merge', squash: true });
      return;
    case 'rebase-branch':
      if (needsRepo()) openDialog({ kind: 'rebase' });
      return;
    case 'compare-on-github':
      return compareOnGitHub();
    case 'view-pull-request':
      if (s.prs.current) void openExternal(s.prs.current.url);
      else showToast({ kind: 'info', title: 'No pull request for this branch' });
      return;
    case 'create-pull-request':
      if (needsRepo()) return openPullRequestFlow();
      return;
    case 'review-branch':
      if (needsRepo()) reviewBranch();
      return;
    case 'review-pull-request':
      if (needsRepo()) reviewCurrentPullRequest();
      return;
    case 'draft-pull-request-ai':
      if (needsRepo()) return draftPullRequest();
      return;
    case 'keyboard-shortcuts':
      return openDialog({ kind: 'shortcuts' });
    case 'show-logs': {
      const info = await invoke('app.info');
      await invoke('app.showItemInFolder', info.logPath);
      return;
    }
    case 'about':
      return openDialog({ kind: 'about' });
    case 'check-for-updates':
      return checkForUpdates();
    case 'find':
      if (s.view === 'history') document.getElementById('history-search')?.focus();
      else document.getElementById('changes-filter')?.focus();
      return;
    case 'search-history-selection': {
      const text = window.getSelection()?.toString() ?? '';
      if (!needsRepo()) return;
      if (text.trim()) searchHistoryForSelection(text);
      else showToast({ kind: 'info', title: 'Select some text in the diff first' });
      return;
    }
    default:
      return;
  }
}
