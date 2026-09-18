import React, { useEffect, useState } from 'react';
import type { CreateIssueOptions, GitErrorInfo, GitHubRepoDetails, Issue, IssueDetail, IssueFilter, IssueTemplate } from '@shared/types';
import { DEFAULT_ISSUE_FILTER } from '@shared/types';
import { linkifyText } from '@shared/util';
import { errorInfo, errorMessage, invoke } from '../../api';
import * as actions from '../../state/actions';
import { closeDialog, openDialog, store, useAppStore } from '../../state/store';
import { Badge, Button, Callout, Checkbox, Icon, RelativeTime, Spinner, TextField, Dialog } from '../ui';

const STATE_OPTIONS: { value: IssueFilter['state']; label: string }[] = [
  { value: 'open', label: 'Open' },
  { value: 'closed', label: 'Closed' },
  { value: 'all', label: 'All' },
];

/** Renders untrusted GitHub text (issue/comment bodies, release notes) as plain text with bare URLs turned into links: no Markdown or HTML is ever interpreted. */
export function LinkifiedText({ text }: { text: string }): React.JSX.Element {
  const parts = linkifyText(text);
  return (
    <span style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
      {parts.map((p, i) =>
        p.url ? (
          <a key={i} href="#" onClick={(e) => { e.preventDefault(); void actions.openExternal(p.url!); }}>
            {p.text}
          </a>
        ) : (
          <React.Fragment key={i}>{p.text}</React.Fragment>
        ),
      )}
    </span>
  );
}

/** GitHub label colours are arbitrary hex; pick readable text and, in dark mode, a subtle border so dark labels stay visible. */
function labelChipStyle(color: string, dark: boolean): React.CSSProperties {
  const hex = /^[0-9a-f]{6}$/i.test(color) ? color : '888888';
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return {
    backgroundColor: `#${hex}`,
    color: luminance > 0.6 ? '#1a1a1a' : '#ffffff',
    border: dark ? '1px solid rgba(255,255,255,0.18)' : 'none',
    borderRadius: 999,
    padding: '1px 8px',
    fontSize: 11,
    fontWeight: 600,
    display: 'inline-block',
  };
}

