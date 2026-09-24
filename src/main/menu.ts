import { app, BrowserWindow, Menu, shell, type MenuItemConstructorOptions } from 'electron';
import { sendEvent } from './ipc';

const isMac = process.platform === 'darwin';

interface MenuOptions {
  showManagedServer?: boolean;
  onManagedServer?: () => void;
}

function action(label: string, id: string, accelerator?: string, args?: unknown): MenuItemConstructorOptions {
  return {
    label,
    accelerator,
    click: (_item, win) => {
      const target = (win instanceof BrowserWindow ? win : BrowserWindow.getAllWindows()[0]) ?? null;
      sendEvent(target, 'menu.action', { action: id, args });
    },
  };
}

export function buildMenu(getWindow: () => BrowserWindow | null, options: MenuOptions = {}): Menu {
  const template: MenuItemConstructorOptions[] = [];

  if (isMac) {
    template.push({
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        action('Settings…', 'settings', 'CmdOrCtrl+,'),
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
      action('New Repository…', 'new-repository', 'CmdOrCtrl+N'),
      { type: 'separator' },
      action('Add Local Repository…', 'add-local-repository', 'CmdOrCtrl+O'),
      action('Clone Repository…', 'clone-repository', 'CmdOrCtrl+Shift+O'),
      action('Rescan Watched Folders', 'scan-watched-folders'),
      { type: 'separator' },
      action('Export Settings…', 'export-settings'),
      action('Import Settings…', 'import-settings'),
      ...(options.showManagedServer ? [{ type: 'separator' as const }, { label: 'Run GitGood server in the background…', click: () => options.onManagedServer?.() }] : []),
      { type: 'separator' },
      ...(isMac ? [] : [action('Options…', 'settings', 'CmdOrCtrl+,'), { type: 'separator' } as MenuItemConstructorOptions]),
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
      action('Find', 'find', 'CmdOrCtrl+F'),
    ],
  });

  template.push({
    label: '&View',
    submenu: [
      action('Changes', 'show-changes', 'CmdOrCtrl+1'),
      action('History', 'show-history', 'CmdOrCtrl+2'),
      { type: 'separator' },
      action('Repository List', 'show-repository-list', 'CmdOrCtrl+T'),
      action('Branches List', 'show-branches-list', 'CmdOrCtrl+B'),
      action('Notifications Inbox', 'show-inbox', 'CmdOrCtrl+Shift+J'),
      { type: 'separator' },
      action('Go to Summary', 'focus-commit-summary', 'CmdOrCtrl+G'),
      action('Toggle Split Diff', 'toggle-split-diff', 'CmdOrCtrl+Shift+D'),
      action('Toggle Hide Whitespace', 'toggle-whitespace'),
      action('Toggle Blame', 'toggle-blame', 'Alt+B'),
      action('Search History for Selection', 'search-history-selection', 'CmdOrCtrl+Alt+F'),
      { type: 'separator' },
      { role: 'togglefullscreen' },
      action('Zoom In', 'zoom-in', 'CmdOrCtrl+='),
      action('Zoom Out', 'zoom-out', 'CmdOrCtrl+-'),
      action('Reset Zoom', 'zoom-reset', 'CmdOrCtrl+0'),
      { type: 'separator' },
      { role: 'reload' },
      { role: 'toggleDevTools', accelerator: isMac ? 'Alt+Command+I' : 'Ctrl+Shift+I' },
    ],
  });

  template.push({
    label: '&Repository',
    submenu: [
      action('Ask GitGood…', 'command-palette', 'CmdOrCtrl+K'),
      { type: 'separator' },
      action('Push', 'push', 'CmdOrCtrl+P'),
      action('Pull', 'pull', 'CmdOrCtrl+Shift+P'),
      action('Fetch', 'fetch', 'CmdOrCtrl+Shift+T'),
      action('Remove…', 'remove-repository', 'CmdOrCtrl+Delete'),
      { type: 'separator' },
      action('Stashes', 'show-stashes', 'CmdOrCtrl+Shift+S'),
      action('Worktrees…', 'show-worktrees', 'CmdOrCtrl+Shift+W'),
      action('Submodules…', 'show-submodules'),
      action('Git LFS…', 'show-lfs'),
      action('Repository Health…', 'show-health', 'CmdOrCtrl+Shift+K'),
      { type: 'separator' },
      action('View on GitHub', 'view-on-github', 'CmdOrCtrl+Shift+G'),
      action('Open in Terminal', 'open-in-shell', 'Ctrl+`'),
      action(process.platform === 'darwin' ? 'Show in Finder' : process.platform === 'win32' ? 'Show in Explorer' : 'Show in File Manager', 'show-in-folder', 'CmdOrCtrl+Shift+F'),
      action('Open in External Editor', 'open-in-editor', 'CmdOrCtrl+Shift+A'),
      { type: 'separator' },
      action('Issues…', 'show-issues', 'CmdOrCtrl+Shift+L'),
      action('Create Issue on GitHub', 'create-issue', 'CmdOrCtrl+I'),
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
      action('New Branch…', 'new-branch', 'CmdOrCtrl+Shift+N'),
      action('Rename…', 'rename-branch'),
      action('Delete…', 'delete-branch', 'CmdOrCtrl+Shift+Delete'),
      { type: 'separator' },
      action('Discard All Changes…', 'discard-all-changes', 'CmdOrCtrl+Shift+Backspace'),
      action('Stash All Changes', 'stash-all-changes'),
      { type: 'separator' },
      action('Update from Default Branch', 'update-from-default', 'CmdOrCtrl+Shift+U'),
      action('Compare to Branch', 'compare-branch', 'CmdOrCtrl+Shift+B'),
      action('Merge into Current Branch…', 'merge-branch', 'CmdOrCtrl+Shift+M'),
      action('Squash and Merge into Current Branch…', 'squash-merge-branch', 'CmdOrCtrl+Shift+H'),
      action('Rebase Current Branch…', 'rebase-branch', 'CmdOrCtrl+Shift+E'),
      { type: 'separator' },
      action('Compare on GitHub', 'compare-on-github', 'CmdOrCtrl+Shift+C'),
      action('View Pull Request on GitHub', 'view-pull-request'),
      action('Create Pull Request', 'create-pull-request', 'CmdOrCtrl+R'),
      { type: 'separator' },
      action('Review Branch with AI…', 'review-branch'),
      action('Review Pull Request with AI…', 'review-pull-request', 'CmdOrCtrl+Shift+R'),
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
      action('Keyboard Shortcuts', 'keyboard-shortcuts', 'CmdOrCtrl+/'),
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
