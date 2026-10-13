import { createStimulusDelivery } from '../../src/runtime/stimulus-delivery.js';
import { createTimeZoneSetting } from '../../src/runtime/timezone.js';
import { expect, it, vi } from 'vitest';
import {
  createSerialTurnChain,
  createPrincipalSessions,
} from '../../src/runtime/principal-sessions.js';

it('runs complete deliveries concurrently across principals and routes each claimed principal to its native session', async () => {
  const events: string[] = [];
  const sessions = createPrincipalSessions('owner');
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  for (const id of ['owner', 'fixture-member'])
    sessions.add(id, {
      native: {
        stop: async () => {
          events.push(`stop:${id}`);
        },
        runTurn: async () => {
          events.push(`start:${id}`);
          if (id === 'owner') await gate;
          events.push(`end:${id}`);
          return { response: id } as never;
        },
      },
      delivery: createStimulusDelivery({
        backend: 'codex',
        timeZone: createTimeZoneSetting('UTC'),
        turnChain: sessions.turnChain(id),
      }),
    });
  const run = async (_c: unknown, request: unknown) =>
    sessions.native.runTurn!([], request as never);
  const owner = sessions.delivery.deliver!(
    {
      principalId: 'owner',
      kind: 'owner_message',
      stimulusId: 'fixture:owner',
      occurredAt: 1,
      payload: { text: 'owner' },
      refs: [],
    } as never,
    { run } as never
  );
  const member = sessions.delivery.deliver!(
    {
      principalId: 'fixture-member',
      kind: 'owner_message',
      stimulusId: 'fixture:member',
      occurredAt: 1,
      payload: { text: 'member' },
      refs: [],
    } as never,
    { run } as never
  );
  await member;
  expect(events).toEqual(['start:owner', 'start:fixture-member', 'end:fixture-member']);
  expect(sessions.replaySourceEndMs('fixture-member')).toBeUndefined();
  release();
  await Promise.all([owner, member]);
  expect(events).toEqual([
    'start:owner',
    'start:fixture-member',
    'end:fixture-member',
    'end:owner',
  ]);
  await sessions.native.stop();
  expect(events.slice(-2)).toEqual(['stop:owner', 'stop:fixture-member']);
});

it('reports a parked row of a principal it no longer serves', async () => {
  const reported: string[] = [];
  const sessions = createPrincipalSessions('owner', {
    onUncertain: (row, reason) => {
      reported.push(`uncertain ${row.principalId} ${reason}`);
    },
    onDead: (row, reason) => {
      reported.push(`dead ${row.principalId} ${reason}`);
    },
  });
  await sessions.delivery.onUncertain!({ principalId: 'fixture-gone' } as never, 'interrupted');
  await sessions.delivery.onDead!({ principalId: 'fixture-gone' } as never, 'not served');
  expect(reported).toEqual(['uncertain fixture-gone interrupted', 'dead fixture-gone not served']);
});

it('holds queued turns until settlement and lets the host job take the next slot', async () => {
  const chain = createSerialTurnChain();
  const events: string[] = [];
  let finish!: () => void;
  const gate = new Promise<void>((r) => {
    finish = r;
  });
  const active = chain(async () => {
    events.push('turn');
    await gate;
  });
  await Promise.resolve();
  const release = chain.hold();
  const queued = chain(async () => {
    events.push('queued');
  });
  finish();
  await active;
  expect(events).toEqual(['turn']);
  const job = chain.next(async () => {
    events.push('host');
  });
  release();
  await Promise.all([queued, job]);
  expect(events).toEqual(['turn', 'host', 'queued']);
});

it('drains running work, serializes exclusive changes and holds even newly seen principals until failure releases them', async () => {
  const sessions = createPrincipalSessions('owner');
  const events: string[] = [];
  let finishTurn!: () => void;
  let finishChange!: () => void;
  const turnGate = new Promise<void>((resolve) => {
    finishTurn = resolve;
  });
  const changeGate = new Promise<void>((resolve) => {
    finishChange = resolve;
  });
  const running = sessions.turnChain('fixture-first')(async () => {
    events.push('turn');
    await turnGate;
  });
  const change = sessions.exclusive(async () => {
    events.push('change');
    await changeGate;
    throw new Error('fixture change failed');
  });
  const failed = expect(change).rejects.toThrow('fixture change failed');
  const second = sessions.exclusive(async () => {
    events.push('second change');
  });
  const queued = sessions.turnChain('fixture-first')(async () => {
    events.push('queued');
  });
  const newPrincipal = sessions.turnChain('fixture-new')(async () => {
    events.push('new');
  });
  try {
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(events).toEqual(['turn']);
    finishTurn();
    await running;
    await vi.waitFor(() => expect(events).toEqual(['turn', 'change']));
    finishChange();
    await Promise.all([failed, second, queued, newPrincipal, sessions.idle()]);
    expect(events).toEqual(['turn', 'change', 'second change', 'queued', 'new']);
  } finally {
    finishTurn();
    finishChange();
  }
});

it('keeps the common chain running, including when first created during a directory change', async () => {
  const sessions = createPrincipalSessions('common');
  let finish!: () => void;
  const gate = new Promise<void>((resolve) => (finish = resolve));
  const change = sessions.exclusive(async () => {
    await gate;
  });
  try {
    let ran = false;
    const common = sessions.turnChain('common')(async () => {
      ran = true;
    });
    await vi.waitFor(() => expect(ran).toBe(true));
    await common;
  } finally {
    finish();
    await change;
  }
});
