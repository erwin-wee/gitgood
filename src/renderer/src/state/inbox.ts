import type { InboxItem } from '@shared/types';
import { errorMessage, invoke, on } from '../api';
import { openExternal, openRepository, showError, updateSettings } from './actions';
import { closeDialog, initialInboxUi, openDialog, patchInboxUi, showToast, store, type InboxUiState } from './store';

// ---------------------------------------------------------------------------
// GitHub notifications inbox
// ---------------------------------------------------------------------------

/** True once the GitHub CLI is known to be installed (the bell is hidden entirely otherwise). */
export function inboxAvailable(): boolean {
  return !!store.get().tools?.gh.installed;
}

/** Wires the main process's poll results into the store; call once during bootstrap. */
export function initInbox(): void {
  on('gh.inbox.changed', (state) => store.set({ inbox: state }));
}

/** Loads the poller's current state (its cache, if nothing has polled yet) without forcing a network request. */
export async function loadInboxState(): Promise<void> {
  if (!store.get().tools?.ghAccount) return;
  try {
    const state = await invoke('gh.inbox.get');
    store.set({ inbox: state });
  } catch {
    /* best effort; the panel will retry on open */
  }
}

export function toggleInboxPanel(): void {
  if (!store.get().tools?.ghAccount) {
    openDialog({ kind: 'sign-in' });
    return;
  }
  const wasOpen = store.get().inboxUi.open;
  patchInboxUi((u) => ({ open: !u.open }));
  if (!wasOpen) void refreshInbox();
}

export function closeInboxPanel(): void {
  patchInboxUi({ ...initialInboxUi, open: false });
}

export async function refreshInbox(): Promise<void> {
  try {
    const state = await invoke('gh.inbox.refresh');
    store.set({ inbox: state });
  } catch (err) {
    showToast({ kind: 'error', title: 'Could not refresh notifications', message: errorMessage(err) });
  }
}

export function setInboxFilter(filter: InboxUiState['filter']): void {
  patchInboxUi({ filter });
}

export function setInboxOnlyKnownRepos(onlyKnownRepos: boolean): void {
  patchInboxUi({ onlyKnownRepos });
}

/**
 * Opens a notification's subject: the Pull Request dialog in place when it
 * belongs to a pull request in a repository already added to GitGood,
 * otherwise its page on github.com. Either way, the notification is marked
 * read (spec: "Opening an item MUST mark it read").
 */
export async function openInboxItem(item: InboxItem): Promise<void> {
  patchInboxUi({ focusItemId: item.id });
  if (item.unread) void markInboxRead([item.id]);
  if (item.subject.type === 'PullRequest' && item.localRepoId && item.subject.number) {
    const repo = store.get().repos.find((r) => r.id === item.localRepoId);
    if (repo) {
      closeInboxPanel();
      if (store.get().currentRepo?.id !== repo.id) await openRepository(repo);
      try {
        const pr = await invoke('gh.pr.view', repo.path, item.subject.number);
        openDialog({ kind: 'pr-details', pr });
        return;
      } catch (err) {
        showError(`Could not open pull request #${item.subject.number}`, err);
        return;
      }
    }
  }
  void openExternal(item.subject.url ?? item.repo.url);
}

/** Resolves a desktop-notification click, which only carries the notification id. */
export function openInboxItemById(id: string): void {
  if (!store.get().tools?.ghAccount) return;
  patchInboxUi({ open: true });
  const item = store.get().inbox.items.find((i) => i.id === id);
  if (item) void openInboxItem(item);
}

export async function markInboxRead(threadIds: string[]): Promise<void> {
  store.set((s) => {
    const items = s.inbox.items.map((i) => (threadIds.includes(i.id) ? { ...i, unread: false } : i));
    return { inbox: { ...s.inbox, items, unreadCount: items.filter((i) => i.unread).length } };
  });
  try {
    await invoke('gh.inbox.markRead', threadIds);
  } catch (err) {
    showToast({ kind: 'error', title: 'Could not mark notification as read', message: errorMessage(err) });
    void refreshInbox();
  }
}

/** "Mark all read": confirms once (per the confirmMarkAllNotificationsRead setting), with a "do not ask again" checkbox. */
export function requestMarkAllInboxRead(): void {
  const settings = store.get().settings;
  if (settings && !settings.confirmMarkAllNotificationsRead) {
    void markAllInboxRead();
    return;
  }
  let remember = false;
  openDialog({
    kind: 'confirm',
    title: 'Mark all notifications read?',
    message: 'GitHub will record every notification currently listed as read. This cannot be undone.',
    confirmLabel: 'Mark all read',
    onConfirm: () => {
      if (remember) void updateSettings({ confirmMarkAllNotificationsRead: false });
      void markAllInboxRead();
    },
    checkbox: { label: 'Do not ask again', onChange: (v) => { remember = v; } },
  });
}

export async function markAllInboxRead(): Promise<void> {
  try {
    await invoke('gh.inbox.markAllRead');
    store.set((s) => ({ inbox: { ...s.inbox, items: s.inbox.items.map((i) => ({ ...i, unread: false })), unreadCount: 0 } }));
    showToast({ kind: 'success', title: 'All notifications marked read' });
  } catch (err) {
    showError('Could not mark all notifications read', err);
  }
}

export async function unsubscribeInboxItem(item: InboxItem): Promise<void> {
  try {
    await invoke('gh.inbox.unsubscribe', item.threadId);
    store.set((s) => {
      const items = s.inbox.items.filter((i) => i.id !== item.id);
      return { inbox: { ...s.inbox, items, unreadCount: items.filter((i) => i.unread).length } };
    });
    showToast({ kind: 'success', title: 'Unsubscribed from thread' });
  } catch (err) {
    showError('Could not unsubscribe', err);
  }
}

/** Requests the `notifications` scope through the existing device-flow Sign-in dialog, without signing out first. */
export async function grantNotificationsScope(): Promise<void> {
  store.set({ login: { inProgress: true, code: null, url: null, error: null } });
  openDialog({ kind: 'sign-in' });
  try {
    const result = await invoke('gh.auth.refreshScopes', ['notifications']);
    store.set((s) => ({ login: { ...s.login, inProgress: false, error: result.ok ? null : result.error } }));
    if (result.ok) {
      closeDialog();
      showToast({ kind: 'success', title: 'Granted access to notifications' });
      void refreshInbox();
    }
  } catch (err) {
    store.set((s) => ({ login: { ...s.login, inProgress: false, error: errorMessage(err) } }));
  }
}

/** Deletes the on-disk notifications cache (which may hold private-repository titles); the panel reloads from GitHub on the next poll. */
export async function clearInboxCache(): Promise<void> {
  try {
    await invoke('app.inbox.clearCache');
    store.set((s) => ({ inbox: { ...s.inbox, items: [], lastPolledAt: null } }));
    showToast({ kind: 'success', title: 'Inbox cache cleared' });
  } catch (err) {
    showError('Could not clear the inbox cache', err);
  }
}

