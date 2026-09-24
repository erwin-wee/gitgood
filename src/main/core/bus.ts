import type { EventPayloads } from '@shared/ipc';

/** A backend event emitted to every subscribed transport (the Electron window, connected web sockets). */
export type EventListener = <K extends keyof EventPayloads>(event: K, payload: EventPayloads[K]) => void;

/**
 * The single fan-out point for server-push events. Replaces the old direct
 * `win.webContents.send`: the desktop app subscribes and forwards each event to
 * its window, and the server subscribes and broadcasts to connected clients.
 */
export class EventBus {
  private readonly listeners = new Set<EventListener>();
  emit = <K extends keyof EventPayloads>(event: K, payload: EventPayloads[K]): void => {
    for (const listener of this.listeners) listener(event, payload);
  };

  subscribe(listener: EventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}