function LabelChips({ labels, dark }: { labels: { name: string; color: string }[]; dark: boolean }): React.JSX.Element | null {
  if (!labels.length) return null;
  return (
    <span style={{ display: 'inline-flex', gap: 4, flexWrap: 'wrap' }}>
      {labels.map((l) => (
        <span key={l.name} className="label-chip" style={labelChipStyle(l.color, dark)}>{l.name}</span>
      ))}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Issues dialog: filter bar + list + detail
// ---------------------------------------------------------------------------

export function IssuesDialog({ number }: { number?: number }): React.JSX.Element {
  const repo = useAppStore((s) => s.currentRepo);
  const tools = useAppStore((s) => s.tools);
  const dark = useAppStore((s) => s.dark);
  const settings = useAppStore((s) => s.settings);
  const signedIn = !!tools?.ghAccount;
  const ghMissing = tools ? !tools.gh.installed : false;

  const [details, setDetails] = useState<GitHubRepoDetails | null>(null);
  const [detailsLoading, setDetailsLoading] = useState(true);
  const [useParent, setUseParent] = useState(false);

  const [filter, setFilter] = useState<IssueFilter>(DEFAULT_ISSUE_FILTER);
  const [filterReady, setFilterReady] = useState(false);
  const [searchInput, setSearchInput] = useState('');

  const [issues, setIssues] = useState<Issue[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [listError, setListError] = useState<GitErrorInfo | null>(null);

  const [selected, setSelected] = useState<number | null>(number ?? null);
  const [labelsList, setLabelsList] = useState<{ name: string; color: string }[]>([]);
  const [milestonesList, setMilestonesList] = useState<{ number: number; title: string }[]>([]);

  const owner = useParent && details?.parent ? details.parent : null;

  useEffect(() => {
    if (!repo || !signedIn) {
      setDetailsLoading(false);
      return;
    }
    let cancelled = false;
    setDetailsLoading(true);
    void invoke('gh.repo.view', repo.path)
      .then((d) => { if (!cancelled) setDetails(d); })
      .finally(() => { if (!cancelled) setDetailsLoading(false); });
    return () => { cancelled = true; };
  }, [repo?.path, signedIn]);

  useEffect(() => {
    if (!repo) return;
    let cancelled = false;
    void invoke('app.issueFilters.get', repo.id)
      .then((f) => {
        if (cancelled) return;
        const loaded = f ?? DEFAULT_ISSUE_FILTER;
        setFilter(loaded);
        setSearchInput(loaded.search);
      })
      .finally(() => { if (!cancelled) setFilterReady(true); });
    return () => { cancelled = true; };
  }, [repo?.id]);

  useEffect(() => {
    if (!repo || !signedIn) return;
    void invoke('gh.labels', repo.path, owner).then(setLabelsList).catch(() => undefined);
    void invoke('gh.milestones', repo.path, owner).then(setMilestonesList).catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repo?.path, signedIn, owner]);

  const issuesEnabled = !details || details.hasIssuesEnabled || !!owner;

  const load = async (f: IssueFilter): Promise<void> => {
    if (!repo) return;
    setLoading(true);
    setListError(null);
    try {
      const list = await invoke('gh.issue.list', repo.path, f, owner, null);
      setIssues(list);
      setHasMore(list.length >= 100);
      setSelected((cur) => (cur !== null && list.some((i) => i.number === cur) ? cur : (list[0]?.number ?? null)));
    } catch (err) {
      setListError(errorInfo(err));
      setIssues([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!repo || !signedIn || !filterReady || !issuesEnabled) return;
    void load(filter);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repo?.path, signedIn, filterReady, filter, owner, issuesEnabled]);

  const updateFilter = (patch: Partial<IssueFilter>): void => {
    const next = { ...filter, ...patch };
    setFilter(next);
    if (repo) void invoke('app.issueFilters.set', repo.id, next).catch(() => undefined);
  };

  useEffect(() => {
    if (!filterReady) return;
    const t = setTimeout(() => {
      if (searchInput !== filter.search) updateFilter({ search: searchInput });
    }, 400);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchInput]);

  const loadMore = async (): Promise<void> => {
    if (!repo || !issues.length) return;
    setLoadingMore(true);
    try {
      const oldest = issues[issues.length - 1].updatedAt;
      const more = await invoke('gh.issue.list', repo.path, filter, owner, oldest);
      const seen = new Set(issues.map((i) => i.number));
      setIssues((prev) => [...prev, ...more.filter((i) => !seen.has(i.number))]);
      setHasMore(more.length >= 100);
    } catch (err) {
      actions.showToast({ kind: 'error', title: 'Could not load more issues', message: errorMessage(err) });
    } finally {
      setLoadingMore(false);
    }
  };

  const updateIssueLocally = (n: number, patch: Partial<Issue>): void => {
    setIssues((prev) => prev.map((i) => (i.number === n ? { ...i, ...patch } : i)));
  };

  const filterDescription = (): string => {
    const bits: string[] = [];
    if (filter.assignee === 'me') bits.push('assigned to you');
    if (filter.author === 'me') bits.push('created by you');
    if (filter.mentioned) bits.push('mentioning you');
    if (filter.labels.length) bits.push(`labeled ${filter.labels.join(', ')}`);
    const state = filter.state === 'all' ? '' : `${filter.state} `;
    return `No ${state}issues${bits.length ? ` ${bits.join(', ')}` : ''}.`;
  };

  if (!repo) return <></>;

  return (
    <Dialog
      title="Issues"
      icon="issue"
      onClose={closeDialog}
      width="xwide"
      footer={
        <>
          <span className="left muted" style={{ fontSize: 12 }}>
            {repo.github ? <a href="#" onClick={(e) => { e.preventDefault(); void actions.openExternal(`${repo.github!.url}/issues`); }}>View all on GitHub</a> : null}
          </span>
          <Button onClick={closeDialog}>Close</Button>
          {signedIn && issuesEnabled ? (
            <Button variant="primary" icon="plus" onClick={() => openDialog({ kind: 'new-issue', owner })}>New issue</Button>
          ) : null}
        </>
      }
    >
      {ghMissing ? (
        <Callout tone="warning">The GitHub CLI (gh) was not found. Install it from cli.github.com, then restart GitGood.</Callout>
      ) : !signedIn ? (
        <Callout tone="info" icon="github">
          <p>Sign in to GitHub to browse this repository's issues.</p>
          <Button variant="primary" icon="github" onClick={() => openDialog({ kind: 'sign-in' })}>Sign in with your browser</Button>
        </Callout>
      ) : detailsLoading ? (
        <Spinner />
      ) : listError?.code === 'rate-limited' ? (
        <Callout tone="warning">
          GitHub's API rate limit was reached. {listError.rateLimitResetAt ? <>It resets <RelativeTime date={listError.rateLimitResetAt} />.</> : 'Try again in a few minutes.'}
        </Callout>
      ) : !issuesEnabled && details?.isFork && details.parent ? (
        <Callout tone="info">
          Issues are disabled on {details.nameWithOwner}. This repository is a fork of <strong>{details.parent}</strong>, where issues normally live.
          <div style={{ marginTop: 8 }}>
            <Checkbox checked={useParent} onChange={setUseParent} label={`Show issues from ${details.parent} instead`} />
          </div>
        </Callout>
      ) : !issuesEnabled ? (
        <Callout tone="info">
          Issues are disabled on {details?.nameWithOwner ?? 'this repository'}.{' '}
          {repo.github ? <a href="#" onClick={(e) => { e.preventDefault(); void actions.openExternal(`${repo.github!.url}/settings`); }}>Enable them in repository settings</a> : null}
        </Callout>
      ) : (
        <>
          <div className="issues-filter-bar" style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', marginBottom: 10 }}>
            <span className="filter-input" style={{ flex: '1 1 200px' }}>
              <Icon name="search" />
              <input placeholder="Search issues" value={searchInput} onChange={(e) => setSearchInput(e.target.value)} style={{ padding: '4px 6px 4px 26px' }} />
            </span>
            <select value={filter.state} onChange={(e) => updateFilter({ state: e.target.value as IssueFilter['state'] })}>
              {STATE_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
            <Checkbox checked={filter.assignee === 'me'} onChange={(v) => updateFilter({ assignee: v ? 'me' : 'any' })} label="Assigned to me" />
            <Checkbox checked={filter.author === 'me'} onChange={(v) => updateFilter({ author: v ? 'me' : 'any' })} label="Created by me" />
            <Checkbox checked={filter.mentioned} onChange={(v) => updateFilter({ mentioned: v })} label="Mentions me" />
            {labelsList.length ? (
              <select
                value=""
                onChange={(e) => {
                  const v = e.target.value;
                  if (v && !filter.labels.includes(v)) updateFilter({ labels: [...filter.labels, v] });
                }}
              >
                <option value="">+ Label</option>
                {labelsList.filter((l) => !filter.labels.includes(l.name)).map((l) => (
                  <option key={l.name} value={l.name}>{l.name}</option>
                ))}
              </select>
            ) : null}
            {milestonesList.length ? (
              <select value={filter.milestone ?? ''} onChange={(e) => updateFilter({ milestone: e.target.value || null })}>
                <option value="">Any milestone</option>
                {milestonesList.map((m) => (
                  <option key={m.number} value={m.title}>{m.title}</option>
                ))}
              </select>
            ) : null}
            {details?.isFork && details.parent ? <Checkbox checked={useParent} onChange={setUseParent} label={`Show ${details.parent} issues`} /> : null}
            {filter.labels.map((l) => (
              <span key={l} className="coauthor-chip">
                {l}
                <button type="button" onClick={() => updateFilter({ labels: filter.labels.filter((x) => x !== l) })} title="Remove">
                  <Icon name="x" size={12} />
                </button>
              </span>
            ))}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '340px 1fr', gap: 16, minHeight: 360 }}>
            <div className="popover-list" style={{ maxHeight: 480, overflow: 'auto', border: '1px solid var(--border)', borderRadius: 6 }}>
              {loading && !issues.length ? (
                <Spinner />
              ) : !loading && !issues.length ? (
                <div className="list-empty">{filterDescription()}</div>
              ) : (
                <>
                  {issues.map((issue) => (
                    <IssueRow key={issue.number} issue={issue} dark={dark} selected={selected === issue.number} onClick={() => setSelected(issue.number)} />
                  ))}
                  {hasMore ? (
                    <div style={{ padding: 8, textAlign: 'center' }}>
                      <Button size="sm" loading={loadingMore} onClick={() => void loadMore()}>Load more</Button>
                    </div>
                  ) : null}
                </>
              )}
            </div>
            <div>
              {selected !== null ? (
                <IssueDetailPane
                  key={`${owner ?? ''}:${selected}`}
                  repoPath={repo.path}
                  number={selected}
                  owner={owner}
                  settingsConfirmCloseIssue={settings?.confirmCloseIssue !== false}
                  onStateChanged={(n, state) => updateIssueLocally(n, { state })}
                />
              ) : (
                <p className="muted">Select an issue to see its details.</p>
              )}
            </div>
          </div>
        </>
      )}
    </Dialog>
  );
}

function IssueRow({ issue, dark, selected, onClick }: { issue: Issue; dark: boolean; selected: boolean; onClick: () => void }): React.JSX.Element {
  return (
    <div className={`list-row ${selected ? 'selected' : ''}`} onClick={onClick}>
      <span style={{ color: issue.state === 'OPEN' ? 'var(--success)' : 'var(--fg-muted)' }}>
        <Icon name="issue" />
      </span>
      <span className="row-main">
        <span className="truncate">
          {issue.title} <span className="muted">#{issue.number}</span>
        </span>
        <span className="row-sub truncate">
          <LabelChips labels={issue.labels} dark={dark} />
        </span>
      </span>
      <span className="row-meta">
        {issue.commentsCount ? <span className="muted" title={`${issue.commentsCount} comments`}><Icon name="file" size={12} /> {issue.commentsCount}</span> : null}
        <RelativeTime date={issue.updatedAt} />
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Issue detail pane (embedded in the Issues dialog, not a separate dialog)
// ---------------------------------------------------------------------------

function IssueDetailPane({
  repoPath,
  number,
  owner,
  settingsConfirmCloseIssue,
  onStateChanged,
}: {
  repoPath: string;
  number: number;
  owner: string | null;
  settingsConfirmCloseIssue: boolean;
  onStateChanged: (number: number, state: 'OPEN' | 'CLOSED') => void;
}): React.JSX.Element {
  const [detail, setDetail] = useState<IssueDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmingClose, setConfirmingClose] = useState(false);
  const [dontAskAgain, setDontAskAgain] = useState(false);
  const [refKeyword, setRefKeyword] = useState<'Fixes' | 'Refs' | 'Closes'>('Fixes');
  const [comment, setComment] = useState('');
  const [showFullBody, setShowFullBody] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    void invoke('gh.issue.view', repoPath, number, owner)
      .then((d) => { if (!cancelled) setDetail(d); })
      .catch((err) => { if (!cancelled) setError(errorMessage(err)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [repoPath, number, owner]);

  if (loading) return <Spinner />;
  if (error || !detail) return <Callout tone="danger">{error ?? 'Could not load this issue.'}</Callout>;

  const setState = async (next: 'open' | 'closed'): Promise<void> => {
    setBusy(next);
    try {
      await invoke('gh.issue.setState', repoPath, detail.number, next, owner);
      const upper = next === 'open' ? 'OPEN' : 'CLOSED';
      setDetail((d) => (d ? { ...d, state: upper } : d));
      onStateChanged(detail.number, upper);
      actions.showToast({ kind: 'success', title: next === 'open' ? `Reopened #${detail.number}` : `Closed #${detail.number}` });
    } catch (err) {
      actions.showToast({ kind: 'error', title: 'Could not update the issue', message: errorMessage(err) });
    } finally {
      setBusy(null);
      setConfirmingClose(false);
    }
  };

  const requestClose = (): void => {
    if (!settingsConfirmCloseIssue) {
      void setState('closed');
      return;
    }
    setConfirmingClose(true);
  };

  const confirmClose = (): void => {
    if (dontAskAgain) void actions.updateSettings({ confirmCloseIssue: false });
    void setState('closed');
  };

  const body = detail.body.trim();
  const bodyTooLong = body.length > 1200;
  const shownBody = bodyTooLong && !showFullBody ? `${body.slice(0, 1200)}…` : body;

  const postComment = async (): Promise<void> => {
    if (!comment.trim()) return;
    setBusy('comment');
    try {
      await invoke('gh.issue.comment', repoPath, detail.number, comment, owner);
      setComment('');
      const fresh = await invoke('gh.issue.view', repoPath, detail.number, owner);
      setDetail(fresh);
      actions.showToast({ kind: 'success', title: 'Comment posted' });
    } catch (err) {
      actions.showToast({ kind: 'error', title: 'Could not post comment', message: errorMessage(err) });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
        <h3 style={{ margin: 0 }}>{detail.title}</h3>
        <span className="muted">#{detail.number}</span>
        <Badge tone={detail.state === 'OPEN' ? 'success' : 'done'}>{detail.state === 'OPEN' ? 'Open' : 'Closed'}</Badge>
      </div>
      <p className="muted" style={{ fontSize: 12 }}>
        {detail.author} opened this issue <RelativeTime date={detail.createdAt} />
        {detail.milestone ? <> · milestone {detail.milestone}</> : null}
        {detail.assignees.length ? <> · assigned to {detail.assignees.join(', ')}</> : null}
      </p>
      <LabelChips labels={detail.labels} dark={store.get().dark} />
      <div className="callout" style={{ display: 'block', marginTop: 8 }}>
        {body ? <LinkifiedText text={shownBody} /> : <span className="muted">No description provided.</span>}
        {bodyTooLong ? (
          <div>
            <Button variant="link" onClick={() => setShowFullBody((v) => !v)}>{showFullBody ? 'Show less' : 'Show more'}</Button>
          </div>
        ) : null}
      </div>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 10 }}>
        <Button size="sm" icon="external" onClick={() => void actions.openExternal(detail.url)}>Open on GitHub</Button>
        <Button size="sm" icon="copy" onClick={() => void actions.copyToClipboard(detail.url, 'Link copied')}>Copy link</Button>
        <Button size="sm" icon="copy" onClick={() => void actions.copyToClipboard(`#${detail.number}`, 'Copied')}>Copy #{detail.number}</Button>
        <Button size="sm" icon="branch" onClick={() => actions.createBranchForIssue(detail.number, detail.title)}>Create branch for issue</Button>
      </div>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 8 }}>
        <select value={refKeyword} onChange={(e) => setRefKeyword(e.target.value as typeof refKeyword)} style={{ padding: '4px 6px' }}>
          <option value="Fixes">Fixes</option>
          <option value="Closes">Closes</option>
          <option value="Refs">Refs</option>
        </select>
        <Button size="sm" onClick={() => { actions.appendDescription(`${refKeyword} #${detail.number}`); actions.showToast({ kind: 'success', title: 'Added to commit description' }); }}>Reference in commit</Button>
      </div>

      <div style={{ marginTop: 10 }}>
        {confirmingClose ? (
          <Callout tone="warning">
            <p>Close issue #{detail.number}?</p>
            <Checkbox checked={dontAskAgain} onChange={setDontAskAgain} label="Do not ask again" />
            <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
              <Button size="sm" onClick={() => setConfirmingClose(false)}>Cancel</Button>
              <Button size="sm" variant="danger" loading={busy === 'closed'} onClick={confirmClose}>Close issue</Button>
            </div>
          </Callout>
        ) : detail.state === 'OPEN' ? (
          <Button size="sm" variant="danger" loading={busy === 'closed'} onClick={requestClose}>Close</Button>
        ) : (
          <Button size="sm" loading={busy === 'open'} onClick={() => void setState('open')}>Reopen</Button>
        )}
      </div>

      <h4 style={{ margin: '14px 0 6px', fontSize: 12, textTransform: 'uppercase', color: 'var(--fg-muted)' }}>
        Comments {detail.commentsCount > detail.comments.length ? `(latest ${detail.comments.length} of ${detail.commentsCount})` : detail.commentsCount ? `(${detail.commentsCount})` : ''}
      </h4>
      {detail.comments.length === 0 ? <p className="muted">No comments yet.</p> : null}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {detail.comments.map((c, i) => (
          <div key={i} className="callout" style={{ display: 'block' }}>
            <p className="muted" style={{ fontSize: 12, margin: '0 0 4px' }}>
              {c.author} · <RelativeTime date={c.createdAt} />
            </p>
            <LinkifiedText text={c.body} />
          </div>
        ))}
      </div>
      <textarea rows={3} placeholder="Leave a comment" value={comment} onChange={(e) => setComment(e.target.value)} style={{ width: '100%', marginTop: 8 }} />
      <div style={{ marginTop: 6 }}>
        <Button size="sm" variant="primary" disabled={!comment.trim()} loading={busy === 'comment'} onClick={() => void postComment()}>Comment</Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// New issue dialog
// ---------------------------------------------------------------------------

export function NewIssueDialog({ owner }: { owner: string | null }): React.JSX.Element {
  const repo = useAppStore((s) => s.currentRepo);
  const [templates, setTemplates] = useState<IssueTemplate[]>([]);
  const [labelsList, setLabelsList] = useState<{ name: string; color: string }[]>([]);
  const [templateIndex, setTemplateIndex] = useState<number | null>(null);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [labels, setLabels] = useState<string[]>([]);
  const [assigneesInput, setAssigneesInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!repo) return;
    void invoke('gh.issue.templates', repo.path).then(setTemplates).catch(() => undefined);
    void invoke('gh.labels', repo.path, owner).then(setLabelsList).catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repo?.path]);

  const applyTemplate = (index: number | null): void => {
    setTemplateIndex(index);
    if (index === null) return;
    const t = templates[index];
    if (!t) return;
    if (t.external && repo?.github) {
      void actions.openExternal(`${repo.github.url}/issues/new?template=${encodeURIComponent(t.filename)}`);
      closeDialog();
      return;
    }
    if (t.title) setTitle(t.title);
    setBody(t.body);
    setLabels(t.labels);
  };

  const create = async (): Promise<void> => {
    if (!repo || !title.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const opts: CreateIssueOptions = { title: title.trim(), body, labels, assignees: assigneesInput.split(',').map((s) => s.trim()).filter(Boolean) };
      const result = await invoke('gh.issue.create', repo.path, opts, owner);
      closeDialog();
      actions.showToast({ kind: 'success', title: `Issue #${result.number} created`, message: result.url, action: { label: 'Open', onClick: () => void actions.openExternal(result.url) } }, 10000);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      title="New issue"
      icon="issue"
      onClose={closeDialog}
      width="wide"
      footer={
        <>
          <Button onClick={closeDialog}>Cancel</Button>
          <Button variant="primary" disabled={!title.trim() || busy} loading={busy} onClick={() => void create()}>Create issue</Button>
        </>
      }
    >
      {templates.length ? (
        <div className="field">
          <label>Template</label>
          <select value={templateIndex ?? ''} onChange={(e) => applyTemplate(e.target.value === '' ? null : Number(e.target.value))}>
            <option value="">Blank issue</option>
            {templates.map((t, i) => (
              <option key={t.filename} value={i}>
                {t.name}
                {t.about ? ` — ${t.about}` : ''}
                {t.external ? ' (opens on GitHub)' : ''}
              </option>
            ))}
          </select>
        </div>
      ) : null}
      <TextField label="Title" value={title} onChange={(e) => setTitle(e.target.value)} autoFocus />
      <div className="field">
        <label>Description</label>
        <textarea rows={8} value={body} onChange={(e) => setBody(e.target.value)} placeholder="Describe the issue" />
      </div>
      {labelsList.length ? (
        <div className="field">
          <label>Labels</label>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {labelsList.map((l) => (
              <label key={l.name} className="checkbox" style={{ display: 'inline-flex' }}>
                <input type="checkbox" checked={labels.includes(l.name)} onChange={(e) => setLabels((prev) => (e.target.checked ? [...prev, l.name] : prev.filter((x) => x !== l.name)))} />
                <span className="label-chip" style={labelChipStyle(l.color, false)}>{l.name}</span>
              </label>
            ))}
          </div>
        </div>
      ) : null}
      <TextField label="Assignees" value={assigneesInput} onChange={(e) => setAssigneesInput(e.target.value)} hint="Comma-separated GitHub usernames" placeholder="octocat, hubot" />
      {error ? <Callout tone="danger">{error}</Callout> : null}
    </Dialog>
  );
}
