import React from 'react';
import { invoke } from '../api';
import { Button } from './ui';

interface State {
  details: string | null;
  copied: boolean;
}

/** Last-resort catch for render errors: shows what happened, offers Reload and Copy details, and logs the error to the main-process log via `app.log`. Uses no store state, so it still works when the crash came from a store selector. */
export class ErrorBoundary extends React.Component<{ children: React.ReactNode }, State> {
  override state: State = { details: null, copied: false };

  static getDerivedStateFromError(error: unknown): Partial<State> {
    return { details: error instanceof Error ? error.stack ?? error.message : String(error) };
  }

  override componentDidCatch(error: unknown, info: React.ErrorInfo): void {
    const details = `${error instanceof Error ? error.stack ?? error.message : String(error)}\n\nComponent stack:${info.componentStack ?? ''}`;
    this.setState({ details });
    void invoke('app.log', 'error', `Render error: ${details}`).catch(() => undefined);
  }

  override render(): React.ReactNode {
    const { details, copied } = this.state;
    if (details === null) return this.props.children;
    return (
      <div className="empty-state" role="alert" style={{ height: '100vh', overflow: 'auto' }}>
        <h2>Something went wrong</h2>
        <p>GitGood hit an unexpected error while drawing this screen. Your repository and any uncommitted changes are untouched. Reloading usually fixes it.</p>
        <pre className="selectable mono" style={{ maxWidth: 720, maxHeight: 240, overflow: 'auto', textAlign: 'left', whiteSpace: 'pre-wrap', fontSize: 12 }}>{details}</pre>
        <div style={{ display: 'flex', gap: 8 }}>
          <Button variant="primary" onClick={() => window.location.reload()}>Reload</Button>
          <Button
            onClick={() => {
              void invoke('app.clipboard.write', details)
                .then(() => this.setState({ copied: true }))
                .catch(() => undefined);
            }}
          >
            {copied ? 'Copied' : 'Copy details'}
          </Button>
        </div>
      </div>
    );
  }
}
