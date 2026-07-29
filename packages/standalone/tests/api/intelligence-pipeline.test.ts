import { describe, it, expect } from 'vitest';
import { buildPipelineFallback } from '../../src/api/intelligence-handler.js';

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
