import React from 'react';
import { Button, Callout, Dialog } from '../ui';

/**
 * One-time, per-repository trust confirmation for a post-resolution check
 * command declared in that repository's `.gitgood/config.json`. Shown
 * verbatim before the first run; declining disables the repository command
 * for this repository until re-enabled (Options → AI or here again later).
 */
export function TrustRepoCheckDialog({ repoPath, command, onDecision }: { repoPath: string; command: string; onDecision: (trusted: boolean) => void }): React.JSX.Element {
  return (
    <Dialog
      title="Trust this repository's check command?"
      icon="alert"
      onClose={() => onDecision(false)}
      footer={
        <>
          <Button onClick={() => onDecision(false)}>Don't run it</Button>
          <Button variant="primary" onClick={() => onDecision(true)}>Trust and run</Button>
        </>
      }
    >
      <p>
        This repository provides a command to run after each AI conflict resolution, from <span className="mono">.gitgood/config.json</span> in:
      </p>
      <pre className="details-block mono">{repoPath}</pre>
      <p>The command will run in this repository, with your shell:</p>
      <pre className="details-block mono">{command}</pre>
      <Callout tone="warning">Only trust this if you trust the repository's contents. Declining uses your own Options → AI check command (if any) instead, and never runs this one until you trust it.</Callout>
    </Dialog>
  );
}
