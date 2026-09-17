import React from 'react';
import { dismissToast, useAppStore } from '../state/store';
import { Button, Icon } from './ui';

export function Toasts(): React.JSX.Element | null {
  const toasts = useAppStore((s) => s.toasts);
  if (!toasts.length) return null;
  return (
    <div className="toasts">
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
