import React, { useRef } from 'react';
import type { ExplainReference, Explanation } from '@shared/types';
import { EXPLAIN_FOLLOWUP_LIMIT } from '@shared/types';
import * as actions from '../../state/actions';
import { useAppStore } from '../../state/store';
import { Badge, Button, Icon, Spinner } from '../ui';

/** Right-hand panel of DiffPane.tsx showing the current AI explanation, its follow-ups, and Copy as Markdown. Collapsible and resizable (width persisted in localStorage). */
export function ExplainPanel(): React.JSX.Element {
  const explain = useAppStore((s) => s.explain);
  const panelRef = useRef<HTMLElement>(null);

  const startResize = (e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = explain.width;
    const onMove = (ev: MouseEvent) => actions.setExplainPanelWidth(startWidth + (startX - ev.clientX));
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  if (explain.panelCollapsed) {
    return (
      <aside className="explain-panel collapsed" ref={panelRef as React.RefObject<HTMLElement>}>
        <Button size="sm" variant="ghost" iconOnly icon="chevron-right" title="Show explanation" onClick={() => actions.toggleExplainPanelCollapsed()} />
        <Icon name="sparkle" />
        {explain.loading ? <Spinner /> : null}
      </aside>
    );
  }

  return (
    <aside className="explain-panel" style={{ width: explain.width }} ref={panelRef as React.RefObject<HTMLElement>}>
      <div className="explain-resize-handle" onMouseDown={startResize} />
      <div className="explain-panel-header">
        <div className="explain-panel-title">
          <Icon name="sparkle" />
          <strong className="truncate" title={explain.label ?? undefined}>
            {explain.label ?? 'Explain'}
          </strong>
          {explain.result?.truncated ? (
            <Badge tone="attention" title="The input was too large; some files or lines were left out">
              partial
            </Badge>
          ) : null}
          {explain.loading ? <Spinner /> : null}
          <span style={{ flex: 1 }} />
          {explain.result ? <Button size="sm" variant="ghost" iconOnly icon="copy" title="Copy as Markdown" onClick={() => actions.copyExplanationMarkdown()} /> : null}
          <Button size="sm" variant="ghost" iconOnly icon="chevron-right" title="Hide explanation" onClick={() => actions.toggleExplainPanelCollapsed()} />
          <Button size="sm" variant="ghost" iconOnly icon="x" title="Close" onClick={() => actions.closeExplainPanel()} />
        </div>
      </div>
      <div className="explain-body">
        {explain.loading ? (
          <div className="list-empty">
            <Spinner large />
            <span>Explaining…</span>
            <Button size="sm" variant="ghost" onClick={() => actions.cancelExplain()}>
              Cancel
            </Button>
          </div>
        ) : explain.error ? (
          <div className="explain-error">
            <Icon name="alert" size={20} />
            <span>{explain.error}</span>
            <Button size="sm" onClick={() => actions.retryExplain()}>
              Retry
            </Button>
          </div>
        ) : explain.result ? (
          <>
            <ExplainSections explanation={explain.result} />
            <ExplainFollowUps />
          </>
        ) : null}
      </div>
    </aside>
  );
}

function ReferenceLink({ reference }: { reference: ExplainReference }): React.JSX.Element {
  return (
    <button type="button" className="explain-reference" onClick={() => actions.focusExplainReference(reference.path, reference.line)} title={`${reference.path}${reference.line !== null ? `:${reference.line}` : ''}`}>
      <Icon name="chevron-right" size={10} />
      <span className="mono truncate">
        {reference.path}
        {reference.line !== null ? `:${reference.line}` : ''}
      </span>
      <span className="explain-reference-label truncate">{reference.label}</span>
    </button>
  );
}

function ExplainSections({ explanation }: { explanation: Explanation }): React.JSX.Element {
  return (
    <div className="explain-sections">
      <section>
        <h4>What changed</h4>
        <p className="selectable">{explanation.whatChanged}</p>
      </section>
      {explanation.why ? (
        <section>
          <h4>Why (inferred)</h4>
          <p className="selectable">{explanation.why}</p>
        </section>
      ) : null}
      {explanation.impact ? (
        <section>
          <h4>Impact</h4>
          <p className="selectable">{explanation.impact}</p>
        </section>
      ) : null}
      {explanation.watchOutFor.length ? (
        <section>
          <h4>Watch out for</h4>
          <ul className="selectable">
            {explanation.watchOutFor.map((item, i) => (
              <li key={i}>{item}</li>
            ))}
          </ul>
        </section>
      ) : null}
      {explanation.references.length ? (
        <section>
          <h4>References</h4>
          <div className="explain-references">
            {explanation.references.map((r, i) => (
              <ReferenceLink key={i} reference={r} />
            ))}
          </div>
        </section>
      ) : null}
      {explanation.droppedReferences ? (
        <p className="muted" style={{ fontSize: 11 }}>
          {explanation.droppedReferences} reference{explanation.droppedReferences === 1 ? '' : 's'} dropped (did not match the diff).
        </p>
      ) : null}
    </div>
  );
}

function ExplainFollowUps(): React.JSX.Element {
  const explain = useAppStore((s) => s.explain);
  const remaining = EXPLAIN_FOLLOWUP_LIMIT - explain.followUps.length;
  const limitReached = remaining <= 0;
  const submit = () => {
    if (!limitReached && explain.followUpDraft.trim() && !explain.followUpLoading) void actions.askExplainFollowUp();
  };
  return (
    <div className="explain-followups">
      {explain.followUps.map((f, i) => (
        <div className="explain-followup" key={i}>
          <p className="explain-followup-question selectable">
            <Icon name="issue" size={12} /> {f.question}
          </p>
          <p className="explain-followup-answer selectable">{f.answer}</p>
        </div>
      ))}
      {explain.followUpError ? (
        <p className="muted explain-followup-error">
          <Icon name="alert" size={12} /> {explain.followUpError}
        </p>
      ) : null}
      <div className="explain-followup-input">
        <textarea
          rows={2}
          placeholder={limitReached ? `You've reached the ${EXPLAIN_FOLLOWUP_LIMIT}-question limit for this explanation.` : 'Ask a follow-up question…'}
          value={explain.followUpDraft}
          disabled={limitReached || explain.followUpLoading}
          onChange={(e) => actions.setExplainFollowUpDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
        />
        <div className="explain-followup-actions">
          <span className="muted" style={{ fontSize: 11 }}>
            {limitReached ? 'Limit reached' : `${remaining} question${remaining === 1 ? '' : 's'} left`}
          </span>
          <Button size="sm" loading={explain.followUpLoading} disabled={limitReached || !explain.followUpDraft.trim()} onClick={submit}>
            Ask
          </Button>
        </div>
      </div>
    </div>
  );
}
