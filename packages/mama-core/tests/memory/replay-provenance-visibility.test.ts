import { describe, expect, it } from 'vitest';

import {
  isEventVisibleNow,
  parseSourceRef,
  toIndexedEvent,
} from '../../src/memory/provenance-live.js';
import { resolveMemoryProvenance } from '../../src/memory/provenance-resolver.js';

describe('replay source-time provenance visibility', () => {
  it('resolves an observation handle recorded directly in session source refs', () => {
    const observationId = 'obs_0123456789abcdef01234567';
    const event = {
      connector: 'source-test',
      eventIndexId: observationId,
      sourceId: 'message-test',
      channel: 'room-test',
      observedAt: null,
      content: 'Synthetic correction original',
    };
    const result = resolveMemoryProvenance('memory-test', {
      lookupMemoryProvenance: () => ({
        modelRunId: null,
        contextPacketId: null,
        sourceRefs: [parseSourceRef(observationId)],
      }),
      lookupEvent: () => null,
      lookupObservation: (ref) => (ref === observationId ? event : null),
      isVisible: () => true,
    });
    expect(result.events).toEqual([
      {
        connector: 'source-test',
        eventIndexId: observationId,
        sourceId: 'message-test',
        channel: 'room-test',
        observedAt: null,
        excerpt: 'Synthetic correction original',
      },
    ]);
  });

  it('uses source_at instead of the shared import capture time', () => {
    const event = toIndexedEvent({
      event_index_id: 'observation-test',
      source_connector: 'connector-test',
      source_id: 'source-test',
      channel: 'channel-test',
      content: 'source body',
      observed_at: 10_000,
      source_at: 1_000,
      memory_scope_kind: null,
      memory_scope_id: null,
      project_id: null,
      tenant_id: null,
    });
    const base = {
      scopes: [],
      connectors: ['connector-test'],
      wideConnectors: ['connector-test'],
    };
    expect(isEventVisibleNow(event, { ...base, maxSourceMs: 1_500 })).toBe(true);
    expect(isEventVisibleNow(event, { ...base, maxSourceMs: 500 })).toBe(false);
  });
});
