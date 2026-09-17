import React, { useMemo } from 'react';
import type { FileDiff } from '@shared/types';
import { applyResolutions, parseConflicts, resolutionForChoice, type BlockChoice } from '@shared/diff/conflicts';
import { escapeHtml } from '@shared/util';
import { highlightToLines } from '../../lib/highlight';
import * as actions from '../../state/actions';
import { useAppStore } from '../../state/store';
import { Button, Icon, Spinner } from '../ui';

type ConflictData = Extract<FileDiff, { kind: 'conflict' }>;

export function ConflictDiff({ diff, path, syntax }: { diff: ConflictData; path: string; syntax: boolean }): React.JSX.Element {
  const settings = useAppStore((s) => s.settings);
  const aiBusy = useAppStore((s) => s.aiBusy);
  const aiState = useAppStore((s) => s.ai[path]);
  const operation = useAppStore((s) => s.status?.operation.kind ?? 'none');
  const parsed = useMemo(() => parseConflicts(diff.content), [diff.content]);
  const hl = useMemo(() => (syntax ? highlightToLines(diff.content, diff.language) : null), [syntax, diff.content, diff.language]);

  const lineKinds = useMemo(() => {
    const kinds: ('plain' | 'marker' | 'ours' | 'base' | 'theirs')[] = new Array(parsed.lines.length).fill('plain');
    for (const b of parsed.blocks) {
      let section: 'ours' | 'base' | 'theirs' = 'ours';
      kinds[b.start] = 'marker';
      for (let i = b.start + 1; i < b.end - 1; i++) {
        const l = parsed.lines[i];
        if (/^\|{7,}/.test(l) && section === 'ours') {
          section = 'base';
          kinds[i] = 'marker';
          continue;
        }
        if (/^={7,}$/.test(l) && section !== 'theirs') {
          section = 'theirs';
          kinds[i] = 'marker';
          continue;
        }
        kinds[i] = section;
      }
      kinds[b.end - 1] = 'marker';
    }
    return kinds;
  }, [parsed]);

  const choose = (blockId: number, choice: BlockChoice) => {
    const block = parsed.blocks.find((b) => b.id === blockId);
    if (!block) return;
    const content = applyResolutions(parsed, new Map([[blockId, resolutionForChoice(block, choice)]]));
    void actions.writeResolvedContent(path, content, parsed.blocks.length > 1);
  };

  const oursName = operation === 'rebase' ? `${diff.oursLabel} (upstream)` : `${diff.oursLabel} (current branch)`;
  const theirsName = operation === 'rebase' ? `${diff.theirsLabel} (your commit)` : `${diff.theirsLabel} (incoming)`;
  const aiEnabled = settings?.ai.provider !== 'disabled';

  return (
    <div className="conflict-view">
      <div className="conflict-toolbar">
        <Icon name="alert" />
        <strong>
          {parsed.blocks.length} conflict{parsed.blocks.length === 1 ? '' : 's'} in this file
        </strong>
        {aiState && aiState.phase !== 'done' && aiState.phase !== 'error' ? (
          <span className="ai-status">
            <Spinner /> {aiState.message}
          </span>
        ) : null}
        <span className="spacer" />
        {aiEnabled ? (
          <Button variant="accent" size="sm" icon="sparkle" loading={aiBusy} onClick={() => void actions.resolveWithAi(path)} title="Let Claude reconcile both sides of every conflict block">
            Resolve with AI
          </Button>
        ) : null}
        <Button size="sm" onClick={() => void actions.useSide(path, 'ours')} title={`Take the whole file from ${oursName}`}>Use ours</Button>
        <Button size="sm" onClick={() => void actions.useSide(path, 'theirs')} title={`Take the whole file from ${theirsName}`}>Use theirs</Button>
        <Button size="sm" icon="pencil" onClick={() => void actions.openInEditor(path)}>Open in editor</Button>
        {parsed.blocks.length === 0 ? (
          <Button size="sm" variant="primary" icon="check" onClick={() => void actions.markResolved([path])}>Mark as resolved</Button>
        ) : null}
      </div>
      <div>
        {parsed.lines.map((line, i) => {
          const kind = lineKinds[i];
          const block = kind === 'marker' ? parsed.blocks.find((b) => b.end - 1 === i) : undefined;
          return (
            <React.Fragment key={i}>
              <div className={`conflict-line ${kind}`}>
                <span className="num">{i + 1}</span>
                <span className="code" dangerouslySetInnerHTML={{ __html: kind === 'plain' && hl && hl[i] !== undefined ? hl[i] || ' ' : escapeHtml(line) || ' ' }} />
              </div>
              {block ? (
                <div className="conflict-block-actions">
                  <span className="label">Accept:</span>
                  <Button size="sm" onClick={() => choose(block.id, 'ours')} title={oursName}>Ours</Button>
                  <Button size="sm" onClick={() => choose(block.id, 'theirs')} title={theirsName}>Theirs</Button>
                  <Button size="sm" onClick={() => choose(block.id, 'both')} title="Ours followed by theirs">Both</Button>
                  <Button size="sm" onClick={() => choose(block.id, 'both-reversed')} title="Theirs followed by ours">Both (theirs first)</Button>
                  {block.base ? <Button size="sm" onClick={() => choose(block.id, 'base')} title="Restore the common ancestor version">Base</Button> : null}
                </div>
              ) : null}
            </React.Fragment>
          );
        })}
      </div>
    </div>
  );
}
