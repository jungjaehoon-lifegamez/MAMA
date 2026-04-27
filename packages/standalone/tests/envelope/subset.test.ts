import { describe, expect, it } from 'vitest';
import { computeEnvelopeHash } from '../../src/envelope/canonical.js';
import { isEnvelopeSubset } from '../../src/envelope/subset.js';
import type { Envelope } from '../../src/envelope/types.js';

type EnvOverrides = Partial<Envelope['scope']> & {
  tier?: 1 | 2 | 3;
  wall?: number;
  tokens?: number;
  cost?: number;
  expiresAt?: string;
};

function envOf(overrides: EnvOverrides = {}): Envelope {
  const { tier, wall, tokens, cost, expiresAt, ...scopeOverrides } = overrides;
  const env: Envelope = {
    agent_id: 'worker',
    instance_id: `i_${Math.random().toString(36).slice(2)}`,
    source: 'delegate',
    trigger_context: {},
    scope: {
      project_refs: [{ kind: 'project', id: '/A' }],
      raw_connectors: ['telegram'],
      memory_scopes: [{ kind: 'project', id: '/A' }],
      allowed_destinations: [{ kind: 'telegram', id: 'tg:1' }],
      ...scopeOverrides,
    },
    tier: tier ?? 1,
    budget: {
      wall_seconds: wall ?? 60,
      ...(tokens !== undefined ? { token_limit: tokens } : {}),
      ...(cost !== undefined ? { cost_cap: cost } : {}),
    },
    expires_at: expiresAt ?? '2026-04-27T10:00:00.000Z',
    envelope_hash: '',
  };
  env.envelope_hash = computeEnvelopeHash(env);
  return env;
}

