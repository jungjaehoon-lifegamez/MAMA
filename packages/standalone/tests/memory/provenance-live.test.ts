/**
 * The rule this file exists to hold: CITATION MUST NOT OUT-READ READING.
 *
 * The resolver is reached with a memory id, and a memory id is cheap - it travels in
 * recall output, in a report, in anything an agent wrote down earlier. If resolving one
 * could surface an event that the normal raw read would refuse, the id would become a way
 * to launder access rather than a way to check a claim. Every case below is that rule
 * being enforced against a different shape of input.
 *
 * The scope predicate deliberately mirrors the raw candidate reader in context-compile
 * rather than forming a second opinion about access. Where it looks permissive - unscoped
 * events admitted to a global-system caller - it is permissive in exactly the same place,
 * and for the same reason, as the reader it mirrors.
 */
import { describe, it, expect } from 'vitest';
import { isEventVisibleNow, parseSourceRef } from '../../src/memory/provenance-live.js';
import type { IndexedEvent } from '../../src/memory/provenance-resolver.js';

function event(overrides: Partial<IndexedEvent> = {}): IndexedEvent {
  return {
    connector: 'board',
    eventIndexId: 'evt_1',
    sourceId: 'b1:card-1:1785212821694',
    channel: 'project-one',
    observedAt: '2026-07-27T14:29:00.000Z',
    content: 'moved to the submitted column',
    memoryScope: { kind: 'project', id: 'alpha' },
    ...overrides,
  };
}

describe('parseSourceRef', () => {
  it('dereferences a raw ref to its connector and event', () => {
    expect(parseSourceRef('raw:board:evt_abc123')).toEqual({
      connector: 'board',
      eventIndexId: 'evt_abc123',
    });
  });

  // These are real provenance pointing at things this resolver does not read. Reporting
  // them as unsupported rather than missing keeps "no evidence" meaning what it says.
  it('reports refs it cannot dereference as unsupported, not as absent evidence', () => {
    for (const ref of [
      'memory:mem_1',
      'case:case_1',
      'entity:e_1',
      'raw:',
      'raw:board:',
      'raw::x',
    ]) {
      expect(parseSourceRef(ref)).toEqual({});
    }
  });
});

describe('isEventVisibleNow', () => {
  const projectScope = [{ kind: 'project' as const, id: 'alpha' }];
  const globalSystem = [{ kind: 'global' as const, id: 'system' }];

  it('shows an event whose scope is active', () => {
    expect(isEventVisibleNow(event(), { scopes: projectScope, connectors: null })).toBe(true);
  });

  it('refuses an event from another scope', () => {
    expect(
      isEventVisibleNow(event({ memoryScope: { kind: 'project', id: 'beta' } }), {
        scopes: projectScope,
        connectors: null,
      })
    ).toBe(false);
  });

  // The grant that authorizes reading a connector's raw data at all. Without this, an
  // agent denied a connector could still read its events one citation at a time.
  it('refuses a connector the caller was not granted', () => {
    expect(isEventVisibleNow(event(), { scopes: projectScope, connectors: ['gmail'] })).toBe(false);
    expect(isEventVisibleNow(event(), { scopes: projectScope, connectors: ['board'] })).toBe(true);
  });

  // Same distinction the envelope layer makes: no information is not no authority.
  it('separates an absent connector grant from an empty one', () => {
    expect(isEventVisibleNow(event(), { scopes: projectScope, connectors: null })).toBe(true);
    expect(isEventVisibleNow(event(), { scopes: projectScope, connectors: [] })).toBe(false);
  });

  it('refuses everything when no scope is active', () => {
    expect(isEventVisibleNow(event(), { scopes: [], connectors: null })).toBe(false);
  });

  // 63% of indexed events on a live machine carry no scope - they predate scoped
  // indexing. Denying them outright would make provenance useless across most of the
  // corpus; admitting them to everyone would answer from data the reader refuses. The
  // reader admits them to a global-system caller only, so this does too.
  it('admits an unscoped event exactly where the raw reader does, and nowhere else', () => {
    const unscoped = event({ memoryScope: null });
    expect(isEventVisibleNow(unscoped, { scopes: globalSystem, connectors: null })).toBe(true);
    expect(isEventVisibleNow(unscoped, { scopes: projectScope, connectors: null })).toBe(false);
  });

  it('treats a missing scope field the same as an explicitly absent one', () => {
    const { memoryScope: _dropped, ...withoutField } = event();
    expect(isEventVisibleNow(withoutField, { scopes: projectScope, connectors: null })).toBe(false);
    expect(isEventVisibleNow(withoutField, { scopes: globalSystem, connectors: null })).toBe(true);
  });

  // Rows written before the global/system alignment carry id 'global'. The reader matches
  // both ids; a stricter rule here would hide old evidence that is legitimately visible.
  it('matches pre-alignment global rows for a global-system caller', () => {
    const legacyGlobal = event({ memoryScope: { kind: 'global', id: 'global' } });
    expect(isEventVisibleNow(legacyGlobal, { scopes: globalSystem, connectors: null })).toBe(true);
    expect(
      isEventVisibleNow(legacyGlobal, {
        scopes: [{ kind: 'global', id: 'other' }],
        connectors: null,
      })
    ).toBe(false);
  });
});
