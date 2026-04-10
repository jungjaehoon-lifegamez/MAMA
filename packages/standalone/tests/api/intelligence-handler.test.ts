import { describe, it, expect } from 'vitest';
import {
  buildAlertsFromDecisions,
  buildActivityFeed,
  buildProjectsSummary,
  type DecisionForAlerts,
  type ActivityItem,
  type ProjectSummary,
} from '../../src/api/intelligence-handler.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function daysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString();
}

// ---------------------------------------------------------------------------
// buildAlertsFromDecisions
// ---------------------------------------------------------------------------

describe('buildAlertsFromDecisions', () => {
  it('returns empty array when no decisions', () => {
    expect(buildAlertsFromDecisions([])).toEqual([]);
  });

  it('ignores non-active decisions', () => {
    const decisions: DecisionForAlerts[] = [
      {
        id: 1,
        topic: 'old',
        decision: 'something',
        updated_at: daysAgo(30),
        status: 'superseded',
        confidence: 0.1,
      },
    ];
    expect(buildAlertsFromDecisions(decisions)).toHaveLength(0);
  });

  it('flags stale decision (> 14 days) as medium severity', () => {
    const decisions: DecisionForAlerts[] = [
      {
        id: 2,
        topic: 'stale-topic',
        decision: 'd',
        updated_at: daysAgo(20),
        status: 'active',
        confidence: 0.9,
      },
    ];
    const alerts = buildAlertsFromDecisions(decisions);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].kind).toBe('stale');
    expect(alerts[0].severity).toBe('medium');
    expect(alerts[0].topic).toBe('stale-topic');
  });

  it('flags very stale decision (> 30 days) as high severity', () => {
    const decisions: DecisionForAlerts[] = [
      {
        id: 3,
        topic: 'very-stale',
        decision: 'd',
        updated_at: daysAgo(45),
        status: 'active',
        confidence: 0.9,
      },
    ];
    const alerts = buildAlertsFromDecisions(decisions);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].kind).toBe('stale');
    expect(alerts[0].severity).toBe('high');
  });

  it('does not flag decisions updated within 14 days', () => {
    const decisions: DecisionForAlerts[] = [
      {
        id: 4,
        topic: 'fresh',
        decision: 'd',
        updated_at: daysAgo(5),
        status: 'active',
        confidence: 0.9,
      },
    ];
    expect(buildAlertsFromDecisions(decisions)).toHaveLength(0);
  });

  it('flags low_confidence decision (< 0.4) as low severity when confidence >= 0.2', () => {
    const decisions: DecisionForAlerts[] = [
      {
        id: 5,
        topic: 'low-conf',
        decision: 'd',
        updated_at: daysAgo(1),
        status: 'active',
        confidence: 0.3,
      },
    ];
    const alerts = buildAlertsFromDecisions(decisions);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].kind).toBe('low_confidence');
    expect(alerts[0].severity).toBe('low');
  });

  it('flags low_confidence decision (< 0.2) as high severity', () => {
    const decisions: DecisionForAlerts[] = [
      {
        id: 6,
        topic: 'very-low-conf',
        decision: 'd',
        updated_at: daysAgo(1),
        status: 'active',
        confidence: 0.1,
      },
    ];
    const alerts = buildAlertsFromDecisions(decisions);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].kind).toBe('low_confidence');
    expect(alerts[0].severity).toBe('high');
  });

  it('treats null confidence as no alert (defaults to 1.0)', () => {
    const decisions: DecisionForAlerts[] = [
      {
        id: 7,
        topic: 'null-conf',
        decision: 'd',
        updated_at: daysAgo(1),
        status: 'active',
        confidence: null,
      },
    ];
    expect(buildAlertsFromDecisions(decisions)).toHaveLength(0);
  });

  it('can produce two alerts for the same decision (stale + low_confidence)', () => {
    const decisions: DecisionForAlerts[] = [
      {
        id: 8,
        topic: 'double-trouble',
        decision: 'd',
        updated_at: daysAgo(20),
        status: 'active',
        confidence: 0.1,
      },
    ];
    const alerts = buildAlertsFromDecisions(decisions);
    expect(alerts).toHaveLength(2);
    const kinds = alerts.map((a) => a.kind);
    expect(kinds).toContain('stale');
    expect(kinds).toContain('low_confidence');
  });

  it('sorts alerts by severity descending (high > medium > low)', () => {
    const decisions: DecisionForAlerts[] = [
      // low severity: confidence 0.3, fresh
      {
        id: 10,
        topic: 'low',
        decision: 'd',
        updated_at: daysAgo(1),
        status: 'active',
        confidence: 0.3,
      },
      // high severity: very stale
      {
        id: 11,
        topic: 'high',
        decision: 'd',
        updated_at: daysAgo(45),
        status: 'active',
        confidence: 0.9,
      },
      // medium severity: stale 20 days
      {
        id: 12,
        topic: 'medium',
        decision: 'd',
        updated_at: daysAgo(20),
        status: 'active',
        confidence: 0.9,
      },
    ];
    const alerts = buildAlertsFromDecisions(decisions);
    expect(alerts[0].severity).toBe('high');
    expect(alerts[1].severity).toBe('medium');
    expect(alerts[2].severity).toBe('low');
  });

  it('accepts a custom "now" date for deterministic testing', () => {
    const fixedNow = new Date('2024-01-31T00:00:00Z');
    const decisions: DecisionForAlerts[] = [
      {
        id: 20,
        topic: 'stale-fixed',
        decision: 'd',
        updated_at: '2024-01-01T00:00:00Z', // 30 days before fixedNow
        status: 'active',
        confidence: 0.9,
      },
    ];
    const alerts = buildAlertsFromDecisions(decisions, fixedNow);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].kind).toBe('stale');
  });
});

