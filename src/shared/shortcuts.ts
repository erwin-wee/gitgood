/**
 * Keyboard shortcuts: the one list of actions and their default accelerators
 * (Electron accelerator syntax, `CmdOrCtrl` = Cmd on macOS / Ctrl elsewhere),
 * the merge with the user's overrides (`AppSettings.shortcuts`), conflict
 * detection, and the KeyboardEvent <-> accelerator conversions. The native menu
 * (src/main/menu.ts) and the renderer-handled shortcuts both read from here, so
 * a rebinding applies to both. Pure: no Electron, DOM or Node imports.
 */

export type ShortcutCategory = 'Navigation' | 'Editing' | 'AI' | 'Git ops' | 'View';
export const SHORTCUT_CATEGORIES: readonly ShortcutCategory[] = ['Navigation', 'Editing', 'AI', 'Git ops', 'View'];

/** `id` is the menu action id (`handleMenuAction`), except `commit`, which only the renderer handles. */
export interface ShortcutDef {
  id: string;
  label: string;
  category: ShortcutCategory;
  accelerator: string;
}

/** Overrides keyed by action id: an accelerator replaces the default, `null` unbinds. Absent = default. */
export type ShortcutOverrides = Record<string, string | null>;
export type ShortcutMap = Record<string, string | null>;

