import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../src/shared/types';
import { buildPortablePreferences, buildPreferencesPatch, validateSettingsExport } from '../src/main/settings/sync-core';
import {
  acceleratorFromEvent,
  canonicalAccelerator,
  findConflict,
  formatAccelerator,
  isValidAccelerator,
  matchesAccelerator,
  mergeShortcuts,
  sanitizeShortcutOverrides,
  setShortcut,
  SHORTCUTS,
  type KeyLike,
} from '../src/shared/shortcuts';

const key = (code: string, mods: Partial<Omit<KeyLike, 'code'>> = {}): KeyLike => ({ code, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...mods });

describe('defaults and overrides', () => {
  it('ships valid, conflict-free defaults on every platform', () => {
    const defaults = mergeShortcuts();
    for (const isMac of [false, true]) {
      for (const def of SHORTCUTS) {
        expect(isValidAccelerator(def.accelerator), def.id).toBe(true);
        expect(findConflict(defaults, def.id, def.accelerator, isMac), `${def.id} (mac=${isMac})`).toBeNull();
      }
    }
  });

  it('applies overrides, unbinds on null and ignores unknown ids or invalid accelerators', () => {
    const merged = mergeShortcuts({ push: 'CmdOrCtrl+Alt+P', pull: null, nope: 'CmdOrCtrl+Q', fetch: 'banana', constructor: 'CmdOrCtrl+Q' });
    expect(merged.push).toBe('CmdOrCtrl+Alt+P');
    expect(merged.pull).toBeNull();
    expect(merged.fetch).toBe('CmdOrCtrl+Shift+T');
    expect(merged.nope).toBeUndefined();
    expect(merged['show-history']).toBe('CmdOrCtrl+2');
  });

  it('drops the override when an action is bound back to its default', () => {
    const changed = setShortcut({}, 'push', 'CmdOrCtrl+Alt+P');
    expect(changed).toEqual({ push: 'CmdOrCtrl+Alt+P' });
    expect(setShortcut(changed, 'push', 'CmdOrCtrl+P')).toEqual({});
    expect(setShortcut({}, 'push', null)).toEqual({ push: null });
  });

  it('sanitizes a hand-edited overrides object', () => {
    expect(sanitizeShortcutOverrides({ push: 'CmdOrCtrl+Alt+P', pull: 3, fetch: 'Shift+T', bogus: null })).toEqual({ push: 'CmdOrCtrl+Alt+P' });
    expect(sanitizeShortcutOverrides(['push'])).toEqual({});
    expect(sanitizeShortcutOverrides(null)).toEqual({});
  });
});

describe('conflict detection', () => {
  const defaults = mergeShortcuts();

  it('finds the action already holding an accelerator, however it is spelled', () => {
    expect(findConflict(defaults, 'fetch', 'CommandOrControl+P', false)).toEqual({ id: 'push', label: 'Push' });
    expect(findConflict(defaults, 'fetch', 'ctrl+p', false)?.id).toBe('push');
  });

  it('compares CmdOrCtrl with the literal platform modifier', () => {
    // Ctrl+` (open in terminal) is the same key as CmdOrCtrl+` on Linux/Windows, but not on macOS.
    expect(findConflict(defaults, 'push', 'CmdOrCtrl+`', false)?.id).toBe('open-in-shell');
    expect(findConflict(defaults, 'push', 'CmdOrCtrl+`', true)).toBeNull();
  });

  it('ignores the action itself and unbound actions', () => {
    expect(findConflict(defaults, 'push', 'CmdOrCtrl+P', false)).toBeNull();
    expect(findConflict({ ...defaults, push: null }, 'fetch', 'CmdOrCtrl+P', false)).toBeNull();
  });

  it('reports fixed menu items as non-rebindable', () => {
    expect(findConflict(defaults, 'push', 'CmdOrCtrl+C', false)).toEqual({ id: null, label: 'Copy' });
    expect(findConflict(defaults, 'push', 'CmdOrCtrl+Alt+N', true)?.id).toBeNull();
  });
});

