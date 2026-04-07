import { describe, it, expect } from 'vitest';
import { ConnectorEventLog } from '../../src/api/connector-event-log.js';

describe('ConnectorEventLog', () => {
  it('stores and retrieves events in reverse chronological order', () => {
    const log = new ConnectorEventLog();
    log.push({
      timestamp: '2026-04-07T10:00:00Z',
      source: 'slack',
      channel: '#proj',
      memoriesExtracted: 3,
    });
    log.push({
      timestamp: '2026-04-07T11:00:00Z',
      source: 'telegram',
      channel: 'bob',
      memoriesExtracted: 1,
    });

    const events = log.getRecent();
    expect(events).toHaveLength(2);
    expect(events[0].source).toBe('telegram'); // most recent first
    expect(events[1].source).toBe('slack');
  });

  it('respects limit parameter', () => {
    const log = new ConnectorEventLog();
    for (let i = 0; i < 10; i++) {
      log.push({
        timestamp: `2026-04-07T${i}:00:00Z`,
        source: 'slack',
        channel: '#ch',
        memoriesExtracted: i,
      });
    }

    const events = log.getRecent(3);
    expect(events).toHaveLength(3);
    expect(events[0].memoriesExtracted).toBe(9); // most recent
  });

  it('enforces maxSize ring buffer', () => {
    const log = new ConnectorEventLog(5);
    for (let i = 0; i < 10; i++) {
      log.push({
        timestamp: `2026-04-07T${i}:00:00Z`,
        source: 'slack',
        channel: '#ch',
        memoriesExtracted: i,
      });
    }

    const events = log.getRecent(10);
    expect(events).toHaveLength(5); // only 5 retained
    expect(events[0].memoriesExtracted).toBe(9); // most recent
    expect(events[4].memoriesExtracted).toBe(5); // oldest retained
  });

  it('computes stats correctly', () => {
    const log = new ConnectorEventLog();
    log.push({
      timestamp: '2026-04-07T10:00:00Z',
      source: 'slack',
      channel: '#a',
      memoriesExtracted: 3,
    });
    log.push({
      timestamp: '2026-04-07T11:00:00Z',
      source: 'telegram',
      channel: 'b',
      memoriesExtracted: 2,
    });
    log.push({
      timestamp: '2026-04-07T12:00:00Z',
      source: 'drive',
      channel: 'c',
      memoriesExtracted: 0,
      error: 'auth failed',
    });

    const stats = log.getStats();
    expect(stats.total).toBe(3);
    expect(stats.errors).toBe(1);
    expect(stats.totalMemories).toBe(5);
  });

  it('returns empty array when no events', () => {
    const log = new ConnectorEventLog();
    expect(log.getRecent()).toEqual([]);
    expect(log.getStats()).toEqual({ total: 0, errors: 0, totalMemories: 0 });
  });
});
