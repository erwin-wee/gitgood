import React, { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Button, Callout } from './ui';

export function HelpPopover({ title, explanation, note }: { title: string; explanation: ReactNode; note: ReactNode }): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const titleId = useId();

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        setOpen(false);
      }
    };
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener('keydown', onKeyDown);
    document.addEventListener('pointerdown', onPointerDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('pointerdown', onPointerDown);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="help-popover-wrap">
      <Button
        variant="ghost"
        size="sm"
        className="help-popover-trigger"
        aria-label={`Help: ${title}`}
        aria-expanded={open}
        aria-controls={open ? titleId : undefined}
        onClick={() => setOpen((value) => !value)}
      >
        ?
      </Button>
      {open ? (
        <div id={titleId} className="help-popover popover" role="dialog" aria-label={title}>
          <div className="help-popover-content">
            <strong>{title}</strong>
            <p>{explanation}</p>
            <Callout tone="warning">{note}</Callout>
          </div>
        </div>
      ) : null}
    </div>
  );
}
