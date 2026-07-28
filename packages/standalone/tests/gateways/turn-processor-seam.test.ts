/**
 * The turn seam.
 *
 * A gateway owns receive, normalization, progress display, delivery and its restart
 * ledger. Everything inward of the handoff - session locks, durable persistence, prompt
 * assembly, the model run - sits behind one callable boundary. Naming that boundary is
 * what lets a turn be routed somewhere other than the message router without touching the
 * gateway, and it is the first step toward one agent runtime instead of the several this
 * package carries.
 *
 * These tests pin the boundary itself, not an extra function call: the seam must be
 * injectable, the default must change nothing, and the router must satisfy the contract.
 */
import { describe, it, expect, vi } from 'vitest';
import { MessageRouter } from '../../src/gateways/message-router.js';
import type {
  ProcessingResult,
  ProcessOptions,
  TurnProcessor,
} from '../../src/gateways/message-router.js';
import type { NormalizedMessage } from '../../src/gateways/types.js';

function message(overrides: Partial<NormalizedMessage> = {}): NormalizedMessage {
  return {
    source: 'telegram',
    channelId: 'chat-1',
    userId: 'owner',
    text: 'what is open right now',
    ...overrides,
  } as NormalizedMessage;
}

function result(response: string): ProcessingResult {
  return { response, sessionId: 's1', injectedDecisions: [], duration: 1 };
}

describe('TurnProcessor contract', () => {
  it('is satisfied by the router, so the seam is a boundary and not a rewrite', () => {
    // Structural: MessageRouter declares `implements TurnProcessor`, so a compile-time
    // break here is the signal that the contract drifted from its only implementation.
    const processTurn = MessageRouter.prototype.processTurn;
    expect(typeof processTurn).toBe('function');
    expect(processTurn.length).toBeGreaterThanOrEqual(1);
  });

  it('delegates exactly once to the existing path, adding no behaviour of its own', async () => {
    const process = vi.fn(async () => result('answered'));
    const router = { process } as unknown as MessageRouter;

    const returned = await MessageRouter.prototype.processTurn.call(router, message(), undefined);

    expect(process).toHaveBeenCalledTimes(1);
    expect(returned.response).toBe('answered');
  });

  it('passes the caller options through untouched', async () => {
    const process = vi.fn(async () => result('ok'));
    const router = { process } as unknown as MessageRouter;
    const onQueued = vi.fn();
    const options: ProcessOptions = { onQueued };

    await MessageRouter.prototype.processTurn.call(router, message(), options);

    expect(process).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.any(String) }),
      options
    );
  });

  it('accepts an implementation that is not the router at all', async () => {
    // The point of the seam: a turn can be served by something else entirely. Without
    // this, "routing through an interface" would be an extra call and nothing more.
    const elsewhere: TurnProcessor = {
      processTurn: vi.fn(async () => result('served without the router')),
    };

    const returned = await elsewhere.processTurn(message());

    expect(returned.response).toBe('served without the router');
    expect(elsewhere.processTurn).toHaveBeenCalledTimes(1);
  });
});
