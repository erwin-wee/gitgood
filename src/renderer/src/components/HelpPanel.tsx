import React, { useEffect, useRef } from 'react';
import { store, useAppStore } from '../state/store';
import { Button, Icon } from './ui';

const QUICK_STARTS = [
  { title: 'Staging & committing', body: 'Select the files you want, write a message, then commit. Stage only what belongs together.' },
  { title: 'Branches', body: 'Create a branch before you start a thread of work. Push it when you are ready to share.' },
  { title: 'Rebase / Squash', body: 'Use Tidy to clean up a branch before sharing it. Review every proposed rewrite before applying it.' },
  { title: 'AI Review', body: 'Review a branch or pull request for actionable findings, then decide what to fix or discuss.' },
  { title: 'Split into commits', body: 'Let AI group related hunks into focused commits, then edit the plan before anything is applied.' },
  { title: 'Tidy branch', body: 'Ask AI to squash fixups, improve messages, and drop empty commits while keeping you in control.' },
  { title: 'Resolving conflicts', body: 'Compare ours and theirs, choose a side or edit the file, then confirm the conflict is resolved.' },
];

export function HelpPanel(): React.JSX.Element | null {
  const open = useAppStore((state) => state.helpOpen);
  const panelRef = useRef<HTMLElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    openerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const first = panelRef.current?.querySelector<HTMLElement>('button, a[href], [tabindex]:not([tabindex="-1"])');
    first?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        store.set({ helpOpen: false });
        return;
      }
      if (event.key !== 'Tab' || !panelRef.current) return;
      const focusables = [...panelRef.current.querySelectorAll<HTMLElement>('a[href],button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex]:not([tabindex="-1"])')];
      if (!focusables.length) {
        event.preventDefault();
        return;
      }
      const firstFocusable = focusables[0];
      const lastFocusable = focusables[focusables.length - 1];
      const active = document.activeElement;
      if (event.shiftKey ? active === firstFocusable || !panelRef.current.contains(active) : active === lastFocusable || !panelRef.current.contains(active)) {
        event.preventDefault();
        (event.shiftKey ? lastFocusable : firstFocusable).focus();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      if (openerRef.current?.isConnected) openerRef.current.focus();
    };
  }, [open]);

  if (!open) return null;

  return (
    <div className="help-backdrop" onMouseDown={(event) => event.target === event.currentTarget && store.set({ helpOpen: false })}>
      <aside ref={panelRef} className="help-panel" role="dialog" aria-modal="true" aria-label="Help">
        <header className="help-panel-header">
          <div>
            <div className="help-panel-title"><Icon name="info" /><h2>Help</h2></div>
            <p>Quick answers for the work in front of you.</p>
          </div>
          <Button variant="ghost" iconOnly icon="x" aria-label="Close help" title="Close help" onClick={() => store.set({ helpOpen: false })} />
        </header>
        <div className="help-panel-body">
          {QUICK_STARTS.map((item) => (
            <section key={item.title} className="help-section">
              <h3>{item.title}</h3>
              <p>{item.body}</p>
            </section>
          ))}
        </div>
        <footer className="help-panel-footer"><span>Press <kbd>Esc</kbd> to close</span></footer>
      </aside>
    </div>
  );
}
