import { describe, expect, it, vi } from 'vitest';
import { AgentEventBus } from '../../src/multi-agent/agent-event-bus.js';

describe('AgentEventBus', () => {
  it('emits and receives events', () => {
    const bus = new AgentEventBus();
    const handler = vi.fn();
    bus.on('memory:saved', handler);
    bus.emit({ type: 'memory:saved', topic: 'auth', project: 'MAMA' });
    expect(handler).toHaveBeenCalledWith({ type: 'memory:saved', topic: 'auth', project: 'MAMA' });
  });

  it('supports multiple listeners per event', () => {
    const bus = new AgentEventBus();
    const h1 = vi.fn();
    const h2 = vi.fn();
    bus.on('memory:saved', h1);
    bus.on('memory:saved', h2);
    bus.emit({ type: 'memory:saved', topic: 'db' });
    expect(h1).toHaveBeenCalled();
    expect(h2).toHaveBeenCalled();
  });

  it('does not call handlers for other event types', () => {
    const bus = new AgentEventBus();
    const handler = vi.fn();
    bus.on('wiki:compiled', handler);
    bus.emit({ type: 'memory:saved', topic: 'x' });
    expect(handler).not.toHaveBeenCalled();
  });

  it('off removes a listener', () => {
    const bus = new AgentEventBus();
    const handler = vi.fn();
    bus.on('memory:saved', handler);
    bus.off('memory:saved', handler);
    bus.emit({ type: 'memory:saved', topic: 'x' });
    expect(handler).not.toHaveBeenCalled();
  });

  it('debounced emit coalesces rapid events', async () => {
    const bus = new AgentEventBus();
    const handler = vi.fn();
    bus.on('memory:saved', handler);
    bus.emitDebounced({ type: 'memory:saved', topic: 'a' }, 50);
    bus.emitDebounced({ type: 'memory:saved', topic: 'b' }, 50);
    bus.emitDebounced({ type: 'memory:saved', topic: 'c' }, 50);
    expect(handler).not.toHaveBeenCalled();
    await new Promise((r) => setTimeout(r, 80));
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith({ type: 'memory:saved', topic: 'c' });
  });

  it('handles async listeners without blocking', async () => {
    const bus = new AgentEventBus();
    const order: string[] = [];
    bus.on('memory:saved', async () => {
      await new Promise((r) => setTimeout(r, 10));
      order.push('async');
    });
    bus.emit({ type: 'memory:saved', topic: 'x' });
    order.push('after-emit');
    expect(order).toEqual(['after-emit']);
    await new Promise((r) => setTimeout(r, 30));
    expect(order).toEqual(['after-emit', 'async']);
  });

  it('destroy clears all listeners and timers', () => {
    const bus = new AgentEventBus();
    const handler = vi.fn();
    bus.on('memory:saved', handler);
    bus.emitDebounced({ type: 'memory:saved', topic: 'x' }, 1000);
    bus.destroy();
    bus.emit({ type: 'memory:saved', topic: 'y' });
    expect(handler).not.toHaveBeenCalled();
  });
});
