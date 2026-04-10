import { describe, it, expect } from 'vitest';
import { AgentEventBus } from '../../src/multi-agent/agent-event-bus.js';

describe('AgentEventBus notices', () => {
  it('stores agent:action events in notices buffer', () => {
    const bus = new AgentEventBus();
    bus.emit({
      type: 'agent:action',
      agent: 'wiki',
      action: 'edited',
      target: 'projects/ProjectAlpha.md',
    });
    const notices = bus.getRecentNotices(10);
    expect(notices).toHaveLength(1);
    expect(notices[0].agent).toBe('wiki');
    expect(notices[0].action).toBe('edited');
    expect(notices[0].target).toBe('projects/ProjectAlpha.md');
    expect(notices[0].timestamp).toBeGreaterThan(0);
    bus.destroy();
  });

  it('limits notices to 50 (ring buffer)', () => {
    const bus = new AgentEventBus();
    for (let i = 0; i < 60; i++) {
      bus.emit({ type: 'agent:action', agent: 'test', action: `action-${i}`, target: `t-${i}` });
    }
    const notices = bus.getRecentNotices(100);
    expect(notices).toHaveLength(50);
    expect(notices[0].action).toBe('action-59');
    bus.destroy();
  });

  it('getRecentNotices respects limit param', () => {
    const bus = new AgentEventBus();
    for (let i = 0; i < 10; i++) {
      bus.emit({ type: 'agent:action', agent: 'test', action: `a-${i}`, target: `t-${i}` });
    }
    const notices = bus.getRecentNotices(3);
    expect(notices).toHaveLength(3);
    bus.destroy();
  });

  it('does not store non-action events in notices', () => {
    const bus = new AgentEventBus();
    bus.emit({ type: 'memory:saved', topic: 'test', project: 'p' });
    bus.emit({ type: 'dashboard:refresh' });
    expect(bus.getRecentNotices(10)).toHaveLength(0);
    bus.destroy();
  });
});
