import type { EventName } from '@shared/ipc';

/** The client id of a desktop window: one per `webContents`, stable for the window's lifetime. */
export function windowClientId(webContentsId: number): string {
  return `window-${webContentsId}`;
}

/** Events that belong to the call that caused them (progress, AI streams, the GitHub sign-in flow): only the calling window gets them. Every other event is app-wide. */
const CALLER_EVENTS: Partial<Record<EventName, true>> = {
  progress: true,
  'ai.progress': true,
  'ai.review.progress': true,
  'ai.triage.progress': true,
  'ai.split.progress': true,
  'ai.rebase.progress': true,
  'ai.nl.progress': true,
  'gh.auth.code': true,
  'gh.auth.finished': true,
};

/**
 * Which desktop windows receive an event.
 * - `repo.changed` goes to the windows that have that repository open (`watchersOf`).
 * - Caller events go to the window whose call emitted them (`caller`, from `currentClient()`); with no calling window (empty id) they fall back to everyone.
 * - Anything else (repository list, settings, tools, inbox, updates, …) goes to every window.
 */
export function windowsFor<W extends { clientId: string }>(event: EventName, payload: unknown, caller: string, windows: W[], watchersOf: (repoPath: string) => string[]): W[] {
  if (event === 'repo.changed') {
    const owners = payload !== null && typeof payload === 'object' && 'repoPath' in payload && typeof payload.repoPath === 'string' ? watchersOf(payload.repoPath) : [];
    return windows.filter((w) => owners.includes(w.clientId));
  }
  if (CALLER_EVENTS[event] && caller) return windows.filter((w) => w.clientId === caller);
  return windows;
}
