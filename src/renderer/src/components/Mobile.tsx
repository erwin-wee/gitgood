import React, { useCallback, useSyncExternalStore } from 'react';
import * as actions from '../state/actions';
import { openDialog, store, useAppStore, type AppState, type PhonePane, type View } from '../state/store';
import { Icon, openContextMenu, type IconName, type MenuItem } from './ui';

/** Single-column drill-down layout. Keep in sync with the `max-width: 767px` blocks in the stylesheets. */
export const PHONE_QUERY = '(max-width: 767px)';

export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const list = window.matchMedia(query);
      list.addEventListener('change', onChange);
      return () => list.removeEventListener('change', onChange);
    },
    [query],
  );
  return useSyncExternalStore(subscribe, () => window.matchMedia(query).matches);
}

// ---------------------------------------------------------------------------
// Drill-down panes, mirrored into browser history so the system back gesture pops a level
// ---------------------------------------------------------------------------

const DEPTH: Record<PhonePane, number> = { list: 0, detail: 1, file: 2 };
const PANES: PhonePane[] = ['list', 'detail', 'file'];
/** History entries this module has pushed on top of the page's own entry. */
let pushed = 0;
/** Pops caused by our own `history.go` rewinds, which must not move the pane again. */
let ownPops = 0;

function pushPane(pane: PhonePane): void {
  const current = store.get().phonePane;
  if (DEPTH[pane] > DEPTH[current]) {
    // The entry records how many entries we have pushed, not the pane's depth: review jumps list → file in one entry.
    pushed += 1;
    history.pushState({ gitgoodPane: pane, gitgoodPushed: pushed }, '');
  }
  store.set({ phonePane: pane });
}

export function phoneBack(): void {
  if (pushed > 0) history.back();
  else store.set((s) => ({ phonePane: PANES[Math.max(0, DEPTH[s.phonePane] - 1)] }));
}

/** Wires the history mirror and resets the pane when its context (repository, review) goes away. Returns the teardown. */
export function installPhoneNavigation(): () => void {
  const onPop = (e: PopStateEvent) => {
    if (ownPops > 0) {
      ownPops -= 1;
      return;
    }
    const state: unknown = e.state;
    const entry = state !== null && typeof state === 'object' ? state : {};
    const pane = PANES.find((p) => 'gitgoodPane' in entry && entry.gitgoodPane === p) ?? 'list';
    pushed = 'gitgoodPushed' in entry && typeof entry.gitgoodPushed === 'number' ? entry.gitgoodPushed : 0;
    store.set({ phonePane: pane });
  };
  let prev = store.get();
  const unsubscribe = store.subscribe(() => {
    const s = store.get();
    const contextChanged = s.currentRepo?.path !== prev.currentRepo?.path || s.review.open !== prev.review.open;
    prev = s;
    if (contextChanged && s.phonePane !== 'list') {
      store.set({ phonePane: 'list' });
      return;
    }
    // The pane went shallower without a history pop (tab switch, repo switch): drop our now-stale entries.
    const want = DEPTH[s.phonePane];
    if (pushed > want) {
      ownPops += 1;
      history.go(want - pushed);
      pushed = want;
    }
  });
  window.addEventListener('popstate', onPop);
  return () => {
    unsubscribe();
    window.removeEventListener('popstate', onPop);
  };
}

/**
 * Delegated from the app root: on a phone, tapping a list row inside a `[data-phone-next]` container drills into that pane.
 * Rows are `[role="option"]` or `[data-phone-row]`; taps on controls inside a row (checkboxes, buttons) stay put.
 */
export function onPhoneTap(e: React.MouseEvent): void {
  if (!window.matchMedia(PHONE_QUERY).matches) return;
  const target = e.target as HTMLElement;
  const row = target.closest<HTMLElement>('[role="option"], [data-phone-row]');
  if (!row) return;
  const control = target.closest('input, button, a, label, textarea, select');
  if (control && control !== row && row.contains(control)) return;
  const next = row.closest<HTMLElement>('[data-phone-next]')?.dataset.phoneNext as PhonePane | undefined;
  if (next && next in DEPTH) pushPane(next);
}

const BACK_LABEL: Record<View | 'review', [string, string]> = {
  changes: ['Changes', 'Changes'],
  history: ['History', 'Commit'],
  stashes: ['Stashes', 'Stash'],
  health: ['Repository', 'Repository'],
  review: ['Review', 'Review'],
};

function backLabel(s: AppState): string {
  const [fromDetail, fromFile] = BACK_LABEL[s.review.open ? 'review' : s.view];
  return s.phonePane === 'file' ? fromFile : fromDetail;
}

export function PhoneBackButton(): React.JSX.Element {
  const label = useAppStore(backLabel);
  return (
    <button type="button" className="phone-back" onClick={phoneBack} aria-label={`Back to ${label}`}>
      <Icon name="chevron-right" size={20} className="phone-back-chevron" />
      <span className="truncate">{label}</span>
    </button>
  );
}

