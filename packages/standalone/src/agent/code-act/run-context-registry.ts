import { randomBytes as cryptoRandomBytes, randomUUID } from 'crypto';

import { parseEnvelopeExpiresAt } from '../../envelope/expiry.js';
import type { GatewayToolExecutionContext } from '../types.js';

const PROCESS_CONTEXT_KEY_BYTES = 32;
const PROCESS_CONTEXT_KEY_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const DEFAULT_LEGACY_HARD_CAP_MS = 30 * 60 * 1_000;

type RandomBytes = (size: number) => Buffer;

export type RunContextRegistryErrorCode =
  | 'RUN_CONTEXT_KEY_INVALID'
  | 'RUN_CONTEXT_LEASE_CONFLICT'
  | 'RUN_CONTEXT_LEASE_EXPIRED';

export class RunContextRegistryError extends Error {
  constructor(
    public readonly code: RunContextRegistryErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'RunContextRegistryError';
  }
}

export function createProcessContextKey(randomBytes: RandomBytes = cryptoRandomBytes): string {
  const key = randomBytes(PROCESS_CONTEXT_KEY_BYTES).toString('base64url');
  if (!PROCESS_CONTEXT_KEY_PATTERN.test(key)) {
    throw new RunContextRegistryError(
      'RUN_CONTEXT_KEY_INVALID',
      'Process context key generation returned an invalid value'
    );
  }
  return key;
}

export function isProcessContextKey(value: unknown): value is string {
  return typeof value === 'string' && PROCESS_CONTEXT_KEY_PATTERN.test(value);
}

export interface AcquiredRunContext {
  context: GatewayToolExecutionContext;
  releasePin: () => void;
}

interface RunContextLease {
  leaseId: string;
  context: GatewayToolExecutionContext;
  expiresAt: number;
  activePins: number;
  closing: boolean;
  timer: ReturnType<typeof setTimeout>;
}

export interface RunContextRegistryOptions {
  now?: () => number;
  hardCapMs?: number;
  createLeaseId?: () => string;
}

export class RunContextRegistry {
  private readonly entries = new Map<string, RunContextLease>();
  private readonly now: () => number;
  private readonly hardCapMs: number;
  private readonly createLeaseId: () => string;

  constructor(options: RunContextRegistryOptions = {}) {
    this.now = options.now ?? Date.now;
    this.hardCapMs = options.hardCapMs ?? DEFAULT_LEGACY_HARD_CAP_MS;
    this.createLeaseId = options.createLeaseId ?? randomUUID;
  }

  register(contextKey: string, context: GatewayToolExecutionContext): string {
    this.assertContextKey(contextKey);
    const now = this.now();
    const current = this.entries.get(contextKey);
    if (current && !this.isExpired(current, now)) {
      throw new RunContextRegistryError(
        'RUN_CONTEXT_LEASE_CONFLICT',
        'A live run context lease already exists for this process generation'
      );
    }
    if (current) {
      this.beginClosing(contextKey, current);
      if (current.activePins > 0) {
        throw new RunContextRegistryError(
          'RUN_CONTEXT_LEASE_CONFLICT',
          'An expired run context lease is still draining active executions'
        );
      }
    }

    const expiresAt = context.envelope
      ? parseEnvelopeExpiresAt(context.envelope.expires_at)
      : now + this.hardCapMs;
    if (expiresAt <= now) {
      throw new RunContextRegistryError(
        'RUN_CONTEXT_LEASE_EXPIRED',
        'Cannot register an already-expired run context'
      );
    }

    const leaseId = this.createLeaseId();
    const lease: RunContextLease = {
      leaseId,
      context,
      expiresAt,
      activePins: 0,
      closing: false,
      timer: setTimeout(() => {
        const live = this.entries.get(contextKey);
        if (live?.leaseId !== leaseId) {
          return;
        }
        this.beginClosing(contextKey, live);
      }, expiresAt - now),
    };
    lease.timer.unref?.();
    this.entries.set(contextKey, lease);
    return leaseId;
  }

  acquire(contextKey: string): AcquiredRunContext | null {
    if (!isProcessContextKey(contextKey)) {
      return null;
    }
    const lease = this.entries.get(contextKey);
    if (!lease) {
      return null;
    }
    if (lease.closing || this.isExpired(lease, this.now())) {
      this.beginClosing(contextKey, lease);
      return null;
    }

    lease.activePins += 1;
    let released = false;
    return {
      context: lease.context,
      releasePin: () => {
        if (released) {
          return;
        }
        released = true;
        lease.activePins = Math.max(0, lease.activePins - 1);
        if (lease.closing && lease.activePins === 0) {
          this.removeIfCurrent(contextKey, lease);
        }
      },
    };
  }

  close(contextKey: string, leaseId: string): boolean {
    const lease = this.entries.get(contextKey);
    if (!lease || lease.leaseId !== leaseId) {
      return false;
    }
    this.beginClosing(contextKey, lease);
    return true;
  }

  has(contextKey: string): boolean {
    return this.entries.has(contextKey);
  }

  private assertContextKey(contextKey: string): void {
    if (!isProcessContextKey(contextKey)) {
      throw new RunContextRegistryError(
        'RUN_CONTEXT_KEY_INVALID',
        'Run context key must be a 32-byte base64url value'
      );
    }
  }

  private isExpired(lease: RunContextLease, now: number): boolean {
    return lease.expiresAt <= now;
  }

  private beginClosing(contextKey: string, lease: RunContextLease): void {
    if (!lease.closing) {
      lease.closing = true;
      clearTimeout(lease.timer);
    }
    if (lease.activePins === 0) {
      this.removeIfCurrent(contextKey, lease);
    }
  }

  private removeIfCurrent(contextKey: string, lease: RunContextLease): void {
    if (this.entries.get(contextKey) === lease) {
      clearTimeout(lease.timer);
      this.entries.delete(contextKey);
    }
  }
}

export const runContextRegistry = new RunContextRegistry();
