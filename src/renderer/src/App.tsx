import React, { useEffect, useRef, useState } from 'react';
import { bootstrap, setView } from './state/actions';
import { store, useAppStore } from './state/store';
import { Banners } from './components/Banners';
import { ChangesTab } from './components/ChangesTab';
import { Dialogs } from './components/dialogs';
import { DiffPane } from './components/diff/DiffPane';
import { HealthView } from './components/HealthView';
import { CommitDetailsPane, HistoryTab } from './components/HistoryTab';
import { InboxPanel } from './components/Inbox';
import { SetupScreen } from './components/Setup';
import { StashesView } from './components/StashesTab';
import { Toasts } from './components/Toasts';
import { Toolbar } from './components/Toolbar';
import { ContextMenuHost, Icon } from './components/ui';
import { Welcome } from './components/Welcome';
import { ReviewView } from './components/review/ReviewView';

function useSidebarResize(): { width: number; onMouseDown: (e: React.MouseEvent) => void; active: boolean } {
  const width = useAppStore((s) => s.sidebarWidth);
  const [active, setActive] = useState(false);
  const dragging = useRef<{ startX: number; startWidth: number } | null>(null);
  const onMouseDown = (e: React.MouseEvent) => {
    dragging.current = { startX: e.clientX, startWidth: width };
    setActive(true);
    e.preventDefault();
  };
  useEffect(() => {
    const move = (e: MouseEvent) => {
      const d = dragging.current;
      if (!d) return;
      const next = Math.max(220, Math.min(window.innerWidth * 0.6, d.startWidth + e.clientX - d.startX));
      store.set({ sidebarWidth: next });
    };
    const up = () => {
      if (dragging.current) {
        dragging.current = null;
        setActive(false);
      }
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    return () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
  }, []);
  return { width, onMouseDown, active };
}

export function App(): React.JSX.Element {
  const settingsLoaded = useAppStore((s) => s.settings !== null);
  const tools = useAppStore((s) => s.tools);
  const repo = useAppStore((s) => s.currentRepo);
  const view = useAppStore((s) => s.view);
  const status = useAppStore((s) => s.status);
  const changes = useAppStore((s) => s.changes);
  const history = useAppStore((s) => s.history);
  const stashesView = useAppStore((s) => s.stashesView);
  const reviewOpen = useAppStore((s) => s.review.open);
  const reviewPath = useAppStore((s) => s.review.selectedPath);
  const reviewFile = useAppStore((s) => s.review.run?.files.find((f) => f.file.path === s.review.selectedPath)?.file ?? null);
  const { width, onMouseDown, active } = useSidebarResize();

  useEffect(() => {
    void bootstrap();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && !e.shiftKey && (e.key === '1' || e.key === '2')) {
        e.preventDefault();
        setView(e.key === '1' ? 'changes' : 'history');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const gitMissing = tools !== null && !tools.git.installed;

  let content: React.ReactNode;
  if (!settingsLoaded) {
    content = <div className="empty-state">Loading…</div>;
  } else if (gitMissing) {
    content = <SetupScreen tools={tools} />;
  } else if (!repo) {
    content = <Welcome />;
  } else if (view === 'stashes' && !reviewOpen) {
    content = <StashesView />;
  } else if (view === 'health' && !reviewOpen) {
    content = <HealthView />;
  } else {
    const selectedWorking = changes.selectedPaths.length === 1 ? changes.selectedPaths[0] : null;
    const workingFile = selectedWorking ? status?.files.find((f) => f.path === selectedWorking) ?? null : null;
    content = (
      <div className="main">
        <aside className="sidebar" style={{ width }}>
          <div className="tabs">
            <button type="button" className={`tab ${view === 'changes' ? 'active' : ''}`} onClick={() => setView('changes')} title="Changes (Ctrl+1)">
              Changes {status?.files.length ? <span className="badge">{status.files.length}</span> : null}
            </button>
            <button type="button" className={`tab ${view === 'history' ? 'active' : ''}`} onClick={() => setView('history')} title="History (Ctrl+2)">
              History
            </button>
          </div>
          {view === 'history' ? <HistoryTab /> : <ChangesTab />}
          <div className={`sidebar-resizer ${active ? 'active' : ''}`} onMouseDown={onMouseDown} />
        </aside>
        <section className="content">
          {reviewOpen ? (
            <ReviewView />
          ) : view === 'history' ? (
            <CommitDetailsPane />
          ) : changes.selectedPaths.length > 1 ? (
            <div className="empty-state">
              <Icon name="diff-modified" size={32} />
              <h2>{changes.selectedPaths.length} files selected</h2>
              <p>Right-click to discard or ignore the selected files, or use the checkboxes to include them in your next commit.</p>
            </div>
          ) : (
            <DiffPane path={selectedWorking} oldPath={workingFile?.oldPath ?? null} status={workingFile?.status ?? null} mode="working" emptyMessage={status?.files.length ? 'Select a file to view its changes.' : status?.branch.unborn ? 'Make your first commit to get started.' : 'No local changes. Edit files in your editor and they will show up here.'} />
          )}
        </section>
      </div>
    );
  }

  // The stash, commit and review views render their diff into a shared pane so state stays centralized.
  const showStashDiff = repo && !reviewOpen && view === 'stashes' && !!stashesView.selectedSha;
  const showCommitDiff = repo && !reviewOpen && view === 'history' && history.selectedShas.length === 1 && !!history.details;
  const showReviewDiff = repo && reviewOpen;

  return (
    <div className="app">
      <Toolbar />
      {settingsLoaded && !gitMissing ? <Banners /> : null}
      {content}
      {showStashDiff ? <PortalDiff target="stashes-diff-slot" path={stashesView.selectedFile} status={stashesView.files.find((f) => f.path === stashesView.selectedFile)?.status ?? null} mode="stash" /> : null}
      {showReviewDiff ? <PortalDiff target="review-diff-slot" path={reviewPath} oldPath={reviewFile?.oldPath ?? null} status={reviewFile?.status ?? null} mode="review" /> : null}
      {showCommitDiff ? <PortalDiff target="commit-diff-slot" path={history.selectedFile} oldPath={history.details?.files.find((f) => f.path === history.selectedFile)?.oldPath ?? null} status={history.details?.files.find((f) => f.path === history.selectedFile)?.status ?? null} mode="commit" /> : null}
      <Dialogs />
      <InboxPanel />
      <Toasts />
      <ContextMenuHost />
    </div>
  );
}

import { createPortal } from 'react-dom';

function PortalDiff({ target, path, oldPath, status, mode }: { target: string; path: string | null; oldPath?: string | null; status?: string | null; mode: 'working' | 'commit' | 'stash' | 'review' }): React.JSX.Element | null {
  const [el, setEl] = useState<HTMLElement | null>(null);
  useEffect(() => {
    const find = () => setEl(document.getElementById(target));
    find();
    const obs = new MutationObserver(find);
    obs.observe(document.body, { childList: true, subtree: true });
    return () => obs.disconnect();
  }, [target]);
  if (!el) return null;
  return createPortal(<DiffPane path={path} oldPath={oldPath} status={status} mode={mode} emptyMessage={mode === 'review' ? 'Select a file or a finding to see the diff.' : 'Select a file to view its changes.'} />, el);
}
