import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  RunContextRegistry,
  RunContextRegistryError,
  createProcessContextKey,
} from '../../src/agent/code-act/run-context-registry.js';
import type { GatewayToolExecutionContext } from '../../src/agent/types.js';

const NOW = Date.parse('2026-07-31T00:00:00.000Z');

function makeContext(expiresAt?: number): GatewayToolExecutionContext {
  return {
    agentId: 'workorder-temporal-7',
    source: 'telegram',
    channelId: 'owner-chat',
    executionSurface: 'model_tool',
    workorderAttemptId: 7,
    causeEventIds: ['event-1'],
    ...(expiresAt === undefined
      ? {}
      : {
          envelope: {
            agent_id: 'workorder-temporal-7',
            instance_id: 'env-7',
            source: 'telegram' as const,
            trigger_context: {},
            scope: {
              project_refs: [],
              raw_connectors: [],
              memory_scopes: [],
              allowed_destinations: [],
            },
            tier: 2 as const,
            budget: { wall_seconds: 60 },
            expires_at: new Date(expiresAt).toISOString(),
            envelope_hash: 'hash-7',
          },
        }),
  };
}

describe('S3 TG-03/TG-04: RunContextRegistry', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('creates a 43-character base64url key from 32 random bytes without deriving it from a route', () => {
    const randomBytes = vi.fn(() => Buffer.alloc(32, 0xff));

    const key = createProcessContextKey(randomBytes);

    expect(key).toBe('_'.repeat(42) + '8');
    expect(key).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(randomBytes).toHaveBeenCalledTimes(1);
    expect(randomBytes).toHaveBeenCalledWith(32);
  });

  it('registers the full context and keeps an acquired pin alive across close', () => {
    const registry = new RunContextRegistry({
      now: () => Date.now(),
      createLeaseId: () => 'lease-1',
    });
    const key = createProcessContextKey(() => Buffer.alloc(32, 1));
    const context = makeContext(NOW + 60_000);
    const leaseId = registry.register(key, context);

    const pin = registry.acquire(key);
    expect(pin?.context).toBe(context);
    expect(registry.close(key, leaseId)).toBe(true);
    expect(registry.acquire(key)).toBeNull();
    expect(registry.has(key)).toBe(true);

    pin?.releasePin();

    expect(registry.has(key)).toBe(false);
  });

  it('makes pin release idempotent', () => {
    const registry = new RunContextRegistry({ createLeaseId: () => 'lease-1' });
    const key = createProcessContextKey(() => Buffer.alloc(32, 2));
    const leaseId = registry.register(key, makeContext(NOW + 60_000));
    const pin = registry.acquire(key);

    registry.close(key, leaseId);
    pin?.releasePin();
    pin?.releasePin();

    expect(registry.has(key)).toBe(false);
  });

  it('rejects an active lease conflict without replacing the original principal', () => {
    const registry = new RunContextRegistry({ createLeaseId: () => 'lease-1' });
    const key = createProcessContextKey(() => Buffer.alloc(32, 3));
    const original = makeContext(NOW + 60_000);
    registry.register(key, original);

    expect(() => registry.register(key, makeContext(NOW + 120_000))).toThrowError(
      expect.objectContaining<Partial<RunContextRegistryError>>({
        code: 'RUN_CONTEXT_LEASE_CONFLICT',
      })
    );
    expect(registry.acquire(key)?.context).toBe(original);
  });

  it('uses envelope expiry as the lease deadline and drains an already acquired pin', () => {
    const registry = new RunContextRegistry({ createLeaseId: () => 'lease-1' });
    const key = createProcessContextKey(() => Buffer.alloc(32, 4));
    registry.register(key, makeContext(NOW + 1_000));
    const pin = registry.acquire(key);

    vi.advanceTimersByTime(1_001);

    expect(registry.acquire(key)).toBeNull();
    expect(registry.has(key)).toBe(true);
    pin?.releasePin();
    expect(registry.has(key)).toBe(false);
  });

  it('rejects re-registration while an expired lease still drains an active pin', () => {
    const registry = new RunContextRegistry({ createLeaseId: () => 'lease-1' });
    const key = createProcessContextKey(() => Buffer.alloc(32, 8));
    registry.register(key, makeContext(NOW + 1_000));
    const pin = registry.acquire(key);

    vi.advanceTimersByTime(1_001);

    expect(() => registry.register(key, makeContext(NOW + 120_000))).toThrowError(
      expect.objectContaining<Partial<RunContextRegistryError>>({
        code: 'RUN_CONTEXT_LEASE_CONFLICT',
      })
    );
    expect(registry.has(key)).toBe(true);
    pin?.releasePin();
    expect(registry.has(key)).toBe(false);
  });

  it('applies a 30-minute hard cap to legacy contexts without an envelope', () => {
    const registry = new RunContextRegistry({
      hardCapMs: 30 * 60 * 1_000,
      createLeaseId: () => 'lease-legacy',
    });
    const key = createProcessContextKey(() => Buffer.alloc(32, 5));
    registry.register(key, makeContext());

    vi.advanceTimersByTime(30 * 60 * 1_000 + 1);

    expect(registry.acquire(key)).toBeNull();
    expect(registry.has(key)).toBe(false);
  });

  it('does not let an old lease close a replacement registered under the same key', () => {
    let leaseSequence = 0;
    const registry = new RunContextRegistry({
      createLeaseId: () => `lease-${++leaseSequence}`,
    });
    const key = createProcessContextKey(() => Buffer.alloc(32, 6));
    const oldLease = registry.register(key, makeContext(NOW + 60_000));
    registry.close(key, oldLease);
    const replacement = makeContext(NOW + 120_000);
    const replacementLease = registry.register(key, replacement);

    expect(registry.close(key, oldLease)).toBe(false);
    expect(registry.acquire(key)?.context).toBe(replacement);
    expect(registry.close(key, replacementLease)).toBe(true);
  });

  it('rejects empty or malformed process keys and already-expired authority', () => {
    const registry = new RunContextRegistry({ createLeaseId: () => 'lease-1' });

    expect(() => registry.register('', makeContext())).toThrowError(
      expect.objectContaining<Partial<RunContextRegistryError>>({
        code: 'RUN_CONTEXT_KEY_INVALID',
      })
    );
    expect(() => registry.register('route-derived-key', makeContext())).toThrowError(
      expect.objectContaining<Partial<RunContextRegistryError>>({
        code: 'RUN_CONTEXT_KEY_INVALID',
      })
    );
    expect(() =>
      registry.register(
        createProcessContextKey(() => Buffer.alloc(32, 7)),
        makeContext(NOW - 1)
      )
    ).toThrowError(
      expect.objectContaining<Partial<RunContextRegistryError>>({
        code: 'RUN_CONTEXT_LEASE_EXPIRED',
      })
    );
  });
});
