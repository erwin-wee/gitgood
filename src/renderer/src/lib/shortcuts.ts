import { matchesAccelerator, mergeShortcuts, type KeyLike } from '@shared/shortcuts';
import { isMac } from '../api';
import { store } from '../state/store';

/** True when the key press is the user's current binding for `id` (defaults + settings.shortcuts), for shortcuts the renderer handles itself. */
export function shortcutMatches(id: string, e: KeyLike): boolean {
  return matchesAccelerator(mergeShortcuts(store.get().settings?.shortcuts)[id], e, isMac);
}
