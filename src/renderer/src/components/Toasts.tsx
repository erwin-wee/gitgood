import React from 'react';
import * as actions from '../state/actions';
import { dismissToast, useAppStore } from '../state/store';
import { Button, Icon, Spinner } from './ui';

export function Toasts(): React.JSX.Element | null {
  const toasts = useAppStore((s) => s.toasts);
  const review = useAppStore((s) => s.review);
  if (!toasts.length && !review.running) return null;
  return (
    <div className="toasts">
      {review.running ? (
        <div className="toast info review-progress-toast" role="status">
          <Spinner />
          <div className="toast-body">
            <strong>Reviewing with AI{review.progress && review.progress.total ? ` · ${Math.min(review.progress.index, review.progress.total)}/${review.progress.total}` : ''}</strong>
            <span>{review.progress?.message ?? 'Preparing…'}</span>
          </div>
          {!review.open ? <Button size="sm" onClick={() => actions.patchReviewOpen()}>Show</Button> : null}
          <Button size="sm" variant="ghost" onClick={() => void actions.cancelReview()}>Cancel</Button>
        </div>
      ) : null}
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`} role="status">
          <Icon className="toast-icon" name={t.kind === 'success' ? 'check-circle' : t.kind === 'error' ? 'x-circle' : t.kind === 'warning' ? 'alert' : 'info'} />
          <div className="toast-body">
            <strong>{t.title}</strong>
            {t.message ? <span>{t.message}</span> : null}
          </div>
          {t.action ? (
            <Button
              size="sm"
              onClick={() => {
                t.action!.onClick();
                dismissToast(t.id);
              }}
            >
              {t.action.label}
            </Button>
          ) : null}
          <Button size="sm" variant="ghost" iconOnly icon="x" onClick={() => dismissToast(t.id)} title="Dismiss" />
        </div>
      ))}
    </div>
  );
}