// ---------------------------------------------------------------------------
// buildActivityFeed
// ---------------------------------------------------------------------------

describe('buildActivityFeed', () => {
  it('returns empty array for empty input', () => {
    expect(buildActivityFeed([])).toEqual([]);
  });

  it('sorts items by timestamp descending', () => {
    const items: ActivityItem[] = [
      { type: 'decision', id: 1, topic: 'old', summary: 's', timestamp: '2024-01-01T00:00:00Z' },
      { type: 'decision', id: 2, topic: 'new', summary: 's', timestamp: '2024-03-01T00:00:00Z' },
      { type: 'decision', id: 3, topic: 'mid', summary: 's', timestamp: '2024-02-01T00:00:00Z' },
    ];
    const feed = buildActivityFeed(items);
    expect(feed[0].id).toBe(2);
    expect(feed[1].id).toBe(3);
    expect(feed[2].id).toBe(1);
  });

  it('does not mutate the original array', () => {
    const items: ActivityItem[] = [
      { type: 'decision', id: 1, topic: 'a', summary: 's', timestamp: '2024-01-01T00:00:00Z' },
      { type: 'decision', id: 2, topic: 'b', summary: 's', timestamp: '2024-03-01T00:00:00Z' },
    ];
    const original = [...items];
    buildActivityFeed(items);
    expect(items[0].id).toBe(original[0].id);
    expect(items[1].id).toBe(original[1].id);
  });

  it('preserves all fields including optional project', () => {
    const items: ActivityItem[] = [
      {
        type: 'decision',
        id: 99,
        topic: 'has-project',
        summary: 'summary text',
        project: 'my-project',
        timestamp: '2024-06-01T00:00:00Z',
      },
    ];
    const feed = buildActivityFeed(items);
    expect(feed[0].project).toBe('my-project');
    expect(feed[0].summary).toBe('summary text');
  });
});

// ---------------------------------------------------------------------------
// buildProjectsSummary
// ---------------------------------------------------------------------------

describe('buildProjectsSummary', () => {
  it('returns empty array for empty input', () => {
    expect(buildProjectsSummary([])).toEqual([]);
  });

  it('sorts projects by lastActivity descending', () => {
    const projects: ProjectSummary[] = [
      { project: 'alpha', activeDecisions: 3, lastActivity: '2024-01-15T00:00:00Z' },
      { project: 'gamma', activeDecisions: 1, lastActivity: '2024-03-20T00:00:00Z' },
      { project: 'beta', activeDecisions: 5, lastActivity: '2024-02-10T00:00:00Z' },
    ];
    const sorted = buildProjectsSummary(projects);
    expect(sorted[0].project).toBe('gamma');
    expect(sorted[1].project).toBe('beta');
    expect(sorted[2].project).toBe('alpha');
  });

  it('does not mutate the original array', () => {
    const projects: ProjectSummary[] = [
      { project: 'a', activeDecisions: 1, lastActivity: '2024-01-01T00:00:00Z' },
      { project: 'b', activeDecisions: 2, lastActivity: '2024-06-01T00:00:00Z' },
    ];
    const original = projects.map((p) => p.project);
    buildProjectsSummary(projects);
    expect(projects.map((p) => p.project)).toEqual(original);
  });

  it('preserves connectors field when present', () => {
    const projects: ProjectSummary[] = [
      {
        project: 'with-connectors',
        activeDecisions: 2,
        lastActivity: '2024-06-01T00:00:00Z',
        connectors: ['slack', 'github'],
      },
    ];
    const sorted = buildProjectsSummary(projects);
    expect(sorted[0].connectors).toEqual(['slack', 'github']);
  });

  it('handles projects with equal lastActivity (stable result)', () => {
    const projects: ProjectSummary[] = [
      { project: 'x', activeDecisions: 1, lastActivity: '2024-06-01T00:00:00Z' },
      { project: 'y', activeDecisions: 2, lastActivity: '2024-06-01T00:00:00Z' },
    ];
    const sorted = buildProjectsSummary(projects);
    expect(sorted).toHaveLength(2);
  });
});