export const SHORTCUTS: readonly ShortcutDef[] = [
  { id: 'new-repository', label: 'New repository', category: 'Git ops', accelerator: 'CmdOrCtrl+N' },
  { id: 'add-local-repository', label: 'Add local repository', category: 'Git ops', accelerator: 'CmdOrCtrl+O' },
  { id: 'clone-repository', label: 'Clone repository', category: 'Git ops', accelerator: 'CmdOrCtrl+Shift+O' },
  { id: 'remove-repository', label: 'Remove repository', category: 'Git ops', accelerator: 'CmdOrCtrl+Delete' },
  { id: 'settings', label: 'Options', category: 'View', accelerator: 'CmdOrCtrl+,' },
  { id: 'keyboard-shortcuts', label: 'Keyboard shortcuts', category: 'View', accelerator: 'CmdOrCtrl+/' },
  { id: 'command-palette', label: 'Ask GitGood (command palette)', category: 'AI', accelerator: 'CmdOrCtrl+K' },
  { id: 'find', label: 'Find', category: 'Navigation', accelerator: 'CmdOrCtrl+F' },
  { id: 'show-changes', label: 'Show Changes', category: 'Navigation', accelerator: 'CmdOrCtrl+1' },
  { id: 'show-history', label: 'Show History', category: 'Navigation', accelerator: 'CmdOrCtrl+2' },
  { id: 'show-stashes', label: 'Show Stashes', category: 'Navigation', accelerator: 'CmdOrCtrl+Shift+S' },
  { id: 'show-worktrees', label: 'Worktrees', category: 'Navigation', accelerator: 'CmdOrCtrl+Shift+W' },
  { id: 'show-health', label: 'Repository health', category: 'Navigation', accelerator: 'CmdOrCtrl+Shift+K' },
  { id: 'show-issues', label: 'Issues', category: 'Navigation', accelerator: 'CmdOrCtrl+Shift+L' },
  { id: 'show-repository-list', label: 'Repository list', category: 'Navigation', accelerator: 'CmdOrCtrl+T' },
  { id: 'show-branches-list', label: 'Branch list', category: 'Navigation', accelerator: 'CmdOrCtrl+B' },
  { id: 'show-inbox', label: 'Notifications inbox', category: 'Navigation', accelerator: 'CmdOrCtrl+Shift+J' },
  { id: 'focus-commit-summary', label: 'Go to commit summary', category: 'Navigation', accelerator: 'CmdOrCtrl+G' },
  { id: 'search-history-selection', label: 'Search history for selection', category: 'Navigation', accelerator: 'CmdOrCtrl+Alt+F' },
  { id: 'open-in-shell', label: 'Open in terminal', category: 'Navigation', accelerator: 'Ctrl+`' },
  { id: 'show-in-folder', label: 'Show in folder', category: 'Navigation', accelerator: 'CmdOrCtrl+Shift+F' },
  { id: 'open-in-editor', label: 'Open in external editor', category: 'Navigation', accelerator: 'CmdOrCtrl+Shift+A' },
  { id: 'commit', label: 'Commit', category: 'Editing', accelerator: 'CmdOrCtrl+Enter' },
  { id: 'discard-all-changes', label: 'Discard all changes', category: 'Editing', accelerator: 'CmdOrCtrl+Shift+Backspace' },
  { id: 'toggle-split-diff', label: 'Toggle split diff', category: 'View', accelerator: 'CmdOrCtrl+Shift+D' },
  { id: 'toggle-blame', label: 'Toggle blame', category: 'View', accelerator: 'Alt+B' },
  { id: 'zoom-in', label: 'Zoom in', category: 'View', accelerator: 'CmdOrCtrl+=' },
  { id: 'zoom-out', label: 'Zoom out', category: 'View', accelerator: 'CmdOrCtrl+-' },
  { id: 'zoom-reset', label: 'Reset zoom', category: 'View', accelerator: 'CmdOrCtrl+0' },
  { id: 'push', label: 'Push', category: 'Git ops', accelerator: 'CmdOrCtrl+P' },
  { id: 'pull', label: 'Pull', category: 'Git ops', accelerator: 'CmdOrCtrl+Shift+P' },
  { id: 'fetch', label: 'Fetch', category: 'Git ops', accelerator: 'CmdOrCtrl+Shift+T' },
  { id: 'new-branch', label: 'New branch', category: 'Git ops', accelerator: 'CmdOrCtrl+Shift+N' },
  { id: 'delete-branch', label: 'Delete branch', category: 'Git ops', accelerator: 'CmdOrCtrl+Shift+Delete' },
  { id: 'merge-branch', label: 'Merge into current branch', category: 'Git ops', accelerator: 'CmdOrCtrl+Shift+M' },
  { id: 'squash-merge-branch', label: 'Squash and merge into current branch', category: 'Git ops', accelerator: 'CmdOrCtrl+Shift+H' },
  { id: 'rebase-branch', label: 'Rebase current branch', category: 'Git ops', accelerator: 'CmdOrCtrl+Shift+E' },
  { id: 'update-from-default', label: 'Update from default branch', category: 'Git ops', accelerator: 'CmdOrCtrl+Shift+U' },
  { id: 'compare-branch', label: 'Compare to branch', category: 'Git ops', accelerator: 'CmdOrCtrl+Shift+B' },
  { id: 'compare-on-github', label: 'Compare on GitHub', category: 'Git ops', accelerator: 'CmdOrCtrl+Shift+C' },
  { id: 'create-pull-request', label: 'Create pull request', category: 'Git ops', accelerator: 'CmdOrCtrl+R' },
  { id: 'review-pull-request', label: 'Review pull request with AI', category: 'AI', accelerator: 'CmdOrCtrl+Shift+R' },
  { id: 'view-on-github', label: 'View on GitHub', category: 'Git ops', accelerator: 'CmdOrCtrl+Shift+G' },
  { id: 'create-issue', label: 'Create issue on GitHub', category: 'Git ops', accelerator: 'CmdOrCtrl+I' },
];

/** Accelerators the native menu's built-in items own (edit roles, DevTools, fullscreen); not rebindable, so no action may take them. */
const FIXED: readonly { accelerator: string; label: string }[] = [
  { accelerator: 'CmdOrCtrl+Z', label: 'Undo' },
  { accelerator: 'CmdOrCtrl+Shift+Z', label: 'Redo' },
  { accelerator: 'CmdOrCtrl+X', label: 'Cut' },
  { accelerator: 'CmdOrCtrl+C', label: 'Copy' },
  { accelerator: 'CmdOrCtrl+V', label: 'Paste' },
  { accelerator: 'CmdOrCtrl+A', label: 'Select all' },
  { accelerator: 'CmdOrCtrl+Shift+I', label: 'Toggle developer tools' },
  { accelerator: 'F11', label: 'Toggle full screen' },
  { accelerator: 'CmdOrCtrl+Alt+N', label: 'New window' },
];

// ---------------------------------------------------------------------------
// Accelerator parsing
// ---------------------------------------------------------------------------

