import { createStimulusDelivery } from '../../src/runtime/stimulus-delivery.js';
import { createTimeZoneSetting } from '../../src/runtime/timezone.js';
import { expect, it } from 'vitest';
import { createPrincipalSessions } from '../../src/runtime/principal-sessions.js';

it('serializes the whole delivery across principals and routes the claimed principal to its native session', async () => {
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
        turnChain: sessions.turnChain,
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
  await Promise.resolve();
  await Promise.resolve();
  expect(events).toEqual(['start:owner']);
  expect(sessions.replaySourceEndMs('fixture-member')).toBeUndefined();
  release();
  await Promise.all([owner, member]);
  expect(events).toEqual([
    'start:owner',
    'end:owner',
    'start:fixture-member',
    'end:fixture-member',
  ]);
  await sessions.native.stop();
  expect(events.slice(-2)).toEqual(['stop:owner', 'stop:fixture-member']);
});
