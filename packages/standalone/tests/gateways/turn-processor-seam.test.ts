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

/**
 * A turn can end without ever reaching the model - the security path answers directly.
 * With run identity as optional fields on one flat shape, a caller cannot tell "no id
 * recorded" from "no run happened", and anything that later resolves a delivered claim
 * back to its evidence rests on exactly that distinction.
 */
describe('turn outcome is discriminated', () => {
  it('carries run identity on a completed turn', () => {
    const completed: ProcessingResult = {
      outcome: 'completed',
      response: 'here is where things stand',
      sessionId: 's1',
      injectedDecisions: [],
      duration: 12,
      modelRunId: 'run_1',
      sourceTurnId: 'turn_1',
      sourceMessageRef: 'telegram:chat-1:turn_1',
    };

    expect(completed.outcome).toBe('completed');
    if (completed.outcome === 'completed') {
      expect(completed.sourceMessageRef).toContain('turn_1');
    }
  });

  it('states why a blocked turn has no run instead of leaving it absent', () => {
    const blocked: ProcessingResult = {
      outcome: 'blocked',
      reason: 'security_block',
      response: 'refused',
      sessionId: 'security-block',
      injectedDecisions: [],
      duration: 1,
    };

    expect(blocked.outcome).toBe('blocked');
    if (blocked.outcome === 'blocked') {
      expect(blocked.reason).toBe('security_block');
    }
    // The discriminant is what makes this a compile-time question rather than a
    // runtime guess: run identity is not reachable on this branch at all.
    expect('modelRunId' in blocked).toBe(false);
  });

  it('keeps the original fields on both branches so existing callers are untouched', () => {
    const outcomes: ProcessingResult[] = [
      {
        outcome: 'completed',
        response: 'a',
        sessionId: 's',
        injectedDecisions: [],
        duration: 1,
        modelRunId: null,
        sourceTurnId: 't',
        sourceMessageRef: 'r',
      },
      {
        outcome: 'blocked',
        reason: 'security_block',
        response: 'b',
        sessionId: 's',
        injectedDecisions: [],
        duration: 1,
      },
    ];

    for (const outcome of outcomes) {
      expect(typeof outcome.response).toBe('string');
      expect(typeof outcome.duration).toBe('number');
    }
  });
});
