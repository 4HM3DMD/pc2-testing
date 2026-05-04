export class AccessEventEmitter {
    listeners = new Map();
    on(event, handler) {
        if (!this.listeners.has(event)) {
            this.listeners.set(event, new Set());
        }
        this.listeners.get(event).add(handler);
    }
    off(event, handler) {
        this.listeners.get(event)?.delete(handler);
    }
    emit(event, ...args) {
        const handlers = this.listeners.get(event);
        if (!handlers)
            return;
        for (const handler of handlers) {
            try {
                handler(...args);
            }
            catch {
            }
        }
    }
    removeAllListeners() {
        this.listeners.clear();
    }
}
//# sourceMappingURL=events.js.map