import React, { useEffect, useState } from 'react';
import type { FileAtCommitResult } from '@shared/types';
import { buildFileViewDiff } from '@shared/diff/parse';
import { formatBytes } from '@shared/util';
import { invoke } from '../../api';
import * as actions from '../../state/actions';
import { closeDialog, useAppStore } from '../../state/store';
import { Button, Dialog, Icon, Spinner } from '../ui';
import { TextDiff } from '../diff/TextDiff';

/** Read-only viewer for a file's content at a specific commit ("View file at this commit"). */
export function FileAtCommitDialog({ path, sha }: { path: string; sha: string }): React.JSX.Element {
  const repo = useAppStore((s) => s.currentRepo);
  const [result, setResult] = useState<FileAtCommitResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setResult(null);
    setError(null);
    if (!repo) return;
    invoke('repo.fileAtCommit', repo.path, sha, path)
      .then((r) => {
        if (!cancelled) setResult(r);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [repo, sha, path]);

  return (
    <Dialog
      title={
        <span className="mono" style={{ fontSize: 14 }}>
          {path} @ {sha.slice(0, 7)}
        </span>
      }
      icon="file"
      width="xwide"
      onClose={closeDialog}
      footer={
        <>
          <Button onClick={closeDialog}>Close</Button>
          <Button variant="primary" onClick={() => { closeDialog(); actions.requestRestoreFile(path, sha); }} disabled={!result || result.content === null}>Restore this version…</Button>
        </>
      }
    >
      <div className="diff-body" style={{ maxHeight: '65vh', minHeight: 200 }}>
        {error ? (
          <div className="diff-message">
            <Icon name="alert" size={24} />
            <strong>Could not load this file</strong>
            <span>{error}</span>
          </div>
        ) : !result ? (
          <div style={{ display: 'flex', justifyContent: 'center', padding: 40 }}>
            <Spinner large />
          </div>
        ) : result.binary ? (
          <div className="diff-message">
            <Icon name="file" size={24} />
            <strong>Binary file not shown</strong>
            <span>{formatBytes(result.bytes)}</span>
          </div>
        ) : result.content === null ? (
          <div className="diff-message">
            <Icon name="alert" size={24} />
            <strong>This file is too large to display</strong>
            <span>{formatBytes(result.bytes)}</span>
          </div>
        ) : (
          (() => {
            const view = buildFileViewDiff(path, result.content, Infinity);
            return view.kind === 'text' ? (
              <TextDiff diff={view} mode="unified" wrap={false} syntax intraline={false} selectable={false} selectedLines={null} />
            ) : (
              <div className="diff-message">
                <Icon name="alert" size={24} />
                <strong>This file is too large to display</strong>
              </div>
            );
          })()
        )}
      </div>
    </Dialog>
  );
}
