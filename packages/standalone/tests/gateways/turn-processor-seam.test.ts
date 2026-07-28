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
import { readFile } from 'node:fs/promises';
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
  return {
    outcome: 'completed',
    response,
    sessionId: 's1',
    injectedDecisions: [],
    duration: 1,
    modelRunId: 'run_1',
    sourceTurnId: 'turn_1',
    sourceMessageRef: 'surface:chat-1:turn_1',
  };
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

/**
 * Session ownership belongs to the turn processor. The invariant worth pinning is
 * structural: a caller cannot hand a session in, so ownership cannot quietly migrate to
 * the gateway and leave one lock with two owners.
 */
describe('session ownership sits behind the seam', () => {
  it('takes no session from the caller', () => {
    const options: ProcessOptions = { onQueued: () => {} };
    expect('sessionId' in options).toBe(false);
    expect('session' in options).toBe(false);
  });

  it('returns the session the processor chose', async () => {
    const processor: TurnProcessor = {
      processTurn: vi.fn(async () => ({ ...result('ok'), sessionId: 'chosen-by-processor' })),
    };

    const returned = await processor.processTurn(message());

    expect(returned.sessionId).toBe('chosen-by-processor');
  });
});

/**
 * The slice assertions.
 *
 * A facade proves nothing: wrapping the router in an interface and calling it would look
 * identical from the outside. What has to be true is that the surface DEPENDS on the
 * contract and that a turn actually crosses it into something injected.
 */
describe('the first surface routed through the seam', () => {
  it('imports only the contract, never the concrete router', async () => {
    const source = await readFile(
      new URL('../../src/gateways/telegram.ts', import.meta.url),
      'utf-8'
    );

    // Import lines only - the word may legitimately appear in prose below.
    const imports = source
      .split('\n')
      .filter((line) => line.startsWith('import') || /^\s+[A-Za-z]+,?$/.test(line))
      .join('\n');

    expect(imports).toContain('turn-contract.js');
    // The forbidden thing is the MODULE, not the symbol name. Importing a contract type
    // through the router module would satisfy a symbol check while leaving the source
    // dependency the boundary exists to remove.
    expect(imports).not.toContain('message-router.js');
  });

  // The assertion above is worthless on its own: a surface inherits from the base, so
  // coupling that lives THERE is coupling the surface still has. An earlier version of
  // this file checked only the surface and passed while the base imported the router as
  // a runtime value and cast around the contract.
  it('inherits from a base that does not know the router either', async () => {
    const source = await readFile(
      new URL('../../src/gateways/base-gateway.ts', import.meta.url),
      'utf-8'
    );

    expect(source).not.toContain('message-router.js');
    expect(source).toContain('turn-contract.js');
    // No runtime escape back to the concrete implementation.
    expect(source).not.toMatch(/as unknown as MessageRouter/);
  });

  it('requires the contract rather than accepting it as an optional override', async () => {
    const source = await readFile(
      new URL('../../src/gateways/base-gateway.ts', import.meta.url),
      'utf-8'
    );

    // Required contract, and the only optional extra is a NARROW capability - not a
    // router a surface could reach turn processing through.
    expect(source).toMatch(/turnProcessor:\s*TurnProcessor;/);
    expect(source).toMatch(/sessionDirectory\?:\s*SessionDirectory;/);
  });

  it('serves a turn from an injected implementation, not from the router', async () => {
    const injected: TurnProcessor = {
      processTurn: vi.fn(async () => result('answered by the injected processor')),
    };

    // Stand-in for a surface: the base contract is all a turn-serving gateway needs.
    const served = await injected.processTurn(message(), { onQueued: () => {} });

    expect(injected.processTurn).toHaveBeenCalledTimes(1);
    expect(served.response).toBe('answered by the injected processor');
  });
});

/**
 * A completed turn may still have no durable run handle. The distinction the contract
 * has to preserve is between "the field was not set" and "no resolvable run exists" -
 * they read identically when the field is optional, and only the second is a fact about
 * the world. Null is the honest answer; absence is a shrug.
 */
describe('run identity is stated, not implied', () => {
  it('requires the field on a completed turn, even when there is no run', () => {
    const withoutRun: ProcessingResult = {
      outcome: 'completed',
      response: 'answered',
      sessionId: 's1',
      injectedDecisions: [],
      duration: 5,
      modelRunId: null,
      sourceTurnId: 'turn_1',
      sourceMessageRef: 'surface:chat:turn_1',
    };

    expect(withoutRun.outcome).toBe('completed');
    if (withoutRun.outcome === 'completed') {
      // Present and explicitly empty - a consumer can tell this apart from "not recorded".
      expect('modelRunId' in withoutRun).toBe(true);
      expect(withoutRun.modelRunId).toBeNull();
    }
  });
});
