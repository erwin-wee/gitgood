import React, { useMemo, useState } from 'react';
import { parseConflicts } from '@shared/diff/conflicts';
import * as actions from '../../state/actions';
import { closeDialog, useAppStore } from '../../state/store';
import { Button, Callout, Dialog } from '../ui';
import { HelpPopover } from '../HelpPopover';
/** Collapsible read-only excerpt of one side of the original conflict block. */
function SideExcerpt({ label, lines }: { label: string; lines: string[] }): React.JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <div className="resolution-side">
      <Button variant="ghost" size="sm" className="resolution-side-toggle" icon={open ? 'chevron-down' : 'chevron-right'} aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        {label} ({lines.length} line{lines.length === 1 ? '' : 's'})
      </Button>
      {open ? <pre className="details-block">{lines.join('\n') || '(empty)'}</pre> : null}
    </div>
  );
}

/** The "explain why" popover for one AI-resolved conflict block: the model's rationale, the original ours/theirs/base text, and per-block Accept / Use ours / Use theirs / Use base / Edit in editor actions. */
export function ResolutionPopoverDialog({ path, blockId }: { path: string; blockId: number }): React.JSX.Element {
  const resolution = useAppStore((s) => s.conflictResolutions[path]);
  const original = useAppStore((s) => s.conflictOriginals[path]);
  const busy = useAppStore((s) => s.aiBusy);
  const block = resolution?.blocks.find((b) => b.id === blockId) ?? null;
  const parsedBlock = useMemo(() => (original !== undefined ? parseConflicts(original).blocks.find((b) => b.id === blockId) ?? null : null), [original, blockId]);

  if (!resolution || !block) {
    return (
      <Dialog title="Resolution details" onClose={closeDialog} footer={<Button onClick={closeDialog}>Close</Button>}>
        <Callout tone="warning">This block's resolution data is no longer available.</Callout>
      </Dialog>
    );
  }

  const apply = (side: 'ours' | 'theirs' | 'base') => void actions.useSideForBlock(path, blockId, side);

  return (
    <Dialog
      title={<span className="dialog-title-with-help"><span>Conflict {blockId} in {path}</span><HelpPopover title="Ours and theirs" explanation="Ours is the version from your current branch. Theirs is the incoming version from the branch or commit being merged." note="If neither side is clearly right, edit the file and keep only the intended result before marking the conflict resolved." /></span>}
      icon="sparkle"
      onClose={closeDialog}
      footer={
        <>
          <span className="left">
            <Button variant="ghost" icon="pencil" onClick={() => { closeDialog(); void actions.openInEditor(path); }}>Edit in editor</Button>
          </span>
          <Button onClick={closeDialog}>Accept</Button>
          <Button disabled={busy} onClick={() => apply('ours')}>Use ours</Button>
          <Button disabled={busy} onClick={() => apply('theirs')}>Use theirs</Button>
          {parsedBlock?.base ? <Button disabled={busy} onClick={() => apply('base')}>Use base</Button> : null}
        </>
      }
    >
      <div className="resolution-popover">
        <div className={`badge conf-${block.confidence}`}>{block.confidence} confidence</div>
        <p>{block.rationale || 'No rationale was given for this block.'}</p>
        {parsedBlock ? (
          <>
            <SideExcerpt label={`Ours (${parsedBlock.oursLabel})`} lines={parsedBlock.ours} />
            <SideExcerpt label={`Theirs (${parsedBlock.theirsLabel})`} lines={parsedBlock.theirs} />
            {parsedBlock.base ? <SideExcerpt label="Base (common ancestor)" lines={parsedBlock.base} /> : null}
          </>
        ) : (
          <Callout tone="info">The original conflicted text for this block is no longer available (it was only kept for the current session).</Callout>
        )}
      </div>
    </Dialog>
  );
}
