/**
 * @elacity-js/access — Event emitter
 *
 * Lightweight typed event emitter for access lifecycle events.
 * Used by ElacityAccess to notify consumers of sign requests, errors, etc.
 */

import type { AccessEvent, AccessEventHandler } from './types.js';

export class AccessEventEmitter {
  private listeners = new Map<AccessEvent, Set<AccessEventHandler>>();

  on(event: AccessEvent, handler: AccessEventHandler): void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(handler);
  }

  off(event: AccessEvent, handler: AccessEventHandler): void {
    this.listeners.get(event)?.delete(handler);
  }

  emit(event: AccessEvent, ...args: unknown[]): void {
    const handlers = this.listeners.get(event);
    if (!handlers) return;
    for (const handler of handlers) {
      try {
        handler(...args);
      } catch {
        // Swallow listener errors to avoid breaking the access flow
      }
    }
  }

  removeAllListeners(): void {
    this.listeners.clear();
  }
}
