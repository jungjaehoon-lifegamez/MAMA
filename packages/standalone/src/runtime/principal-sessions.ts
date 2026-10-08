import type { NativeSessionHandle, StimulusDelivery } from '@jungjaehoon/mama-core/runtime/runtime';
import type { NativeSessionRequest, NativeSession } from './native-session.js';
import type { ReplayClockDelivery } from './stimulus-delivery.js';

interface SessionEntry {
  native: NativeSessionHandle & Partial<Pick<NativeSession, 'callAction'>>;
  delivery: ReplayClockDelivery;
}

/** One serial chain for complete owner/member turns; session state stays in each delivery. */
export function createSerialTurnChain() {
  let tail = Promise.resolve();
  return async <T>(execute: () => Promise<T>): Promise<T> => {
    const previous = tail;
    let release!: () => void;
    tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await execute();
    } finally {
      release();
    }
  };
}

export function createPrincipalSessions(ownerPrincipalId: string) {
  const entries = new Map<string, SessionEntry>();
  const turnChain = createSerialTurnChain();
  const get = (id: string): SessionEntry => {
    const entry = entries.get(id);
    if (!entry) throw new Error(`Principal session is not served: ${id}`);
    return entry;
  };
  const forKey = (key: string) => {
    if (key === 'owner:runtime' || key === 'owner:replay') return get(ownerPrincipalId);
    for (const [id, entry] of entries) if (key === `member:${id}:runtime`) return entry;
    throw new Error(`Principal session key is not served: ${key}`);
  };
  const native: NativeSessionHandle = {
    runTurn: (content, request) => {
      // This value is set by delivery from the claimed mailbox row, never by model input.
      const principalId = (request as NativeSessionRequest & { principalId: string }).principalId;
      const session = get(principalId).native;
      if (!session.runTurn) throw new Error(`Principal ${principalId} has no native turn port`);
      return session.runTurn(content, request);
    },
    steer: (content, target, key) => {
      const session = forKey(key).native;
      if (!session.steer) throw new Error(`Principal session ${key} has no steering port`);
      return session.steer(content, target, key);
    },
    resetSession: async (key) => {
      const session = forKey(key).native;
      if (!session.resetSession) throw new Error(`Principal session ${key} has no reset port`);
      await session.resetSession(key);
    },
    stop: async () => {
      const results = await Promise.allSettled(
        [...entries.values()].map((entry) => entry.native.stop())
      );
      const failures = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
      if (failures.length)
        throw new AggregateError(
          failures.map((r) => r.reason),
          'Principal session shutdown failed'
        );
    },
  };
  const delivery: StimulusDelivery = {
    prefer: ['owner_message'],
    deliver: (row, context) =>
      get(row.principalId).delivery.deliver!(row, {
        ...context,
        run: (content, request) =>
          context.run(content, {
            ...request,
            principalId: row.principalId,
          } as NativeSessionRequest),
      }),
    reconcile: (row) => get(row.principalId).delivery.reconcile!(row),
    onUncertain: (row, reason) => get(row.principalId).delivery.onUncertain?.(row, reason),
    onDead: (row, reason) => get(row.principalId).delivery.onDead?.(row, reason),
  };
  return {
    native,
    delivery,
    turnChain,
    get,
    add: (id: string, entry: SessionEntry) => {
      if (entries.has(id)) throw new Error(`Principal session already served: ${id}`);
      entries.set(id, entry);
    },
    replaySourceEndMs: (id: string) => get(id).delivery.getReplaySourceEndMs(),
  };
}
