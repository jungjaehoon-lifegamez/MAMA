import { describe, expect, it } from 'vitest';
import type { OperatorTrigger } from '../../ui/src/api/client';
import { filterTriggers } from '../../ui/src/lib/trigger-filter';

function trigger(
  id: string,
  kind: string,
  status: OperatorTrigger['status'],
  keywords: string[],
  overrides: Partial<OperatorTrigger> = {}
): OperatorTrigger {
  return {
    id,
    kind,
    memoryQuery: `memory query ${id}`,
    match: { keywords, keywordMode: 'any', minConfidence: 0.5 },
    procedure: [],
    requiredEvidence: [],
    status,
    authoredBy: id === 'seed-trigger' ? 'seed' : 'agent',
    createdAt: 1,
    updatedAt: 2,
    provenance: { createdFrom: `source ${id}`, note: `note ${id}` },
    fired: 0,
    succeeded: 0,
    failed: 0,
    disabledReason: null,
    ...overrides,
  };
}

const fixtures = [
  trigger('active-trigger', 'Daily_Summary', 'active', ['Morning Brief', 'priority']),
  trigger('seed-trigger', 'incident_followup', 'disabled', ['outage', 'postmortem']),
  trigger('old-trigger', 'legacy_cleanup', 'superseded', []),
];

describe('filterTriggers', () => {
  it('returns all triggers in original order for an empty query and all statuses', () => {
    const result = filterTriggers(fixtures, '', 'all');

    expect(result).toEqual(fixtures);
    expect(result.map((item) => item.id)).toEqual([
      'active-trigger',
      'seed-trigger',
      'old-trigger',
    ]);
  });

  it('trims the query and matches kind substrings case-insensitively', () => {
    expect(filterTriggers(fixtures, '  DAILY_s  ', 'all')).toEqual([fixtures[0]]);
  });

  it('matches a substring of any keyword case-insensitively', () => {
    expect(filterTriggers(fixtures, 'BRIEF', 'all')).toEqual([fixtures[0]]);
    expect(filterTriggers(fixtures, 'mort', 'all')).toEqual([fixtures[1]]);
  });

  it('does not search memory query, author, or provenance', () => {
    const hiddenFields = trigger('hidden', 'visible_kind', 'active', ['visible-keyword'], {
      memoryQuery: 'private-search-value',
      authoredBy: 'seed',
      provenance: { createdFrom: 'hidden-source', note: 'hidden-note' },
    });

    expect(filterTriggers([hiddenFields], 'private-search', 'all')).toEqual([]);
    expect(filterTriggers([hiddenFields], 'seed', 'all')).toEqual([]);
    expect(filterTriggers([hiddenFields], 'hidden-source', 'all')).toEqual([]);
    expect(filterTriggers([hiddenFields], 'hidden-note', 'all')).toEqual([]);
  });

  it.each(['active', 'disabled', 'superseded'] as const)(
    'filters the %s status by exact equality',
    (status) => {
      expect(filterTriggers(fixtures, '', status).map((item) => item.status)).toEqual([status]);
    }
  );

  it('composes status and query filters', () => {
    expect(filterTriggers(fixtures, 'outage', 'disabled')).toEqual([fixtures[1]]);
    expect(filterTriggers(fixtures, 'outage', 'active')).toEqual([]);
  });

  it('handles empty keyword arrays without mutating inputs or records', () => {
    const input = [...fixtures];
    const before = JSON.stringify(input);

    expect(filterTriggers(input, 'legacy', 'all')).toEqual([fixtures[2]]);
    expect(JSON.stringify(input)).toBe(before);
    expect(input).toEqual(fixtures);
    expect(input[2]).toBe(fixtures[2]);
  });
});
