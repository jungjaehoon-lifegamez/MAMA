import { describe, it, expect } from 'vitest';
import {
  buildPipelineFallback,
  buildConnectorActivity,
  type ProjectSummary,
  type ConnectorActivityItem,
} from '../../src/api/intelligence-handler.js';

// ---------------------------------------------------------------------------
// buildPipelineFallback
// ---------------------------------------------------------------------------

describe('buildPipelineFallback', () => {
  it('returns projects sorted by lastActivity descending', () => {
    const projects: ProjectSummary[] = [
      { project: 'A', activeDecisions: 5, lastActivity: '2026-04-07T10:00:00Z' },
      { project: 'B', activeDecisions: 3, lastActivity: '2026-04-08T10:00:00Z' },
    ];
    const result = buildPipelineFallback(projects);
    expect(result[0].project).toBe('B');
    expect(result[1].project).toBe('A');
  });

  it('returns empty array when no projects', () => {
    expect(buildPipelineFallback([])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// buildConnectorActivity
// ---------------------------------------------------------------------------

describe('buildConnectorActivity', () => {
  it('picks latest item per connector', () => {
    const items: ConnectorActivityItem[] = [
      {
        connector: 'slack',
        summary: 'old msg',
        channel: '#general',
        timestamp: '2026-04-08T10:00:00Z',
      },
      {
        connector: 'slack',
        summary: 'new msg',
        channel: '#proj',
        timestamp: '2026-04-08T12:00:00Z',
      },
      {
        connector: 'calendar',
        summary: 'meeting',
        channel: 'personal',
        timestamp: '2026-04-08T11:00:00Z',
      },
    ];
    const result = buildConnectorActivity(items);
    expect(result).toHaveLength(2);
    expect(result.find((r) => r.connector === 'slack')?.summary).toBe('new msg');
    expect(result.find((r) => r.connector === 'calendar')?.summary).toBe('meeting');
  });

  it('returns empty array for no items', () => {
    expect(buildConnectorActivity([])).toEqual([]);
  });
});
