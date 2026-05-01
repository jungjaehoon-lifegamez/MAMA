import { describe, expect, it } from 'vitest';

import {
  normalizeContextRef,
  serializeContextRefForProvenance,
  toTwinRef,
} from '../../src/context-compile/ref.js';

describe('Story V0.21: Context compile refs - AC1', () => {
  it('AC: accepts supported V0 refs and normalizes ids', () => {
    expect(normalizeContextRef({ kind: 'memory', id: ' mem-1 ' })).toEqual({
      kind: 'memory',
      id: 'mem-1',
    });
    expect(normalizeContextRef({ kind: 'entity', id: ' entity-1 ' })).toEqual({
      kind: 'entity',
      id: 'entity-1',
    });
    expect(normalizeContextRef({ kind: 'case', id: ' case-1 ' })).toEqual({
      kind: 'case',
      id: 'case-1',
    });
    expect(
      normalizeContextRef({
        kind: 'raw',
        raw_id: ' raw-1 ',
        connector: ' slack ',
        source_id: ' source-1 ',
        channel_id: ' channel-1 ',
      })
    ).toEqual({
      kind: 'raw',
      raw_id: 'raw-1',
      connector: 'slack',
      source_id: 'source-1',
      channel_id: 'channel-1',
    });
  });

  it('AC: rejects empty ids, free-form refs, unknown kinds, and unsupported V0 refs', () => {
    expect(() => normalizeContextRef({ kind: 'memory', id: '   ' })).toThrow(/id/i);
    expect(() => normalizeContextRef({ kind: 'raw', raw_id: 'raw-1', connector: ' ' })).toThrow(
      /connector/i
    );
    expect(() => normalizeContextRef({ type: 'memory', id: 'mem-1' })).toThrow(/kind/i);
    expect(() => normalizeContextRef({ kind: 'edge', id: 'edge-1' })).toThrow(/unsupported/i);

    for (const kind of ['decision', 'wiki_page', 'context_packet', 'report']) {
      expect(() => normalizeContextRef({ kind, id: `${kind}-1` })).toThrow(/unsupported/i);
    }
  });

  it('AC: serializes provenance without losing raw connector identity', () => {
    const slackRaw = normalizeContextRef({
      kind: 'raw',
      raw_id: 'event-1',
      connector: 'slack',
    });
    const discordRaw = normalizeContextRef({
      kind: 'raw',
      raw_id: 'event-1',
      connector: 'discord',
    });

    expect(serializeContextRefForProvenance({ kind: 'memory', id: 'mem-1' })).toBe('memory:mem-1');
    expect(serializeContextRefForProvenance(slackRaw)).toBe('raw:slack:event-1');
    expect(serializeContextRefForProvenance(discordRaw)).toBe('raw:discord:event-1');
    expect(serializeContextRefForProvenance(slackRaw)).not.toBe(
      serializeContextRefForProvenance(discordRaw)
    );
  });

  it('AC: maps only truthful V0 refs to TwinRef values', () => {
    expect(toTwinRef({ kind: 'memory', id: 'mem-1' })).toEqual({ kind: 'memory', id: 'mem-1' });
    expect(toTwinRef({ kind: 'entity', id: 'entity-1' })).toEqual({
      kind: 'entity',
      id: 'entity-1',
    });
    expect(toTwinRef({ kind: 'case', id: 'case-1' })).toEqual({ kind: 'case', id: 'case-1' });
    expect(toTwinRef({ kind: 'raw', raw_id: 'event-1', connector: 'slack' })).toEqual({
      kind: 'raw',
      id: 'slack:event-1',
    });
  });
});
