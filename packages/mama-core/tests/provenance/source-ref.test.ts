import { describe, expect, it } from 'vitest';

import {
  assertNonEmptySourceRefs,
  fromContextRef,
  fromVerifyArtifact,
  parseSourceRefString,
  serializeSourceRef,
  toContextRef,
} from '../../src/provenance/source-ref.js';

describe('Story VNext PR0: canonical SourceRef compatibility', () => {
  it('AC: converts current context refs without changing their provenance identity', () => {
    expect(fromContextRef({ kind: 'memory', id: ' mem-1 ' })).toEqual({
      kind: 'memory',
      id: 'mem-1',
    });
    expect(fromContextRef({ kind: 'entity', id: ' entity-1 ' })).toEqual({
      kind: 'entity',
      id: 'entity-1',
    });
    expect(fromContextRef({ kind: 'case', id: ' case-1 ' })).toEqual({
      kind: 'case',
      id: 'case-1',
    });

    const raw = fromContextRef({
      kind: 'raw',
      raw_id: ' raw-1 ',
      connector: ' slack ',
      source_id: ' source-1 ',
      channel_id: ' channel-1 ',
    });

    expect(raw).toEqual({
      kind: 'raw',
      id: 'raw-1',
      connector: 'slack',
      source_id: 'source-1',
      channel_id: 'channel-1',
    });
    expect(toContextRef(raw)).toEqual({
      kind: 'raw',
      raw_id: 'raw-1',
      connector: 'slack',
      source_id: 'source-1',
      channel_id: 'channel-1',
    });
  });

  it('AC: adapts verify artifact refs that cannot be represented as V0 context refs', () => {
    expect(fromVerifyArtifact({ type: 'context_packet', id: ' packet-1 ' })).toEqual({
      kind: 'context_packet',
      id: 'packet-1',
    });
    expect(fromVerifyArtifact({ type: 'model_run', id: ' run-1 ' })).toEqual({
      kind: 'model_run',
      id: 'run-1',
    });
    expect(fromVerifyArtifact({ type: 'tool_trace', id: ' trace-1 ' })).toEqual({
      kind: 'tool_trace',
      id: 'trace-1',
    });
    expect(toContextRef({ kind: 'context_packet', id: 'packet-1' })).toBeNull();
  });

  it('AC: parses and serializes current and legacy provenance strings', () => {
    expect(parseSourceRefString('raw:slack:event-1')).toEqual({
      kind: 'raw',
      connector: 'slack',
      id: 'event-1',
    });
    expect(serializeSourceRef({ kind: 'raw', connector: 'slack', id: 'event-1' })).toBe(
      'raw:slack:event-1'
    );

    expect(parseSourceRefString('memory:mem-1')).toEqual({ kind: 'memory', id: 'mem-1' });
    expect(serializeSourceRef({ kind: 'memory', id: 'mem-1' })).toBe('memory:mem-1');

    expect(parseSourceRefString('message:test')).toEqual({
      kind: 'legacy',
      legacy_kind: 'message',
      id: 'test',
    });
    expect(parseSourceRefString('conversation:test')).toEqual({
      kind: 'legacy',
      legacy_kind: 'conversation',
      id: 'test',
    });
    expect(parseSourceRefString('raw_memory:test')).toEqual({
      kind: 'legacy',
      legacy_kind: 'raw_memory',
      id: 'test',
    });
    expect(serializeSourceRef({ kind: 'legacy', legacy_kind: 'raw_memory', id: 'test' })).toBe(
      'raw_memory:test'
    );
  });

  it('AC: rejects empty refs and unknown strict refs before durable writes', () => {
    expect(() => assertNonEmptySourceRefs([])).toThrow(/source refs/i);
    expect(() => parseSourceRefString('')).toThrow(/source ref/i);
    expect(() => parseSourceRefString('unknown:test')).toThrow(/unsupported/i);
    expect(() => fromVerifyArtifact({ type: 'unknown', id: 'test' })).toThrow(/unsupported/i);
    expect(() => assertNonEmptySourceRefs([{ kind: 'unknown', id: 'test' } as never])).toThrow(
      /unsupported/i
    );
    expect(() => assertNonEmptySourceRefs([{ kind: 'message', id: 'test' } as never])).toThrow(
      /unsupported/i
    );
  });

  it('AC: rejects nullish refs and malformed context refs with explicit errors', () => {
    expect(() => fromContextRef(null as never)).toThrow(/context ref/i);
    expect(() => fromContextRef({ kind: 'decision', id: 'decision-1' } as never)).toThrow(
      /unsupported/i
    );
    expect(toContextRef(null as never)).toBeNull();
    expect(() => fromVerifyArtifact(null as never)).toThrow(/artifact/i);
    expect(() => serializeSourceRef(null as never)).toThrow(/source ref/i);
  });
});