// ---------------------------------------------------------------------------
// Bottom tab bar
// ---------------------------------------------------------------------------

function TabBarItem({ label, icon, active, badge, dot, onClick }: { label: string; icon: IconName; active: boolean; badge?: number; dot?: boolean; onClick: (e: React.MouseEvent) => void }): React.JSX.Element {
  return (
    <button type="button" className={`tabbar-item ${active ? 'active' : ''}`} aria-current={active ? 'page' : undefined} onClick={onClick}>
      <span className="tabbar-icon">
        <Icon name={icon} size={22} />
        {badge ? <span className="tabbar-badge">{badge > 99 ? '99+' : badge}</span> : dot ? <span className="tabbar-dot" /> : null}
      </span>
      <span className="tabbar-label">{label}</span>
    </button>
  );
}

function goTo(view: View): void {
  if (store.get().review.open) actions.closeReview();
  actions.setView(view);
  store.set({ phonePane: 'list' });
}

export function TabBar(): React.JSX.Element {
  const view = useAppStore((s) => (s.review.open ? 'review' : s.view));
  const changed = useAppStore((s) => s.status?.files.length ?? 0);
  const stashes = useAppStore((s) => s.stashes.length);
  const ghAvailable = useAppStore((s) => s.tools?.gh?.installed !== false);
  const unread = useAppStore((s) => (s.tools?.ghAccount ? s.inbox.unreadCount : 0));

  const openMore = (e: React.MouseEvent) => {
    const items: MenuItem[] = [
      { label: 'Search actions…', icon: 'search', onClick: () => actions.openCommandPalette() },
      ...(ghAvailable ? [{ label: unread ? `Notifications (${unread})` : 'Notifications', icon: 'bell' as const, onClick: () => actions.toggleInboxPanel() }] : []),
      { label: 'Repository health', icon: 'check-circle', onClick: () => actions.openHealth() },
      { type: 'separator' },
      { label: 'Help', icon: 'info', onClick: () => store.set({ helpOpen: true }) },
      { label: 'Options', icon: 'gear', onClick: () => openDialog({ kind: 'settings' }) },
    ];
    openContextMenu(e, items);
  };

  return (
    <nav className="tabbar" aria-label="Views">
      <TabBarItem label="Changes" icon="diff-modified" active={view === 'changes'} badge={changed} onClick={() => goTo('changes')} />
      <TabBarItem label="History" icon="history" active={view === 'history'} onClick={() => goTo('history')} />
      <TabBarItem label="Stashes" icon="stash" active={view === 'stashes'} badge={stashes} onClick={() => goTo('stashes')} />
      <TabBarItem label="More" icon="kebab" active={view === 'health' || view === 'review'} dot={unread > 0} onClick={openMore} />
    </nav>
  );
}

// ---------------------------------------------------------------------------
// Long-press → contextmenu (iOS Safari never fires contextmenu; Android does, natively)
// ---------------------------------------------------------------------------

const LONG_PRESS_MS = 550;
const SLOP_PX = 10;

export function installLongPress(): () => void {
  let timer = 0;
  let origin: { x: number; y: number; target: Element } | null = null;
  let handled = false;

  const cancel = () => {
    window.clearTimeout(timer);
    origin = null;
  };
  const onStart = (e: TouchEvent) => {
    handled = false;
    cancel();
    if (e.touches.length !== 1) return;
    const target = e.target as Element;
    if (target.closest('input, textarea, select, [contenteditable]')) return;
    const touch = e.touches[0];
    origin = { x: touch.clientX, y: touch.clientY, target };
    timer = window.setTimeout(() => {
      if (!origin) return;
      handled = true;
      origin.target.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: origin.x, clientY: origin.y }));
      origin = null;
    }, LONG_PRESS_MS);
  };
  const onMove = (e: TouchEvent) => {
    if (!origin) return;
    const touch = e.touches[0];
    if (Math.hypot(touch.clientX - origin.x, touch.clientY - origin.y) > SLOP_PX) cancel();
  };
  const onEnd = (e: TouchEvent) => {
    cancel();
    // Swallow the compatibility mousedown/click, which would otherwise close the menu that just opened or select the row underneath.
    if (handled && e.cancelable) e.preventDefault();
  };
  const onNativeMenu = (e: MouseEvent) => {
    if (!e.isTrusted || !origin) return;
    handled = true;
    cancel();
  };

  document.addEventListener('touchstart', onStart, { passive: true });
  document.addEventListener('touchmove', onMove, { passive: true });
  document.addEventListener('touchend', onEnd, { passive: false });
  document.addEventListener('touchcancel', cancel);
  document.addEventListener('contextmenu', onNativeMenu, true);
  return () => {
    cancel();
    document.removeEventListener('touchstart', onStart);
    document.removeEventListener('touchmove', onMove);
    document.removeEventListener('touchend', onEnd);
    document.removeEventListener('touchcancel', cancel);
    document.removeEventListener('contextmenu', onNativeMenu, true);
  };
}
