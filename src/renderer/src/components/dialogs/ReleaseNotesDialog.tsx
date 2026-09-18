import React, { useEffect, useState } from 'react';
import type { ReleaseNotes, ReleaseNotesUnreferencedEntry, ReleaseRangeResult } from '@shared/types';
import { appendDraftFooter, RELEASE_NOTES_FOOTER, suggestNextPatchVersion } from '@shared/util';
import { errorInfo, errorMessage, invoke } from '../../api';
import * as actions from '../../state/actions';
import { closeDialog, useAppStore } from '../../state/store';
import { Button, Callout, Checkbox, Dialog, Spinner, TextField } from '../ui';
import { NOTICE_KEY } from './ReviewDialogs';

/** Synthetic `ai.progress` path the main process reports release notes generation under (see RELEASE_NOTES_PROGRESS_PATH in src/main/ipc.ts). */
const PROGRESS_PATH = '<release notes>';

/** Reads the persisted "seen" flag for the shared AI first-use disclosure notice (see ReviewDialogs.tsx's NOTICE_KEY). */
function noticeAlreadySeen(): boolean {
  try {
    return localStorage.getItem(NOTICE_KEY) === '1';
  } catch {
    return true;
  }
}


function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/** A plain commit list, in the same Markdown shape GitGood's own assembly uses, for "Export commit list" without AI. */
function exportCommitListMarkdown(range: ReleaseRangeResult, version: string): string {
  const lines = range.commits.map((c) => `- ${c.subject} (${c.shortSha})`);
  return `## ${version.trim() || 'Unreleased'} (${todayIso()})\n\n${lines.length ? lines.join('\n') : '(no commits in range)'}\n`;
}

/** Minimal, dependency-free rendering of the Markdown GitGood itself produces (## / ### headings and "- " bullets only; no inline emphasis, no new dependency). */
function MarkdownPreview({ text }: { text: string }): React.JSX.Element {
  const lines = text.split(/\r?\n/);
  return (
    <div className="markdown-preview callout" style={{ display: 'block' }}>
      {lines.map((line, i) => {
        if (line.startsWith('## ')) return <h3 key={i}>{line.slice(3)}</h3>;
        if (line.startsWith('### ')) return <h4 key={i}>{line.slice(4)}</h4>;
        if (line.startsWith('- ')) return (
          <p key={i} style={{ margin: '2px 0' }}>
            • {line.slice(2)}
          </p>
        );
        if (!line.trim()) return null;
        return (
          <p key={i} style={{ margin: '2px 0' }}>
            {line}
          </p>
        );
      })}
    </div>
  );
}

