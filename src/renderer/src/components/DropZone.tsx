import React, { useEffect, useState } from 'react';
import * as actions from '../state/actions';
import { showToast } from '../state/store';
import { Icon } from './ui';

/**
 * Desktop only: dropping folders anywhere on the window adds them as repositories (the last one is opened;
 * a folder that is not a repository opens the Add dialog, see `openFolderAsRepository`). The preload only
 * exposes `getPathForFile` for the local desktop app, so web tabs and desktop client mode render nothing:
 * there, a dropped path would be on the wrong machine.
 */
export function DropZone(): React.JSX.Element | null {
  const getPath = window.gitgoodBridge.getPathForFile;
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    if (!getPath) return;
    let depth = 0;
    const hasFiles = (e: DragEvent) => !!e.dataTransfer?.types.includes('Files');
    const onEnter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth++;
      setDragging(true);
    };
    const onOver = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault(); // required for the drop event to fire
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    };
    const onLeave = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) setDragging(false);
    };
    const onDrop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      setDragging(false);
      // DataTransfer items are only readable synchronously inside the event.
      const paths: string[] = [];
      for (const item of Array.from(e.dataTransfer?.items ?? [])) {
        const file = item.getAsFile();
        if (file && item.webkitGetAsEntry()?.isDirectory) paths.push(getPath(file));
      }
      if (!paths.length) {
        showToast({ kind: 'info', title: 'Drop a folder', message: 'Drag a repository folder onto the window to add it.' });
        return;
      }
      void (async () => {
        for (const path of paths) await actions.openFolderAsRepository({ path });
      })();
    };
    window.addEventListener('dragenter', onEnter);
    window.addEventListener('dragover', onOver);
    window.addEventListener('dragleave', onLeave);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragenter', onEnter);
      window.removeEventListener('dragover', onOver);
      window.removeEventListener('dragleave', onLeave);
      window.removeEventListener('drop', onDrop);
    };
  }, [getPath]);

  if (!dragging) return null;
  return (
    <div className="drop-overlay" role="presentation">
      <div className="drop-overlay-card">
        <Icon name="folder" size={32} />
        <h2>Drop a folder to add it</h2>
        <p>Repositories are added to GitGood and opened.</p>
      </div>
    </div>
  );
}
