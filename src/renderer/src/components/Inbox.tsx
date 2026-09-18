import React, { useEffect, useMemo } from 'react';
import type { InboxItem, NotificationReason } from '@shared/types';
import * as actions from '../state/actions';
import { useAppStore } from '../state/store';
import { Badge, Button, Callout, Checkbox, Icon, openContextMenu, RelativeTime, Segmented } from './ui';

const REASON_LABELS: Record<NotificationReason, string> = {
  review_requested: 'Review requested',
  ci_activity: 'Checks',
  mention: 'Mention',
  assign: 'Assigned',
  comment: 'Comment',
  author: 'Your thread',
  state_change: 'State change',
  subscribed: 'Subscribed',
  team_mention: 'Team mention',
  security_alert: 'Security alert',
  other: 'Notification',
};

function reasonTone(reason: NotificationReason): 'neutral' | 'success' | 'danger' | 'attention' | 'accent' | 'done' {
  if (reason === 'review_requested' || reason === 'mention' || reason === 'team_mention') return 'accent';
  if (reason === 'ci_activity') return 'attention';
  if (reason === 'security_alert') return 'danger';
  return 'neutral';
}

interface RepoGroup {
  key: string;
  items: InboxItem[];
}

/** Items are already newest-first from the poller, so each group's first-seen item is its most recent; sorting groups by that keeps the newest repository group on top. */
function groupByRepo(items: InboxItem[]): RepoGroup[] {
  const map = new Map<string, InboxItem[]>();
  for (const item of items) {
    const key = `${item.repo.owner}/${item.repo.name}`;
    const existing = map.get(key);
    if (existing) existing.push(item);
    else map.set(key, [item]);
  }
  return [...map.entries()].map(([key, groupItems]) => ({ key, items: groupItems })).sort((a, b) => new Date(b.items[0].updatedAt).getTime() - new Date(a.items[0].updatedAt).getTime());
}

export function InboxPanel(): React.JSX.Element | null {
  const open = useAppStore((s) => s.inboxUi.open);
  const filter = useAppStore((s) => s.inboxUi.filter);
  const onlyKnownRepos = useAppStore((s) => s.inboxUi.onlyKnownRepos);
  const focusItemId = useAppStore((s) => s.inboxUi.focusItemId);
  const inbox = useAppStore((s) => s.inbox);
  const account = useAppStore((s) => s.tools?.ghAccount ?? null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') actions.closeInboxPanel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  const filtered = useMemo(() => {
    let items = inbox.items;
    if (filter === 'review') items = items.filter((i) => i.reason === 'review_requested');
    else if (filter === 'failures') items = items.filter((i) => i.reason === 'ci_activity');
    else if (filter === 'mentions') items = items.filter((i) => i.reason === 'mention' || i.reason === 'team_mention');
    if (onlyKnownRepos) items = items.filter((i) => i.localRepoId !== null);
    return items;
  }, [inbox.items, filter, onlyKnownRepos]);

  const groups = useMemo(() => groupByRepo(filtered), [filtered]);

  if (!open) return null;

  const enterprise = account && account.host !== 'github.com';

  return (
    <div className="inbox-panel" role="dialog" aria-label="Notifications inbox">
      <div className="inbox-panel-header">
        <Icon name="bell" />
        <strong>Notifications</strong>
        <span className="toolbar-spacer" />
        {account && !enterprise ? <Button size="sm" variant="ghost" iconOnly icon="sync" title="Refresh" onClick={() => void actions.refreshInbox()} /> : null}
        <Button size="sm" variant="ghost" iconOnly icon="x" title="Close" onClick={() => actions.closeInboxPanel()} />
      </div>
      {!account ? (
        <div className="inbox-empty">
          <p className="muted">Sign in to GitHub to see review requests, failing checks, mentions and more here.</p>
          <Button variant="primary" icon="github" onClick={() => actions.openDialog({ kind: 'sign-in' })}>Sign in to GitHub</Button>
        </div>
      ) : enterprise ? (
        <div className="inbox-empty">
          <p className="muted">The Inbox currently supports github.com only; your signed-in account is on {account.host}.</p>
        </div>
      ) : (
        <>
          <div className="inbox-filters">
            <Segmented
              value={filter}
              onChange={actions.setInboxFilter}
              options={[
                { value: 'all', label: 'All' },
                { value: 'review', label: 'Review' },
                { value: 'failures', label: 'Failures' },
                { value: 'mentions', label: 'Mentions' },
              ]}
            />
          </div>
          {inbox.paused === 'scope' ? (
            <Callout tone="warning">
              This token is missing access to notifications. <Button size="sm" onClick={() => void actions.grantNotificationsScope()}>Grant access</Button>
            </Callout>
          ) : null}
          {inbox.paused === 'rate-limit' ? (
            <Callout tone="warning">
              Rate limited{inbox.pausedUntil ? (
                <>
                  {' '}
                  until <RelativeTime date={inbox.pausedUntil} />
                </>
              ) : null}
              . Polling will resume automatically.
            </Callout>
          ) : null}
          {inbox.paused === 'offline' ? (
            <Callout tone="neutral">
              Offline — showing the last cached list{inbox.lastPolledAt ? (
                <>
                  {' '}
                  from <RelativeTime date={inbox.lastPolledAt} />
                </>
              ) : null}
              .
            </Callout>
          ) : null}
          <div className="inbox-panel-actions">
            <Checkbox checked={onlyKnownRepos} onChange={actions.setInboxOnlyKnownRepos} label="Only my repositories" />
            <Button size="sm" variant="ghost" onClick={() => actions.requestMarkAllInboxRead()} disabled={!inbox.items.some((i) => i.unread)}>Mark all read</Button>
          </div>
          <div className="inbox-panel-body">
            {groups.length === 0 ? <div className="list-empty">{inbox.items.length ? 'No notifications match this filter.' : 'No notifications.'}</div> : null}
            {groups.map((g) => (
              <React.Fragment key={g.key}>
                <div className="list-group-header">{g.key}</div>
                {g.items.map((item) => (
                  <InboxRow key={item.id} item={item} focused={item.id === focusItemId} />
                ))}
              </React.Fragment>
            ))}
          </div>
          {inbox.lastPolledAt && inbox.paused !== 'offline' ? (
            <div className="inbox-panel-footer muted">
              Updated <RelativeTime date={inbox.lastPolledAt} />
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}

function InboxRow({ item, focused }: { item: InboxItem; focused: boolean }): React.JSX.Element {
  return (
    <div
      className={`list-row inbox-item ${item.unread ? 'unread' : ''} ${focused ? 'focused' : ''}`}
      onClick={() => void actions.openInboxItem(item)}
      onContextMenu={(e) =>
        openContextMenu(e, [
          { label: 'Open on GitHub', onClick: () => void actions.openExternal(item.subject.url ?? item.repo.url) },
          { label: 'Mark read', disabled: !item.unread, onClick: () => void actions.markInboxRead([item.id]) },
          { label: 'Unsubscribe', onClick: () => void actions.unsubscribeInboxItem(item) },
        ])
      }
    >
      <span className={`inbox-unread-dot ${item.unread ? 'on' : ''}`} />
      <Badge tone={reasonTone(item.reason)} outline>{REASON_LABELS[item.reason]}</Badge>
      <span className="row-main">
        <span className="truncate">{item.subject.title}</span>
        <span className="row-sub truncate">
          {item.repo.owner}/{item.repo.name}
          {item.subject.number ? ` #${item.subject.number}` : ''}
        </span>
      </span>
      <span className="row-meta">
        <RelativeTime date={item.updatedAt} />
      </span>
    </div>
  );
}

