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
import {
  isEventVisibleNow,
  isMessageRefVisible,
  parseSourceRef,
} from '../../src/memory/provenance-live.js';
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
    projectId: null,
    tenantId: null,
    ...overrides,
  };
}

describe('parseSourceRef', () => {
  it('dereferences a raw ref to its connector and event', () => {
    expect(parseSourceRef('raw:board:evt_abc123')).toEqual({
      kind: 'raw',
      connector: 'board',
      eventIndexId: 'evt_abc123',
    });
  });

  // The shapes the write path actually stores. The first version of this parser knew only
  // `raw:` and so reported all 15,160 stored refs on this machine as unparseable - a tool
  // that was wired, callable, and answered nothing.
  it('recognises the ref kinds the runtime actually writes', () => {
    expect(parseSourceRef('envelope:sha256abc')).toEqual({ kind: 'envelope', id: 'sha256abc' });
    expect(parseSourceRef('memory:mem_1')).toEqual({ kind: 'memory', id: 'mem_1' });
    expect(parseSourceRef('message:telegram/123/456')).toEqual({
      kind: 'message',
      id: 'telegram/123/456',
    });
  });

  it('reports shapes it cannot parse as unsupported', () => {
    for (const ref of ['case:case_1', 'entity:e_1', 'raw:', 'raw:board:', 'raw::x', 'nope', '']) {
      expect(parseSourceRef(ref)).toEqual({ kind: 'unsupported' });
    }
  });

  // A colon inside the id must not shift the connector boundary.
  it('splits a raw ref on the first colon only', () => {
    expect(parseSourceRef('raw:board:evt:with:colons')).toEqual({
      kind: 'raw',
      connector: 'board',
      eventIndexId: 'evt:with:colons',
    });
  });
});

describe('isEventVisibleNow', () => {
  const projectScope = [{ kind: 'project' as const, id: 'alpha' }];
  const globalSystem = [{ kind: 'global' as const, id: 'system' }];
  // What deriveMemoryScopes actually produces: specific scopes AND the sentinel.
  const productionScopes = [
    { kind: 'project' as const, id: 'alpha' },
    { kind: 'channel' as const, id: 'c1' },
    { kind: 'global' as const, id: 'system' },
  ];

  it('shows an event whose scope is active', () => {
    expect(isEventVisibleNow(event(), { scopes: projectScope, connectors: ['board'] })).toBe(true);
  });

  it('refuses an event from another scope', () => {
    expect(
      isEventVisibleNow(event({ memoryScope: { kind: 'project', id: 'beta' } }), {
        scopes: projectScope,
        connectors: ['board'],
      })
    ).toBe(false);
  });

  // The grant that authorizes reading a connector's raw data at all. Without this, an
  // agent denied a connector could still read its events one citation at a time.
  it('refuses a connector the caller was not granted', () => {
    expect(isEventVisibleNow(event(), { scopes: projectScope, connectors: ['gmail'] })).toBe(false);
    expect(isEventVisibleNow(event(), { scopes: projectScope, connectors: ['board'] })).toBe(true);
  });

  // No grant is NO raw events, never all of them. The first version treated a missing
  // envelope as "scope alone decides", which turned an absent grant into a wide one.
  it('shows nothing without a connector grant', () => {
    expect(isEventVisibleNow(event(), { scopes: projectScope, connectors: [] })).toBe(false);
  });

  it('refuses everything when no scope is active', () => {
    expect(isEventVisibleNow(event(), { scopes: [], connectors: ['board'] })).toBe(false);
  });

  // 19,394 of 30,671 indexed events on this machine carry no scope. The reader admits
  // them ONLY to a caller whose scope set is the global-system sentinel and nothing else
  // (source-readers.ts:704-711). The mixed set below is the one the runtime actually
  // produces, and it is where the first version of this predicate was wrong - it showed
  // the event, the reader does not. See provenance-visibility-differential.test.ts.
  it('admits an unscoped event exactly where the raw reader does, and nowhere else', () => {
    const unscoped = event({ memoryScope: null });
    expect(isEventVisibleNow(unscoped, { scopes: globalSystem, connectors: ['board'] })).toBe(true);
    expect(isEventVisibleNow(unscoped, { scopes: projectScope, connectors: ['board'] })).toBe(
      false
    );
    expect(isEventVisibleNow(unscoped, { scopes: productionScopes, connectors: ['board'] })).toBe(
      false
    );
    expect(
      isEventVisibleNow(unscoped, {
        scopes: globalSystem,
        connectors: ['board'],
        projectIds: ['p1'],
      })
    ).toBe(false);
  });

  // The reader filters the same columns; ignoring them made citation wider than reading.
  it('applies the project window the reader applies', () => {
    const inProject = event({ projectId: 'p1' });
    expect(
      isEventVisibleNow(inProject, {
        scopes: projectScope,
        connectors: ['board'],
        projectIds: ['p1'],
      })
    ).toBe(true);
    expect(
      isEventVisibleNow(inProject, {
        scopes: projectScope,
        connectors: ['board'],
        projectIds: ['p2'],
      })
    ).toBe(false);
    // project_id IS NULL does not satisfy IN (...) for the reader either.
    expect(
      isEventVisibleNow(event({ projectId: null }), {
        scopes: projectScope,
        connectors: ['board'],
        projectIds: ['p1'],
      })
    ).toBe(false);
  });

  it('treats a missing scope field the same as an explicitly absent one', () => {
    const { memoryScope: _dropped, ...withoutField } = event();
    expect(isEventVisibleNow(withoutField, { scopes: projectScope, connectors: ['board'] })).toBe(
      false
    );
    expect(isEventVisibleNow(withoutField, { scopes: globalSystem, connectors: ['board'] })).toBe(
      true
    );
  });

  // Rows written before the global/system alignment carry id 'global'. The reader matches
  // both ids; a stricter rule here would hide old evidence that is legitimately visible.
  it('matches pre-alignment global rows for a global-system caller', () => {
    const legacyGlobal = event({ memoryScope: { kind: 'global', id: 'global' } });
    expect(isEventVisibleNow(legacyGlobal, { scopes: globalSystem, connectors: ['board'] })).toBe(
      true
    );
    expect(
      isEventVisibleNow(legacyGlobal, {
        scopes: [{ kind: 'global', id: 'other' }],
        connectors: ['board'],
      })
    ).toBe(false);
  });
});

describe('isMessageRefVisible', () => {
  const channel = [
    { kind: 'channel' as const, id: 'chat:c1' },
    { kind: 'global' as const, id: 'system' },
  ];

  it('names a ref only for the channel it belongs to', () => {
    expect(isMessageRefVisible('chat:c1:99', channel)).toBe(true);
    expect(isMessageRefVisible('chat:c2:99', channel)).toBe(false);
  });

  // global:system is on every caller's scope set, so it must not be what admits a ref.
  it('is not satisfied by the global sentinel alone', () => {
    expect(isMessageRefVisible('chat:c1:99', [{ kind: 'global', id: 'system' }])).toBe(false);
  });

  // A turn id can be `generated:<uuid>`, so splitting on the last colon would
  // mis-attribute the ref. The prefix comparison is what makes that safe.
  it('handles a turn id that itself contains a colon', () => {
    expect(isMessageRefVisible('chat:c1:generated:abc123', channel)).toBe(true);
    expect(isMessageRefVisible('chat:c1x:generated:abc123', channel)).toBe(false);
  });
});