export function ReleaseNotesDialog({ fromTag }: { fromTag: string | null }): React.JSX.Element | null {
  const repo = useAppStore((s) => s.currentRepo);
  const status = useAppStore((s) => s.status);
  const settings = useAppStore((s) => s.settings);
  const tools = useAppStore((s) => s.tools);
  const progress = useAppStore((s) => s.ai[PROGRESS_PATH]);
  const aiEnabled = settings?.ai.provider !== 'disabled';
  const signedIn = !!tools?.ghAccount;

  const [to, setTo] = useState('HEAD');
  const [from, setFrom] = useState<string | null>(fromTag ?? null);
  const [fromInitialized, setFromInitialized] = useState(!!fromTag);
  const [version, setVersion] = useState('');
  const [versionTouched, setVersionTouched] = useState(false);
  const [audience, setAudience] = useState<'users' | 'developers'>(settings?.ai.releaseNotesAudience ?? 'users');
  const [includePrs, setIncludePrs] = useState(!!repo?.github && signedIn);

  const [range, setRange] = useState<ReleaseRangeResult | null>(null);
  const [rangeLoading, setRangeLoading] = useState(false);
  const [rangeError, setRangeError] = useState<string | null>(null);

  const [notice, setNotice] = useState(noticeAlreadySeen);
  const [generating, setGenerating] = useState(false);
  const [notes, setNotes] = useState<ReleaseNotes | null>(null);
  const [aiOrigin, setAiOrigin] = useState(false);
  const [markdown, setMarkdown] = useState('');
  const [showPreview, setShowPreview] = useState(false);
  const [unreferenced, setUnreferenced] = useState<ReleaseNotesUnreferencedEntry[]>([]);
  const [genError, setGenError] = useState<string | null>(null);

  const [inserting, setInserting] = useState(false);

  const [showRelease, setShowRelease] = useState(false);
  const [releaseTitle, setReleaseTitle] = useState('');
  const [releaseDraft, setReleaseDraft] = useState(true);
  const [releasePrerelease, setReleasePrerelease] = useState(false);
  const [existingRelease, setExistingRelease] = useState<{ url: string } | null>(null);
  const [releaseChecking, setReleaseChecking] = useState(false);
  const [releaseBusy, setReleaseBusy] = useState(false);
  const [releaseError, setReleaseError] = useState<string | null>(null);

  useEffect(() => {
    if (!repo) return;
    let cancelled = false;
    setRangeLoading(true);
    setRangeError(null);
    void invoke('repo.release.range', repo.path, { from, to, includePrs })
      .then((result) => {
        if (cancelled) return;
        setRange(result);
        if (!fromInitialized) {
          setFromInitialized(true);
          setFrom(result.range.from);
          if (!versionTouched && result.latestTag) {
            const suggestion = suggestNextPatchVersion(result.latestTag);
            if (suggestion) setVersion(suggestion);
          }
        }
      })
      .catch((err) => {
        if (!cancelled) setRangeError(errorMessage(err));
      })
      .finally(() => {
        if (!cancelled) setRangeLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repo, from, to, includePrs]);

  if (!repo) return null;

  const generate = async () => {
    if (!range || generating) return;
    try {
      localStorage.setItem(NOTICE_KEY, '1');
    } catch {
      /* private mode */
    }
    setNotice(true);
    setGenerating(true);
    setGenError(null);
    try {
      const result = await invoke('ai.releaseNotes', repo.path, { range: { from, to }, version, audience, includePrs });
      setNotes(result);
      setMarkdown(result.markdown);
      setUnreferenced(result.unreferenced);
      setAiOrigin(true);
    } catch (err) {
      if (errorInfo(err).code !== 'cancelled') setGenError(errorMessage(err));
    } finally {
      setGenerating(false);
    }
  };

  const exportList = () => {
    if (!range) return;
    setMarkdown(exportCommitListMarkdown(range, version));
    setNotes(null);
    setUnreferenced([]);
    setAiOrigin(false);
    setGenError(null);
  };

  const addOmission = (entry: ReleaseNotesUnreferencedEntry) => {
    setMarkdown((md) => `${md.trimEnd()}\n- ${entry.text}\n`);
    setUnreferenced((list) => list.filter((e) => e !== entry));
  };

  const insertIntoChangelog = async () => {
    if (!markdown.trim() || inserting) return;
    setInserting(true);
    setGenError(null);
    try {
      await invoke('repo.changelog.insert', repo.path, markdown);
      await actions.refreshStatus();
      actions.setView('changes');
      actions.selectWorkingFile('CHANGELOG.md');
      closeDialog();
      actions.showToast({ kind: 'success', title: 'Inserted into CHANGELOG.md', message: 'Review the diff and commit when ready.' });
    } catch (err) {
      setGenError(errorMessage(err));
    } finally {
      setInserting(false);
    }
  };

  const openReleasePanel = () => {
    setShowRelease(true);
    setReleaseTitle(version.trim() || 'Release');
    setReleaseError(null);
    setReleaseChecking(true);
    const tag = version.trim();
    if (!tag) {
      setExistingRelease(null);
      setReleaseChecking(false);
      return;
    }
    void invoke('gh.release.view', repo.path, tag)
      .then(setExistingRelease)
      .catch(() => setExistingRelease(null))
      .finally(() => setReleaseChecking(false));
  };

  const createRelease = async () => {
    const tag = version.trim();
    if (!tag || releaseBusy) return;
    setReleaseBusy(true);
    setReleaseError(null);
    try {
      const tags = await invoke('repo.tags', repo.path);
      const tagExists = tags.some((t) => t.name === tag);
      const targetSha = !tagExists ? (status?.branch.sha ?? null) : null;
      const body = appendDraftFooter(markdown, aiOrigin && settings?.ai.reviewPostFooter ? RELEASE_NOTES_FOOTER : null);
      const result = await invoke('gh.release.create', repo.path, { tag, title: releaseTitle.trim() || tag, body, draft: releaseDraft, prerelease: releasePrerelease, targetSha });
      actions.showToast({ kind: 'success', title: 'Release created', message: result.url, action: { label: 'Open', onClick: () => void actions.openExternal(result.url) } }, 10000);
      setShowRelease(false);
    } catch (err) {
      setReleaseError(errorMessage(err));
    } finally {
      setReleaseBusy(false);
    }
  };

  const ghUnavailable = !repo.github ? 'This repository has no GitHub remote.' : !signedIn ? 'Sign in to GitHub from Options → Accounts first.' : null;
  const canGenerate = aiEnabled && !!range && range.commits.length > 0 && !generating;

  return (
    <Dialog
      title="Release notes"
      icon="tag"
      onClose={closeDialog}
      width="xwide"
      footer={
        <>
          {generating ? <Button onClick={() => void invoke('ai.cancel')}>Cancel</Button> : <Button onClick={closeDialog}>Close</Button>}
          <Button onClick={exportList} disabled={!range || rangeLoading}>
            Export commit list
          </Button>
          {aiEnabled ? (
            <Button variant="primary" icon="sparkle" className="sparkle" loading={generating} disabled={!canGenerate} title={!range?.commits.length ? 'There are no commits in this range' : ''} onClick={() => void generate()}>
              Generate
            </Button>
          ) : null}
        </>
      }
    >
      <div className="form-grid">
        <div className="field">
          <label>From</label>
          <input value={from ?? ''} placeholder={range?.rootFallback ? 'root commit' : ''} onChange={(e) => setFrom(e.target.value || null)} disabled={generating} />
        </div>
        <div className="field">
          <label>To</label>
          <input value={to} onChange={(e) => setTo(e.target.value)} disabled={generating} />
        </div>
      </div>
      {range?.rootFallback ? <p className="hint">This repository has no tags; the range starts at the root commit.</p> : null}
      <div className="form-grid">
        <div className="field">
          <TextField label="Version" value={version} onChange={(e) => { setVersion(e.target.value); setVersionTouched(true); }} placeholder="e.g. 1.2.4" disabled={generating} />
        </div>
        <div className="field">
          <label>Audience</label>
          <select value={audience} onChange={(e) => setAudience(e.target.value as 'users' | 'developers')} disabled={generating}>
            <option value="users">Users</option>
            <option value="developers">Developers</option>
          </select>
        </div>
      </div>
      <Checkbox
        checked={includePrs}
        onChange={setIncludePrs}
        disabled={!repo.github || !signedIn}
        label="Include pull request titles"
        title={!repo.github ? 'This repository has no GitHub remote' : !signedIn ? 'Sign in to GitHub to fetch pull request titles' : ''}
      />
      {aiEnabled && !notice ? (
        <Callout tone="info">
          Generating sends the commit subjects, messages and {includePrs ? 'pull request titles' : 'a diff summary'} in this range to {settings?.ai.provider === 'claude-cli' ? 'Claude Code' : 'the Anthropic API'}. Turn off "Include pull request titles" to
          keep those out.
        </Callout>
      ) : null}

      <h4 style={{ margin: '12px 0 6px', fontSize: 12, textTransform: 'uppercase', color: 'var(--fg-muted)' }}>Range preview</h4>
      {rangeLoading ? (
        <Spinner />
      ) : rangeError ? (
        <Callout tone="danger">{rangeError}</Callout>
      ) : range ? (
        <>
          {range.truncated ? <Callout tone="warning">This range has more than 500 commits; only subjects were gathered. Narrow the range for better results.</Callout> : null}
          <p className="muted">
            {range.commits.length} commit{range.commits.length === 1 ? '' : 's'}
            {range.prs.length ? `, ${range.prs.length} pull request${range.prs.length === 1 ? '' : 's'}` : ''}
          </p>
          <div className="checks-list" style={{ maxHeight: 160, overflowY: 'auto' }}>
            {range.commits.slice(0, 100).map((c) => (
              <div key={c.sha} className="check-row">
                <span className="mono muted">{c.shortSha}</span>
                <span className="name">{c.subject}</span>
              </div>
            ))}
          </div>
        </>
      ) : null}

      {generating ? (
        <p>
          <Spinner /> {progress?.message ?? 'Drafting…'}
        </p>
      ) : null}
      {genError ? <Callout tone="danger">{genError}</Callout> : null}

      {markdown ? (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '12px 0 6px' }}>
            <h4 style={{ margin: 0, fontSize: 12, textTransform: 'uppercase', color: 'var(--fg-muted)', flex: 1 }}>Notes</h4>
            <Button size="sm" onClick={() => setShowPreview((v) => !v)}>{showPreview ? 'Edit' : 'Preview'}</Button>
            <Button size="sm" icon="copy" onClick={() => void actions.copyToClipboard(markdown, 'Markdown copied')}>Copy Markdown</Button>
          </div>
          {showPreview ? <MarkdownPreview text={markdown} /> : <textarea rows={10} value={markdown} onChange={(e) => { setMarkdown(e.target.value); setAiOrigin(false); }} />}

          {unreferenced.length ? (
            <>
              <h4 style={{ margin: '12px 0 6px', fontSize: 12, textTransform: 'uppercase', color: 'var(--fg-muted)' }}>Not cited by any item</h4>
              <div className="checks-list" style={{ maxHeight: 140, overflowY: 'auto' }}>
                {unreferenced.map((entry, i) => (
                  <div key={i} className="check-row">
                    <span className="name">{entry.text}</span>
                    {entry.ref ? (
                      <Button size="sm" onClick={() => addOmission(entry)}>
                        Add
                      </Button>
                    ) : null}
                  </div>
                ))}
              </div>
            </>
          ) : null}

          <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
            <Button loading={inserting} onClick={() => void insertIntoChangelog()}>
              Insert into CHANGELOG.md
            </Button>
            <Button disabled={!!ghUnavailable} title={ghUnavailable ?? ''} onClick={openReleasePanel}>
              Create GitHub release…
            </Button>
          </div>

          {showRelease ? (
            <Callout tone="info">
              {releaseChecking ? (
                <Spinner />
              ) : existingRelease ? (
                <>
                  A release already exists for tag <strong>{version.trim()}</strong>.
                  <div style={{ marginTop: 6 }}>
                    <Button size="sm" icon="external" onClick={() => void actions.openExternal(existingRelease.url)}>
                      Open existing release
                    </Button>
                  </div>
                </>
              ) : (
                <>
                  <div className="field">
                    <label>Title</label>
                    <input value={releaseTitle} onChange={(e) => setReleaseTitle(e.target.value)} disabled={releaseBusy} />
                  </div>
                  <p className="muted" style={{ marginTop: 4 }}>
                    Tag: <span className="mono">{version.trim() || '(set a version above)'}</span>
                    {status?.branch.sha ? ' — created at the current commit if it does not exist yet.' : ''}
                  </p>
                  <Checkbox checked={releaseDraft} onChange={setReleaseDraft} label="Draft" disabled={releaseBusy} />
                  <Checkbox checked={releasePrerelease} onChange={setReleasePrerelease} label="Pre-release" disabled={releaseBusy} />
                  {releaseError ? <Callout tone="danger">{releaseError}</Callout> : null}
                  <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                    <Button size="sm" onClick={() => setShowRelease(false)} disabled={releaseBusy}>
                      Cancel
                    </Button>
                    <Button size="sm" variant="primary" loading={releaseBusy} disabled={!version.trim()} onClick={() => void createRelease()}>
                      {releaseDraft ? 'Create draft release' : 'Create release'}
                    </Button>
                  </div>
                </>
              )}
            </Callout>
          ) : null}
        </>
      ) : null}
    </Dialog>
  );
}
