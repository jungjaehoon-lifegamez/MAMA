/**
 * Correlation is the join a cross-store claim rests on. Every case here is a way the
 * join can be wrong while still looking answerable - which is how title matching
 * produced confident, false statements about item state. Synthetic data only.
 */
import { describe, it, expect } from 'vitest';
import {
  correlateTasksWithExternalItems,
  type CorrelationInput,
  type ProvenanceRecord,
} from '../../src/operator/external-correlation.js';

const CONNECTOR = 'trello';

function provenance(overrides: Partial<ProvenanceRecord> = {}): ProvenanceRecord {
  return {
    sourceConnector: CONNECTOR,
    sourceId: 'board-1:item-1:1785212821694',
    metadata: { boardId: 'board-1', cardId: 'item-1' },
    ...overrides,
  };
}

function run(input: Partial<CorrelationInput> & Pick<CorrelationInput, 'rows'>) {
  return correlateTasksWithExternalItems({
    connector: CONNECTOR,
    lookupProvenance: () => provenance(),
    liveItems: [{ itemId: 'item-1', board: 'Board One', list: 'in submission' }],
    liveSnapshotComplete: true,
    ...input,
  });
}

describe('correlateTasksWithExternalItems', () => {
  it('matches a row through structured provenance and reports the live position', () => {
    const { correlations, coverage } = run({
      rows: [{ id: 1, sourceChannel: 'trello:Board One', sourceEventId: 'evt_a' }],
    });

    expect(correlations[0]).toEqual({
      taskId: 1,
      outcome: 'matched',
      reason: 'live_item',
      externalRef: { boardId: 'board-1', itemId: 'item-1' },
      live: { board: 'Board One', list: 'in submission' },
    });
    expect(coverage).toMatchObject({ total: 1, matched: 1 });
  });

  it('prefers structured metadata over the composite id and flags a disagreement', () => {
    const conflicting = run({
      rows: [{ id: 1, sourceChannel: 'trello:Board One', sourceEventId: 'evt_a' }],
      lookupProvenance: () =>
        provenance({
          sourceId: 'board-1:other-item:1785212821694',
          metadata: { boardId: 'board-1', cardId: 'item-1' },
        }),
    });

    expect(conflicting.correlations[0]).toMatchObject({
      outcome: 'ambiguous',
      reason: 'provenance_conflict',
    });
  });

  it('falls back to the composite id only when structured metadata is absent', () => {
    const legacy = run({
      rows: [{ id: 1, sourceChannel: 'trello:Board One', sourceEventId: 'evt_a' }],
      lookupProvenance: () => provenance({ metadata: null }),
    });

    expect(legacy.correlations[0]).toMatchObject({
      outcome: 'matched',
      externalRef: { boardId: 'board-1', itemId: 'item-1' },
    });
  });

  it('treats source_event_id as untrusted: missing, unindexed, or wrong connector never matches', () => {
    const missing = run({ rows: [{ id: 1, sourceChannel: 'trello:B', sourceEventId: null }] });
    expect(missing.correlations[0]).toMatchObject({
      outcome: 'unmatched',
      reason: 'no_provenance',
    });

    const unindexed = run({
      rows: [{ id: 2, sourceChannel: 'trello:B', sourceEventId: 'evt_missing' }],
      lookupProvenance: () => null,
    });
    expect(unindexed.correlations[0]).toMatchObject({
      outcome: 'unmatched',
      reason: 'provenance_not_indexed',
    });

    const wrongConnector = run({
      rows: [{ id: 3, sourceChannel: 'trello:B', sourceEventId: 'evt_a' }],
      lookupProvenance: () => provenance({ sourceConnector: 'kagemusha' }),
    });
    expect(wrongConnector.correlations[0]).toMatchObject({
      outcome: 'unmatched',
      reason: 'provenance_connector_mismatch',
    });

    const unresolvable = run({
      rows: [{ id: 4, sourceChannel: 'trello:B', sourceEventId: 'evt_a' }],
      lookupProvenance: () => provenance({ sourceId: 'no-parts', metadata: {} }),
    });
    expect(unresolvable.correlations[0]).toMatchObject({
      outcome: 'unmatched',
      reason: 'external_ref_unresolvable',
    });
  });

  it('classifies rows from other stores as not applicable, never unmatched', () => {
    const { correlations, coverage } = run({
      rows: [
        { id: 1, sourceChannel: 'kagemusha:room', sourceEventId: 'evt_a' },
        { id: 2, sourceChannel: null, sourceEventId: null },
      ],
    });

    expect(correlations.map((c) => c.reason)).toEqual(['other_connector', 'no_source']);
    expect(coverage).toMatchObject({ not_applicable: 2, unmatched: 0 });
  });

  // The trap this encodes: the poller reads only open items and emits no tombstone, so
  // an item missing from the snapshot may be archived, deleted, moved, or simply unread.
  it('reports an item absent from the live snapshot as historical only, never as done', () => {
    const { correlations } = run({
      rows: [{ id: 1, sourceChannel: 'trello:B', sourceEventId: 'evt_a' }],
      liveItems: [],
    });

    expect(correlations[0]).toMatchObject({
      outcome: 'historical_only',
      reason: 'absent_from_live_snapshot',
      live: null,
    });
  });

  it('says so when absence rests on an incomplete snapshot', () => {
    const { correlations } = run({
      rows: [{ id: 1, sourceChannel: 'trello:B', sourceEventId: 'evt_a' }],
      liveItems: [],
      liveSnapshotComplete: false,
    });

    expect(correlations[0]).toMatchObject({
      outcome: 'historical_only',
      reason: 'live_snapshot_incomplete',
    });
  });

  it('demotes every row when several resolve to one external item', () => {
    const { correlations, coverage } = run({
      rows: [
        { id: 1, sourceChannel: 'trello:B', sourceEventId: 'evt_a' },
        { id: 2, sourceChannel: 'trello:B', sourceEventId: 'evt_b' },
      ],
    });

    expect(correlations.every((c) => c.outcome === 'ambiguous')).toBe(true);
    expect(correlations.every((c) => c.reason === 'multiple_rows_one_item')).toBe(true);
    expect(correlations.every((c) => c.live === null)).toBe(true);
    expect(coverage).toMatchObject({ total: 2, matched: 0, ambiguous: 2 });
  });

  it('counts every outcome so a caller can see how much of the board it may speak about', () => {
    const { coverage } = run({
      rows: [
        { id: 1, sourceChannel: 'trello:B', sourceEventId: 'evt_a' },
        { id: 2, sourceChannel: 'trello:B', sourceEventId: null },
        { id: 3, sourceChannel: 'slack:C', sourceEventId: 'evt_c' },
      ],
    });

    expect(coverage).toEqual({
      total: 3,
      matched: 1,
      unmatched: 1,
      ambiguous: 0,
      historical_only: 0,
      not_applicable: 1,
    });
  });
});