describe('isEnvelopeSubset', () => {
  it('child equal to parent is a valid subset', () => {
    expect(isEnvelopeSubset(envOf({}), envOf({})).ok).toBe(true);
  });

  it('rejects child with raw_connector outside parent', () => {
    const parent = envOf({ raw_connectors: ['telegram'] });
    const child = envOf({ raw_connectors: ['telegram', 'slack'] });
    expect(isEnvelopeSubset(child, parent)).toEqual({
      ok: false,
      reason: 'raw_connectors_not_subset',
    });
  });

  it('rejects child with project_ref outside parent', () => {
    const parent = envOf({ project_refs: [{ kind: 'project', id: '/A' }] });
    const child = envOf({
      project_refs: [
        { kind: 'project', id: '/A' },
        { kind: 'project', id: '/B' },
      ],
    });
    expect(isEnvelopeSubset(child, parent)).toEqual({
      ok: false,
      reason: 'project_refs_not_subset',
    });
  });

  it('rejects child with memory_scope outside parent', () => {
    const parent = envOf({ memory_scopes: [{ kind: 'project', id: '/A' }] });
    const child = envOf({
      memory_scopes: [
        { kind: 'project', id: '/A' },
        { kind: 'channel', id: 'telegram:tg:2' },
      ],
    });
    expect(isEnvelopeSubset(child, parent)).toEqual({
      ok: false,
      reason: 'memory_scopes_not_subset',
    });
  });

  it('rejects child with destination outside parent', () => {
    const parent = envOf({ allowed_destinations: [{ kind: 'telegram', id: 'tg:1' }] });
    const child = envOf({
      allowed_destinations: [
        { kind: 'telegram', id: 'tg:1' },
        { kind: 'telegram', id: 'tg:OTHER' },
      ],
    });
    expect(isEnvelopeSubset(child, parent)).toEqual({
      ok: false,
      reason: 'destinations_not_subset',
    });
  });

  it('rejects child with empty destination id', () => {
    const parent = envOf({ allowed_destinations: [{ kind: 'telegram', id: '' }] });
    const child = envOf({ allowed_destinations: [{ kind: 'telegram', id: '' }] });
    expect(isEnvelopeSubset(child, parent)).toEqual({
      ok: false,
      reason: 'destination_id_empty',
    });
  });

  it('rejects child with more privileged tier than parent', () => {
    const parent = envOf({ tier: 3 });
    const child = envOf({ tier: 1 });
    expect(isEnvelopeSubset(child, parent)).toEqual({
      ok: false,
      reason: 'tier_widened',
    });
  });

  it('rejects child expiry after parent expiry', () => {
    const parent = envOf({ expiresAt: '2026-04-27T10:00:00.000Z' });
    const child = envOf({ expiresAt: '2026-04-27T10:00:01.000Z' });
    expect(isEnvelopeSubset(child, parent)).toEqual({
      ok: false,
      reason: 'expiry_extended',
    });
  });

  it('rejects child eval_privileged escalation', () => {
    const parent = envOf({ eval_privileged: false });
    const child = envOf({ eval_privileged: true });
    expect(isEnvelopeSubset(child, parent)).toEqual({
      ok: false,
      reason: 'eval_privileged_escalation',
    });
  });

  it('rejects child as_of view that extends beyond bounded parent', () => {
    const parent = envOf({ as_of: '2026-04-27T10:00:00.000Z' });
    const child = envOf({ as_of: '2026-04-27T10:00:01.000Z' });
    expect(isEnvelopeSubset(child, parent)).toEqual({
      ok: false,
      reason: 'as_of_exceeds_parent',
    });
  });

  it('rejects unbounded child as_of when parent is bounded', () => {
    const parent = envOf({ as_of: '2026-04-27T10:00:00.000Z' });
    const child = envOf({});
    expect(isEnvelopeSubset(child, parent)).toEqual({
      ok: false,
      reason: 'as_of_exceeds_parent',
    });
  });

  it('rejects child with wall budget exceeding parent', () => {
    const parent = envOf({ wall: 60 });
    const child = envOf({ wall: 600 });
    expect(isEnvelopeSubset(child, parent)).toEqual({
      ok: false,
      reason: 'budget_exceeds_parent',
    });
  });

  it('rejects child with undefined token_limit when parent has one', () => {
    const parent = envOf({ tokens: 100_000 });
    const child = envOf({});
    expect(isEnvelopeSubset(child, parent)).toEqual({
      ok: false,
      reason: 'token_budget_undefined_but_parent_bounded',
    });
  });

  it('rejects child with undefined cost_cap when parent has one', () => {
    const parent = envOf({ cost: 5.0 });
    const child = envOf({});
    expect(isEnvelopeSubset(child, parent)).toEqual({
      ok: false,
      reason: 'cost_cap_undefined_but_parent_bounded',
    });
  });

  it('accepts child with strictly narrower scope', () => {
    const parent = envOf({
      raw_connectors: ['telegram', 'slack'],
      allowed_destinations: [
        { kind: 'telegram', id: 'tg:1' },
        { kind: 'slack', id: 'C123' },
      ],
      wall: 600,
    });
    const child = envOf({
      raw_connectors: ['telegram'],
      allowed_destinations: [{ kind: 'telegram', id: 'tg:1' }],
      wall: 60,
    });
    expect(isEnvelopeSubset(child, parent).ok).toBe(true);
  });

  it('parent with undefined token_limit and child with bounded token_limit is narrowing', () => {
    const parent = envOf({});
    const child = envOf({ tokens: 50_000 });
    expect(isEnvelopeSubset(child, parent).ok).toBe(true);
  });

  it('parent with undefined cost_cap and child with bounded cost_cap is narrowing', () => {
    const parent = envOf({});
    const child = envOf({ cost: 1.0 });
    expect(isEnvelopeSubset(child, parent).ok).toBe(true);
  });

  it('rejects child token_limit above bounded parent', () => {
    const parent = envOf({ tokens: 100 });
    const child = envOf({ tokens: 200 });
    expect(isEnvelopeSubset(child, parent)).toEqual({
      ok: false,
      reason: 'token_budget_exceeds_parent',
    });
  });
});