type Mod = 'CmdOrCtrl' | 'Ctrl' | 'Alt' | 'Shift' | 'Meta';
/** Display / storage order of modifiers. */
const MOD_ORDER: readonly Mod[] = ['CmdOrCtrl', 'Ctrl', 'Alt', 'Shift', 'Meta'];
const MODS: Record<string, Mod> = {
  cmdorctrl: 'CmdOrCtrl',
  commandorcontrol: 'CmdOrCtrl',
  ctrl: 'Ctrl',
  control: 'Ctrl',
  alt: 'Alt',
  option: 'Alt',
  shift: 'Shift',
  cmd: 'Meta',
  command: 'Meta',
  super: 'Meta',
  meta: 'Meta',
};
const PUNCTUATION = '`-=[]\\;\',./';
const NAMED_KEYS = ['Space', 'Tab', 'Backspace', 'Delete', 'Insert', 'Enter', 'Up', 'Down', 'Left', 'Right', 'Home', 'End', 'PageUp', 'PageDown', 'Escape'];
const KEY_ALIASES: Record<string, string> = { return: 'Enter', esc: 'Escape' };

interface Parsed {
  mods: Set<Mod>;
  key: string;
}

function normalizeKey(raw: string): string | null {
  if (/^[a-z0-9]$/i.test(raw)) return raw.toUpperCase();
  if (/^f([1-9]|1\d|2[0-4])$/i.test(raw)) return raw.toUpperCase();
  if (raw.length === 1 && PUNCTUATION.includes(raw)) return raw;
  const lower = raw.toLowerCase();
  const wanted = Object.hasOwn(KEY_ALIASES, lower) ? KEY_ALIASES[lower] : lower;
  return NAMED_KEYS.find((k) => k.toLowerCase() === wanted.toLowerCase()) ?? null;
}

/** Null when `accelerator` is not one Electron accepts AND we can match: modifiers then one key; needs a non-Shift modifier unless it is a function key. */
function parse(accelerator: string): Parsed | null {
  const parts = accelerator.split('+');
  const key = normalizeKey(parts.pop() ?? '');
  if (!key) return null;
  const mods = new Set<Mod>();
  for (const part of parts) {
    const mod = Object.hasOwn(MODS, part.toLowerCase()) ? MODS[part.toLowerCase()] : undefined;
    if (!mod) return null;
    mods.add(mod);
  }
  if (!/^F\d+$/.test(key) && ![...mods].some((m) => m !== 'Shift')) return null;
  return { mods, key };
}

export function isValidAccelerator(accelerator: unknown): accelerator is string {
  return typeof accelerator === 'string' && parse(accelerator) !== null;
}

/** Platform-resolved comparison form: `CmdOrCtrl` becomes Cmd (Meta) on macOS and Ctrl elsewhere. Null for an invalid accelerator. */
export function canonicalAccelerator(accelerator: string, isMac: boolean): string | null {
  const parsed = parse(accelerator);
  if (!parsed) return null;
  const mods = new Set<Mod>([...parsed.mods].map((m) => (m === 'CmdOrCtrl' ? (isMac ? 'Meta' : 'Ctrl') : m)));
  return [...MOD_ORDER.filter((m) => mods.has(m)), parsed.key].join('+');
}

/** How an accelerator reads in the UI: `CmdOrCtrl` as the platform's modifier (⌘ / Ctrl). */
export function formatAccelerator(accelerator: string, isMac: boolean): string {
  const parsed = parse(accelerator);
  if (!parsed) return accelerator;
  const label: Record<Mod, string> = { CmdOrCtrl: isMac ? '⌘' : 'Ctrl', Ctrl: isMac ? '⌃' : 'Ctrl', Alt: 'Alt', Shift: 'Shift', Meta: isMac ? '⌘' : 'Super' };
  return [...MOD_ORDER.filter((m) => parsed.mods.has(m)).map((m) => label[m]), parsed.key].join('+');
}

// ---------------------------------------------------------------------------
// KeyboardEvent <-> accelerator
// ---------------------------------------------------------------------------

