import {
  StimulusQuarantine,
  type NativeSessionHandle,
  type StimulusDelivery,
} from '@jungjaehoon/mama-core/runtime/runtime';
import type { NativeSessionRequest, NativeSession } from './native-session.js';
import type { ReplayClockDelivery } from './stimulus-delivery.js';

interface SessionEntry {
  native: NativeSessionHandle & Partial<Pick<NativeSession, 'callAction'>>;
  delivery: ReplayClockDelivery;
}

/** One serial chain for complete owner/member turns; session state stays in each delivery. */
export function createSerialTurnChain() {
  const queue: Array<() => Promise<void>> = [];
  let running = false;
  let holds = 0;
  const pump = () => {
    if (running || holds || !queue.length) return;
    running = true;
    const work = queue.shift()!;
    void work().finally(() => {
      running = false;
      pump();
    });
  };
  const add = <T>(execute: () => Promise<T>, next: boolean): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const work = async () => {
        try {
          resolve(await execute());
        } catch (error) {
          reject(error);
        }
      };
      if (next) queue.unshift(work);
      else queue.push(work);
      pump();
    });
  return Object.assign(<T>(execute: () => Promise<T>) => add(execute, false), {
    next: <T>(execute: () => Promise<T>) => add(execute, true),
    hold: () => {
      holds++;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        holds--;
        pump();
      };
    },
  });
}

export function createPrincipalSessions(
  ownerPrincipalId: string,
  unserved: Pick<StimulusDelivery, 'onUncertain' | 'onDead'> = {},
  canRun: (principalId: string) => boolean = () => true
) {
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
      if (!canRun(principalId))
        throw new StimulusQuarantine('Queued input cancelled by host: member_erase');
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
    // Core parks a row whose principal is no longer served; its report must not need a session.
    onUncertain: (row, reason) =>
      (entries.get(row.principalId)?.delivery ?? unserved).onUncertain?.(row, reason),
    onDead: (row, reason) =>
      (entries.get(row.principalId)?.delivery ?? unserved).onDead?.(row, reason),
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
    remove: (id: string) => {
      if (id === ownerPrincipalId) throw new Error('The owner session is never removed');
      entries.delete(id);
    },
    replaySourceEndMs: (id: string) => get(id).delivery.getReplaySourceEndMs(),
  };
}