describe('accelerators and key events', () => {
  it('records a key press as a portable accelerator', () => {
    expect(acceleratorFromEvent(key('KeyK', { ctrlKey: true }), false)).toBe('CmdOrCtrl+K');
    expect(acceleratorFromEvent(key('KeyK', { metaKey: true }), true)).toBe('CmdOrCtrl+K');
    expect(acceleratorFromEvent(key('KeyK', { ctrlKey: true, shiftKey: true, altKey: true }), false)).toBe('CmdOrCtrl+Alt+Shift+K');
    expect(acceleratorFromEvent(key('Backquote', { ctrlKey: true }), true)).toBe('Ctrl+`');
    expect(acceleratorFromEvent(key('F5'), false)).toBe('F5');
  });

  it('uses the physical key, so Shift or Option do not change which key was pressed', () => {
    expect(acceleratorFromEvent(key('Digit1', { ctrlKey: true, shiftKey: true }), false)).toBe('CmdOrCtrl+Shift+1');
    expect(acceleratorFromEvent(key('KeyB', { altKey: true }), true)).toBe('Alt+B');
  });

  it('refuses combinations that would swallow normal typing or are only modifiers', () => {
    expect(acceleratorFromEvent(key('KeyK'), false)).toBeNull();
    expect(acceleratorFromEvent(key('KeyK', { shiftKey: true }), false)).toBeNull();
    expect(acceleratorFromEvent(key('ControlLeft', { ctrlKey: true }), false)).toBeNull();
    expect(acceleratorFromEvent(key('Numpad5', { ctrlKey: true }), false)).toBeNull();
  });

  it('matches exactly the bound combination, with CmdOrCtrl resolved per platform', () => {
    expect(matchesAccelerator('CmdOrCtrl+1', key('Digit1', { ctrlKey: true }), false)).toBe(true);
    expect(matchesAccelerator('CmdOrCtrl+1', key('Digit1', { metaKey: true }), true)).toBe(true);
    expect(matchesAccelerator('CmdOrCtrl+1', key('Digit1', { ctrlKey: true }), true)).toBe(false);
    expect(matchesAccelerator('CmdOrCtrl+1', key('Digit1', { ctrlKey: true, shiftKey: true }), false)).toBe(false);
    expect(matchesAccelerator('CmdOrCtrl+Enter', key('Enter', { ctrlKey: true }), false)).toBe(true);
    expect(matchesAccelerator('CommandOrControl+Return', key('NumpadEnter', { ctrlKey: true }), false)).toBe(true);
    expect(matchesAccelerator('Alt+B', key('KeyB', { altKey: true }), true)).toBe(true);
    expect(matchesAccelerator(null, key('KeyB', { altKey: true }), true)).toBe(false);
  });

  it('rejects malformed accelerators', () => {
    for (const bad of ['', 'Ctrl+', 'Ctrl++K', 'K', 'Shift+K', 'Hyper+K', 'Ctrl+Banana']) expect(isValidAccelerator(bad), bad).toBe(false);
    expect(canonicalAccelerator('Shift+Ctrl+k', false)).toBe('Ctrl+Shift+K');
  });

  it('formats for display with the platform modifier', () => {
    expect(formatAccelerator('CmdOrCtrl+Shift+O', false)).toBe('Ctrl+Shift+O');
    expect(formatAccelerator('CmdOrCtrl+Shift+O', true)).toBe('⌘+Shift+O');
  });
});

describe('portable settings', () => {
  const withShortcuts = { ...DEFAULT_SETTINGS, shortcuts: { push: 'CmdOrCtrl+Alt+P', pull: null } };
  const importFile = (shortcuts: unknown) =>
    validateSettingsExport({ schema: 1, app: 'gitgood', version: '1', exportedAt: 'x', platform: 'linux', preferences: { shortcuts } });

  it('exports the overrides', () => {
    expect(buildPortablePreferences(withShortcuts).shortcuts).toEqual({ push: 'CmdOrCtrl+Alt+P', pull: null });
  });

  it('keeps valid overrides on import and warns about the rest', () => {
    const result = importFile({ push: 'CmdOrCtrl+Alt+P', fetch: 'nonsense', bogus: 'CmdOrCtrl+Q' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.preferences?.shortcuts).toEqual({ push: 'CmdOrCtrl+Alt+P' });
    expect(result.warnings.join('\n')).toMatch(/shortcuts/);
  });

  it('merge overlays per action; replace resets what the file omits', () => {
    const incoming = { shortcuts: { fetch: 'CmdOrCtrl+Alt+T' } };
    expect(buildPreferencesPatch(withShortcuts, incoming, 'merge').shortcuts).toEqual({ push: 'CmdOrCtrl+Alt+P', pull: null, fetch: 'CmdOrCtrl+Alt+T' });
    expect(buildPreferencesPatch(withShortcuts, incoming, 'replace').shortcuts).toEqual({ fetch: 'CmdOrCtrl+Alt+T' });
    expect(buildPreferencesPatch(withShortcuts, {}, 'replace').shortcuts).toEqual({});
    expect(buildPreferencesPatch(withShortcuts, {}, 'merge').shortcuts).toEqual({ push: 'CmdOrCtrl+Alt+P', pull: null });
  });
});
