/**
 * Resolving a claim back to its evidence.
 *
 * Two properties carry the weight here, and every case below is one of them failing:
 * a handle must not act as authorization, and an absence must name itself. The second
 * is what the whole session's original bug was made of - a report that asserted things
 * with nothing behind them and read exactly like one that was grounded.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  resolveMemoryProvenance,
  type IndexedEvent,
  type MemoryProvenanceRecord,
  type ProvenanceResolverDeps,
} from '../../src/memory/provenance-resolver.js';

function event(overrides: Partial<IndexedEvent> = {}): IndexedEvent {
  return {
    connector: 'board',
    eventIndexId: 'evt_1',
    sourceId: 'b1:card-1:1785212821694',
    channel: 'project-one',
    observedAt: '2026-07-27T14:29:00.000Z',
    content: 'the second revision moved to the submitted column',
    ...overrides,
  };
}

function record(overrides: Partial<MemoryProvenanceRecord> = {}): MemoryProvenanceRecord {
  return {
    modelRunId: 'run_1',
    contextPacketId: 'packet_1',
    sourceRefs: [{ connector: 'board', eventIndexId: 'evt_1' }],
    ...overrides,
  };
}

function deps(overrides: Partial<ProvenanceResolverDeps> = {}): ProvenanceResolverDeps {
  return {
    lookupMemoryProvenance: () => record(),
    lookupEvent: () => event(),
    isVisible: () => true,
    ...overrides,
  };
}

describe('resolveMemoryProvenance', () => {
  it('answers where a claim came from, with a bounded excerpt', () => {
    const resolution = resolveMemoryProvenance('mem_1', deps());

    expect(resolution.status).toBe('resolved');
    expect(resolution.modelRunId).toBe('run_1');
    expect(resolution.contextPacketId).toBe('packet_1');
    expect(resolution.events).toHaveLength(1);
    expect(resolution.events[0]).toMatchObject({
      connector: 'board',
      eventIndexId: 'evt_1',
      sourceId: 'b1:card-1:1785212821694',
      channel: 'project-one',
    });
    expect(resolution.events[0]?.excerpt).toContain('submitted column');
  });

  it('bounds the excerpt instead of returning the record', () => {
    const long = 'x'.repeat(5_000);
    const resolution = resolveMemoryProvenance(
      'mem_1',
      deps({ lookupEvent: () => event({ content: long }), excerptChars: 50 })
    );

    const excerpt = resolution.events[0]?.excerpt ?? '';
    expect(excerpt.length).toBeLessThanOrEqual(51); // 50 plus the ellipsis
    expect(excerpt.endsWith('…')).toBe(true);
  });

  // The rule that keeps recall from becoming a standing capability: a handle proves only
  // that something was returned once, under some scope. Visibility is re-checked NOW.
  it('withholds an event that is no longer visible, and discloses nothing about it', () => {
    const isVisible = vi.fn(() => false);
    const resolution = resolveMemoryProvenance('mem_1', deps({ isVisible }));

    expect(isVisible).toHaveBeenCalledTimes(1);
    expect(resolution.status).toBe('unresolved');
    expect(resolution.reason).toBe('outside_scope');
    expect(resolution.events).toEqual([]);
    // The id is named so the agent can say a support exists and is unavailable - but no
    // channel, timestamp or content leaks through the refusal.
    expect(JSON.stringify(resolution)).not.toContain('project-one');
    expect(JSON.stringify(resolution)).not.toContain('submitted column');
  });

  it('names an unknown memory rather than returning an empty answer', () => {
    const resolution = resolveMemoryProvenance(
      'mem_missing',
      deps({ lookupMemoryProvenance: () => null })
    );

    expect(resolution.status).toBe('unresolved');
    expect(resolution.reason).toBe('unknown_memory');
  });

  // A save without a compiled packet is accepted on purpose - requiring one before an
  // agent may record an observation would gate judgment on paperwork. It must not then
  // masquerade as supported.
  it('reports a claim with no evidence behind it as exactly that', () => {
    const resolution = resolveMemoryProvenance(
      'mem_1',
      deps({ lookupMemoryProvenance: () => record({ sourceRefs: [] }) })
    );

    expect(resolution.status).toBe('unresolved');
    expect(resolution.reason).toBe('missing_ref');
  });

  it('distinguishes a record that predates scoped writes', () => {
    const resolution = resolveMemoryProvenance(
      'mem_1',
      deps({ lookupMemoryProvenance: () => record({ legacyUnscoped: true, sourceRefs: [] }) })
    );

    expect(resolution.reason).toBe('legacy_unscoped');
  });

  it('separates a deleted event from an unusable ref', () => {
    const deleted = resolveMemoryProvenance('mem_1', deps({ lookupEvent: () => null }));
    expect(deleted.reason).toBe('event_deleted');

    const malformed = resolveMemoryProvenance(
      'mem_1',
      deps({ lookupMemoryProvenance: () => record({ sourceRefs: [{ connector: 'board' }] }) })
    );
    expect(malformed.reason).toBe('unsupported_ref');
  });

  // Partial is its own answer. Collapsing it into either resolved or unresolved would
  // either overstate the support or discard evidence that does exist.
  it('reports partial support as partial, keeping what resolved and why the rest did not', () => {
    const resolution = resolveMemoryProvenance(
      'mem_1',
      deps({
        lookupMemoryProvenance: () =>
          record({
            sourceRefs: [
              { connector: 'board', eventIndexId: 'evt_1' },
              { connector: 'board', eventIndexId: 'evt_gone' },
            ],
          }),
        lookupEvent: (_connector, eventIndexId) => (eventIndexId === 'evt_1' ? event() : null),
      })
    );

    expect(resolution.status).toBe('partial');
    expect(resolution.events).toHaveLength(1);
    expect(resolution.unresolved).toEqual([{ eventIndexId: 'evt_gone', reason: 'event_deleted' }]);
    expect(resolution.reason).toBeUndefined();
  });
});
