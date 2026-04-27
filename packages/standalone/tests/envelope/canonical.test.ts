import { describe, expect, it } from 'vitest';
import { canonicalEnvelopeJson, computeEnvelopeHash } from '../../src/envelope/canonical.js';
import type { Envelope } from '../../src/envelope/types.js';

const baseEnvelope: Envelope = {
  agent_id: 'worker',
  instance_id: 'inst_01',
  source: 'telegram',
  channel_id: 'tg:1234',
  trigger_context: { user_text: 'hi' },
  scope: {
    project_refs: [{ kind: 'project', id: '/workspace/project-a' }],
    raw_connectors: ['telegram'],
    memory_scopes: [{ kind: 'project', id: '/workspace/project-a' }],
    allowed_destinations: [{ kind: 'telegram', id: 'tg:1234' }],
  },
  tier: 1,
  budget: { wall_seconds: 10 },
  expires_at: '2026-04-26T12:00:00Z',
  envelope_hash: '',
};

describe('canonical envelope hashing', () => {
  it('produces deterministic hash for same envelope', () => {
    const a = computeEnvelopeHash(baseEnvelope);
    const b = computeEnvelopeHash(baseEnvelope);

    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('ignores envelope_hash and signature fields when hashing', () => {
    const a = computeEnvelopeHash({ ...baseEnvelope, envelope_hash: 'aaaa' });
    const b = computeEnvelopeHash({
      ...baseEnvelope,
      envelope_hash: 'bbbb',
      signature: { hmac: 'x', key_id: 'k1', key_version: 1 },
    });

    expect(a).toBe(b);
  });

  it('produces same hash for keys in different insertion order', () => {
    const reordered: Envelope = {
      ...baseEnvelope,
      scope: {
        allowed_destinations: baseEnvelope.scope.allowed_destinations,
        memory_scopes: baseEnvelope.scope.memory_scopes,
        raw_connectors: baseEnvelope.scope.raw_connectors,
        project_refs: baseEnvelope.scope.project_refs,
      },
    };

    expect(computeEnvelopeHash(reordered)).toBe(computeEnvelopeHash(baseEnvelope));
  });

  it('produces different hash when scope changes', () => {
    const widened: Envelope = {
      ...baseEnvelope,
      scope: {
        ...baseEnvelope.scope,
        raw_connectors: ['telegram', 'slack'],
      },
    };

    expect(computeEnvelopeHash(widened)).not.toBe(computeEnvelopeHash(baseEnvelope));
  });

  it('canonical JSON has no whitespace and sorted top-level keys', () => {
    const json = canonicalEnvelopeJson(baseEnvelope);

    expect(json).not.toMatch(/[\n\r\t ]/);
    expect(json.startsWith('{"agent_id"')).toBe(true);
  });

  it.each([
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['-Infinity', Number.NEGATIVE_INFINITY],
    ['undefined', undefined],
    ['function', () => 'nope'],
    ['symbol', Symbol('nope')],
    ['bigint', BigInt(1)],
  ])('rejects non-JSON-safe value: %s', (_label, badValue) => {
    const invalid = {
      ...baseEnvelope,
      trigger_context: { badValue },
    } as unknown as Envelope;

    expect(() => canonicalEnvelopeJson(invalid)).toThrow(/JSON-safe|unsupported|finite/i);
  });

  it('rejects invalid values nested inside arrays', () => {
    const invalid = {
      ...baseEnvelope,
      trigger_context: { values: ['ok', undefined] },
    } as unknown as Envelope;

    expect(() => canonicalEnvelopeJson(invalid)).toThrow(/JSON-safe|unsupported/i);
  });
});