/** The part of a KeyboardEvent we read; `code` (physical key) keeps Shift/Option from changing the key's identity. */
export interface KeyLike {
  code: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

const CODE_KEYS: Record<string, string> = {
  Backquote: '`',
  Minus: '-',
  Equal: '=',
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Semicolon: ';',
  Quote: "'",
  Comma: ',',
  Period: '.',
  Slash: '/',
  Space: 'Space',
  Tab: 'Tab',
  Backspace: 'Backspace',
  Delete: 'Delete',
  Insert: 'Insert',
  Enter: 'Enter',
  NumpadEnter: 'Enter',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  Escape: 'Escape',
};

/** The accelerator key for an event's physical key; null for modifier-only presses and keys we cannot bind. */
function eventKey(code: string): string | null {
  const m = /^(?:Key([A-Z])|Digit(\d)|(F(?:[1-9]|1\d|2[0-4])))$/.exec(code);
  if (m) return m[1] ?? m[2] ?? m[3];
  return Object.hasOwn(CODE_KEYS, code) ? CODE_KEYS[code] : null;
}

/** What a key press means as a stored accelerator (`CmdOrCtrl` for this platform's primary modifier); null if it is not a bindable combination. */
export function acceleratorFromEvent(e: KeyLike, isMac: boolean): string | null {
  const key = eventKey(e.code);
  if (!key) return null;
  const primary = isMac ? e.metaKey : e.ctrlKey;
  const mods = [primary && 'CmdOrCtrl', (isMac ? e.ctrlKey : e.metaKey) && (isMac ? 'Ctrl' : 'Meta'), e.altKey && 'Alt', e.shiftKey && 'Shift'].filter(Boolean);
  const accelerator = [...mods, key].join('+');
  return isValidAccelerator(accelerator) ? accelerator : null;
}

/** True when the key press is exactly `accelerator` (modifiers included); the renderer's counterpart of a menu accelerator. */
export function matchesAccelerator(accelerator: string | null | undefined, e: KeyLike, isMac: boolean): boolean {
  if (!accelerator) return false;
  const pressed = acceleratorFromEvent(e, isMac);
  return pressed !== null && canonicalAccelerator(pressed, isMac) === canonicalAccelerator(accelerator, isMac);
}

// ---------------------------------------------------------------------------
// Defaults + overrides
// ---------------------------------------------------------------------------

const DEFAULTS: Record<string, string> = Object.fromEntries(SHORTCUTS.map((d) => [d.id, d.accelerator]));

/** Keeps only known action ids whose value is null or a valid accelerator (settings files and imports are hand-editable). */
export function sanitizeShortcutOverrides(raw: unknown): ShortcutOverrides {
  const out: ShortcutOverrides = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [id, value] of Object.entries(raw)) {
    if (Object.hasOwn(DEFAULTS, id) && (value === null || isValidAccelerator(value))) out[id] = value;
  }
  return out;
}

/** The accelerator in force for every action: its default unless overridden (null = unbound). */
export function mergeShortcuts(overrides?: unknown): ShortcutMap {
  const valid = sanitizeShortcutOverrides(overrides);
  return Object.fromEntries(SHORTCUTS.map((d) => [d.id, Object.hasOwn(valid, d.id) ? valid[d.id] : d.accelerator]));
}

/** Overrides after binding `id` to `accelerator` (null unbinds); binding the default drops the override. */
export function setShortcut(overrides: ShortcutOverrides, id: string, accelerator: string | null): ShortcutOverrides {
  const next = { ...overrides };
  if (accelerator === DEFAULTS[id]) delete next[id];
  else next[id] = accelerator;
  return next;
}

export interface ShortcutConflict {
  /** The action holding the accelerator; null for a fixed menu item that cannot be unbound. */
  id: string | null;
  label: string;
}

/** The action (or fixed menu item) that already uses `accelerator`, ignoring `id` itself; null when it is free. */
export function findConflict(shortcuts: ShortcutMap, id: string, accelerator: string, isMac: boolean): ShortcutConflict | null {
  const wanted = canonicalAccelerator(accelerator, isMac);
  if (!wanted) return null;
  for (const def of SHORTCUTS) {
    const other = shortcuts[def.id];
    if (def.id !== id && other && canonicalAccelerator(other, isMac) === wanted) return { id: def.id, label: def.label };
  }
  const fixed = FIXED.find((f) => canonicalAccelerator(f.accelerator, isMac) === wanted);
  return fixed ? { id: null, label: fixed.label } : null;
}
