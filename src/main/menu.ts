import { app, BrowserWindow, Menu, shell, type MenuItemConstructorOptions } from 'electron';
import { mergeShortcuts, type ShortcutOverrides } from '@shared/shortcuts';
import { sendEvent } from './ipc';

const isMac = process.platform === 'darwin';

interface MenuOptions {
  showManagedServer?: boolean;
  onManagedServer?: () => void;
  /** Present only when the app can open extra windows (local mode); adds File → New Window. */
  onNewWindow?: () => void;
  /** `AppSettings.shortcuts`: per-action accelerator overrides on top of the defaults. */
  shortcuts?: ShortcutOverrides;
}

export function buildMenu(getWindow: () => BrowserWindow | null, options: MenuOptions = {}): Menu {
  const template: MenuItemConstructorOptions[] = [];
  const accelerators = mergeShortcuts(options.shortcuts);
  const action = (label: string, id: string): MenuItemConstructorOptions => ({
    label,
    accelerator: accelerators[id] ?? undefined,
    click: (_item, win) => {
      const target = (win instanceof BrowserWindow ? win : BrowserWindow.getAllWindows()[0]) ?? null;
      sendEvent(target, 'menu.action', { action: id });
    },
  });

  if (isMac) {
    template.push({
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        action('Settings…', 'settings'),
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    });
  }

  template.push({
    label: '&File',
    submenu: [
      action('New Repository…', 'new-repository'),
      ...(options.onNewWindow ? [{ label: 'New Window', accelerator: 'CmdOrCtrl+Alt+N', click: () => options.onNewWindow?.() }] : []),
      { type: 'separator' },
      action('Add Local Repository…', 'add-local-repository'),
      action('Clone Repository…', 'clone-repository'),
      action('Rescan Watched Folders', 'scan-watched-folders'),
      { type: 'separator' },
      action('Export Settings…', 'export-settings'),
      action('Import Settings…', 'import-settings'),
      ...(options.showManagedServer ? [{ type: 'separator' as const }, { label: 'Run GitGood server in the background…', click: () => options.onManagedServer?.() }] : []),
      { type: 'separator' },
      ...(isMac ? [] : [action('Options…', 'settings'), { type: 'separator' } as MenuItemConstructorOptions]),
      isMac ? { role: 'close' } : { role: 'quit', label: 'E&xit' },
    ],
  });

  template.push({
    label: '&Edit',
    submenu: [
      { role: 'undo' },
      { role: 'redo' },
      { type: 'separator' },
      { role: 'cut' },
      { role: 'copy' },
      { role: 'paste' },
      { role: 'selectAll' },
      { type: 'separator' },
      action('Find', 'find'),
    ],
  });

  template.push({
    label: '&View',
    submenu: [
      action('Changes', 'show-changes'),
      action('History', 'show-history'),
      { type: 'separator' },
      action('Repository List', 'show-repository-list'),
      action('Branches List', 'show-branches-list'),
      action('Notifications Inbox', 'show-inbox'),
      { type: 'separator' },
      action('Go to Summary', 'focus-commit-summary'),
      action('Toggle Split Diff', 'toggle-split-diff'),
      action('Toggle Hide Whitespace', 'toggle-whitespace'),
      action('Toggle Blame', 'toggle-blame'),
      action('Toggle History Graph', 'toggle-history-graph'),
      action('Search History for Selection', 'search-history-selection'),
      { type: 'separator' },
      { role: 'togglefullscreen' },
      action('Zoom In', 'zoom-in'),
      action('Zoom Out', 'zoom-out'),
      action('Reset Zoom', 'zoom-reset'),
      { type: 'separator' },
      { role: 'reload' },
      { role: 'toggleDevTools', accelerator: isMac ? 'Alt+Command+I' : 'Ctrl+Shift+I' },
    ],
  });

  template.push({
    label: '&Repository',
    submenu: [
      action('Ask GitGood…', 'command-palette'),
      { type: 'separator' },
      action('Push', 'push'),
      action('Pull', 'pull'),
      action('Fetch', 'fetch'),
      action('Remove…', 'remove-repository'),
      { type: 'separator' },
      action('Stashes', 'show-stashes'),
      action('Worktrees…', 'show-worktrees'),
      action('Submodules…', 'show-submodules'),
      action('Git LFS…', 'show-lfs'),
      action('Repository Health…', 'show-health'),
      action('Undo History…', 'show-reflog'),
      action('Undo Last Git Operation', 'undo-last-operation'),
      { type: 'separator' },
      action('View on GitHub', 'view-on-github'),
      action('Open in Terminal', 'open-in-shell'),
      action(process.platform === 'darwin' ? 'Show in Finder' : process.platform === 'win32' ? 'Show in Explorer' : 'Show in File Manager', 'show-in-folder'),
      action('Open in External Editor', 'open-in-editor'),
      { type: 'separator' },
      action('Issues…', 'show-issues'),
      action('Create Issue on GitHub', 'create-issue'),
      { type: 'separator' },
      action('Release Notes…', 'release-notes'),
      action('Split into Commits with AI…', 'split-commits'),
      { type: 'separator' },
      action('Repository Settings…', 'repository-settings'),
    ],
  });

  template.push({
    label: '&Branch',
    submenu: [
      action('New Branch…', 'new-branch'),
      action('Rename…', 'rename-branch'),
      action('Delete…', 'delete-branch'),
      { type: 'separator' },
      action('Discard All Changes…', 'discard-all-changes'),
      action('Stash All Changes', 'stash-all-changes'),
      { type: 'separator' },
      action('Update from Default Branch', 'update-from-default'),
      action('Compare to Branch', 'compare-branch'),
      action('Merge into Current Branch…', 'merge-branch'),
      action('Squash and Merge into Current Branch…', 'squash-merge-branch'),
      action('Rebase Current Branch…', 'rebase-branch'),
      { type: 'separator' },
      action('Compare on GitHub', 'compare-on-github'),
      action('View Pull Request on GitHub', 'view-pull-request'),
      action('Create Pull Request', 'create-pull-request'),
      { type: 'separator' },
      action('Review Branch with AI…', 'review-branch'),
      action('Review Pull Request with AI…', 'review-pull-request'),
      action('Draft Pull Request with AI…', 'draft-pull-request-ai'),
      action('Tidy Up Branch with AI…', 'tidy-branch-ai'),
    ],
  });

  if (isMac) {
    template.push({ role: 'window', submenu: [{ role: 'minimize' }, { role: 'zoom' }, { type: 'separator' }, { role: 'front' }] });
  }

  template.push({
    role: 'help',
    submenu: [
      action('Keyboard Shortcuts', 'keyboard-shortcuts'),
      action('Show Logs', 'show-logs'),
      { type: 'separator' },
      action('Check for Updates…', 'check-for-updates'),
      { type: 'separator' },
      { label: 'GitHub CLI Documentation', click: () => void shell.openExternal('https://cli.github.com/manual/') },
      { label: 'Report an Issue', click: () => void shell.openExternal('https://github.com/erwin-wee/gitgood/issues') },
      { type: 'separator' },
      action('About GitGood', 'about'),
    ],
  });

  void getWindow;
  return Menu.buildFromTemplate(template);
}

let installed: { getWindow: () => BrowserWindow | null; options: MenuOptions } | null = null;

/** Sets the application menu and remembers how, so a shortcut change can rebuild it. */
export function installMenu(getWindow: () => BrowserWindow | null, options: MenuOptions = {}): void {
  installed = { getWindow, options };
  Menu.setApplicationMenu(buildMenu(getWindow, options));
}

/** Rebuilds the installed menu with new shortcut overrides (no-op until `installMenu` ran or when nothing changed). */
export function refreshMenuShortcuts(shortcuts: ShortcutOverrides): void {
  if (!installed || JSON.stringify(mergeShortcuts(installed.options.shortcuts)) === JSON.stringify(mergeShortcuts(shortcuts))) return;
  installMenu(installed.getWindow, { ...installed.options, shortcuts });
}
