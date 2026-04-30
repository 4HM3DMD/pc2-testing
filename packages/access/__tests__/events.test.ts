import { describe, it, expect, vi } from 'vitest';
import { AccessEventEmitter } from '../src/events.js';

describe('AccessEventEmitter', () => {
  it('calls registered handler when event is emitted', () => {
    const emitter = new AccessEventEmitter();
    const handler = vi.fn();

    emitter.on('sign_request', handler);
    emitter.emit('sign_request');

    expect(handler).toHaveBeenCalledOnce();
  });

  it('passes arguments to handler', () => {
    const emitter = new AccessEventEmitter();
    const handler = vi.fn();

    emitter.on('sign_error', handler);
    emitter.emit('sign_error', new Error('test'), 'extra');

    expect(handler).toHaveBeenCalledWith(expect.any(Error), 'extra');
  });

  it('supports multiple handlers for the same event', () => {
    const emitter = new AccessEventEmitter();
    const handler1 = vi.fn();
    const handler2 = vi.fn();

    emitter.on('connected', handler1);
    emitter.on('connected', handler2);
    emitter.emit('connected');

    expect(handler1).toHaveBeenCalledOnce();
    expect(handler2).toHaveBeenCalledOnce();
  });

  it('does not call handler after off()', () => {
    const emitter = new AccessEventEmitter();
    const handler = vi.fn();

    emitter.on('sign_request', handler);
    emitter.off('sign_request', handler);
    emitter.emit('sign_request');

    expect(handler).not.toHaveBeenCalled();
  });

  it('does not throw when emitting with no listeners', () => {
    const emitter = new AccessEventEmitter();
    expect(() => emitter.emit('disconnected')).not.toThrow();
  });

  it('swallows handler errors without breaking other handlers', () => {
    const emitter = new AccessEventEmitter();
    const throwing = vi.fn(() => { throw new Error('boom'); });
    const surviving = vi.fn();

    emitter.on('sign_request', throwing);
    emitter.on('sign_request', surviving);
    emitter.emit('sign_request');

    expect(throwing).toHaveBeenCalledOnce();
    expect(surviving).toHaveBeenCalledOnce();
  });

  it('removeAllListeners clears everything', () => {
    const emitter = new AccessEventEmitter();
    const handler = vi.fn();

    emitter.on('sign_request', handler);
    emitter.on('sign_error', handler);
    emitter.removeAllListeners();

    emitter.emit('sign_request');
    emitter.emit('sign_error');

    expect(handler).not.toHaveBeenCalled();
  });

  it('does not duplicate handlers registered multiple times', () => {
    const emitter = new AccessEventEmitter();
    const handler = vi.fn();

    emitter.on('connected', handler);
    emitter.on('connected', handler);
    emitter.emit('connected');

    expect(handler).toHaveBeenCalledOnce();
  });
});
