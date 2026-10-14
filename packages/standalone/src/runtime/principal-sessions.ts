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

/** A serial chain for one principal's complete deliveries and host changes. */
export function createSerialTurnChain() {
  const queue: Array<{ work: () => Promise<void>; priority: boolean }> = [];
  const pending = new Set<Promise<unknown>>();
  let running = false;
  let holds = 0;
  let current: Promise<void> = Promise.resolve();
  let directoryCurrent: Promise<void> = Promise.resolve();
  let releaseDirectoryWait = () => {};
  const pump = () => {
    if (running || holds || !queue.length) return;
    running = true;
    const { work } = queue.shift()!;
    let release!: () => void;
    directoryCurrent = new Promise<void>((resolve) => {
      release = resolve;
    });
    releaseDirectoryWait = release;
    current = work().finally(() => {
      release();
      running = false;
      pump();
    });
  };
  const add = <T>(
    execute: () => Promise<T>,
    position: 'tail' | 'next' | 'afterCurrent'
  ): Promise<T> => {
    const result = new Promise<T>((resolve, reject) => {
      const work = async () => {
        try {
          resolve(await execute());
        } catch (error) {
          reject(error);
        }
      };
      const entry = { work, priority: position !== 'tail' };
      if (position === 'next') queue.unshift(entry);
      else if (position === 'afterCurrent') {
        const firstTurn = queue.findIndex((item) => !item.priority);
        queue.splice(firstTurn === -1 ? queue.length : firstTurn, 0, entry);
      } else queue.push(entry);
      pump();
    });
    pending.add(result);
    void result.then(
      () => pending.delete(result),
      () => pending.delete(result)
    );
    return result;
  };
  return Object.assign(<T>(execute: () => Promise<T>) => add(execute, 'tail'), {
    // P9 settlement jobs take the next member slot once the confirming turn releases its hold.
    next: <T>(execute: () => Promise<T>) => add(execute, 'next'),
    // Host changes retain arrival order but run before native turns waiting for this principal.
    afterCurrent: <T>(execute: () => Promise<T>) => add(execute, 'afterCurrent'),
    isBusy: () => running || holds > 0 || queue.length > 0,
    current: () => current,
    directoryCurrent: () => directoryCurrent,
    // A host job whose native writers are retired can keep its principal reservation while
    // letting unrelated member directory work pass its upload/delivery wait.
    releaseDirectoryWait: () => releaseDirectoryWait(),
    idle: async () => {
      while (pending.size) await Promise.allSettled([...pending]);
    },
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
  // Keep the chain when a session is retired/recreated: its cancelled waiters and host jobs
  // must finish before the replacement session accepts a turn for the same principal.
  const chains = new Map<string, ReturnType<typeof createSerialTurnChain>>();
  const directoryChanges = createSerialTurnChain();
  const releases = new Map<string, () => void>();
  let exclusiveCount = 0;
  const turnChain = (id: string) => {
    let chain = chains.get(id);
    if (!chain) {
      chains.set(id, (chain = createSerialTurnChain()));
      if (exclusiveCount && id !== ownerPrincipalId) releases.set(id, chain.hold());
    }
    return chain;
  };
  // Enrollment and serving create new member paths; suspend/offboard set paths aside in
  // .retired- archives; resume sets residual paths aside before creating a fresh environment.
  // Hold member chains and drain their current work, including newly seen members. The common
  // session denies both member roots wholesale, so it keeps running through these changes.
  const exclusive = <T>(execute: () => Promise<T>): Promise<T> => {
    if (exclusiveCount++ === 0)
      for (const [id, chain] of chains) if (id !== ownerPrincipalId) releases.set(id, chain.hold());
    const running = [...chains]
      .filter(([id]) => id !== ownerPrincipalId)
      .map(([, chain]) => chain.directoryCurrent());
    return directoryChanges(async () => {
      try {
        await Promise.all(running);
        return await execute();
      } finally {
        if (--exclusiveCount === 0) {
          const held = [...releases.values()];
          releases.clear();
          held.forEach((release) => release());
        }
      }
    });
  };
  const get = (id: string): SessionEntry => {
    const entry = entries.get(id);
    if (!entry) throw new Error(`Principal session is not served: ${id}`);
    return entry;
  };
  const forKey = (key: string) => {
    if (key === 'owner:runtime' || key === 'owner:replay') return get(ownerPrincipalId);
    for (const [id, entry] of entries)
      if (
        key === `member:${id}:runtime` ||
        key.startsWith(`member:${id}:job:`) ||
        key.startsWith(`member:${id}:notice:`)
      )
        return entry;
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
    exclusive,
    idle: async () => {
      await Promise.all([
        directoryChanges.idle(),
        ...[...chains.values()].map((chain) => chain.idle()),
      ]);
    },
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
