/**
 * The read mirror: a run allowed to read a channel's raw events may recall
 * the memories extracted from it - as an ENFORCEMENT-LAYER allowance, never
 * issued into the envelope. Issuing it re-opened per-channel raw isolation
 * (envelope channel scopes double as the raw-narrowing input) and made
 * mama_save bind every memory to every granted channel (PR #217 review,
 * blocking #2/#3). These tests pin both halves: what the mirror grants, and
 * what it must never touch.
 */
import { describe, it, expect, vi } from 'vitest';
import { mirrorReadScopes, writeEligiblePacketScopes } from '../../src/evidence/read.js';
import { EnvelopeEnforcer } from '../../src/envelope/enforcer.js';
import { GatewayToolExecutor } from '../../src/agent/gateway-tool-executor.js';
import type { MAMAApiInterface } from '../../src/agent/types.js';
import { makeSignedEnvelope } from '../envelope/fixtures.js';

const GRANT = {
  trello: ['board-alpha', 'board-beta'],
  telegram: ['chat-a', 'chat-b', 'group-c'],
  gmail: ['inbox'],
};

function envelopeWith(scope: {
  raw_connectors: string[];
  memory_scopes: Array<{ kind: 'global' | 'user' | 'channel' | 'project'; id: string }>;
}) {
  return {
    scope: {
      project_refs: [],
      allowed_destinations: [],
      ...scope,
    },
  };
}

describe('mirrorReadScopes', () => {
  it('mirrors the granted channels of connectors the envelope may read raw', () => {
    const scopes = mirrorReadScopes(
      envelopeWith({
        raw_connectors: ['trello'],
        memory_scopes: [{ kind: 'global', id: 'system' }],
      }),
      GRANT
    );
    expect(scopes).toEqual([
      { kind: 'channel', id: 'trello:board-alpha' },
      { kind: 'channel', id: 'trello:board-beta' },
    ]);
  });

  it('a connector the envelope narrows with its own channel scope is NOT mirrored', () => {
    // The reviewer's probe: a telegram chat envelope carries channel:telegram:chat-a;
    // mirroring telegram would hand chat-a every sibling chat's memories AND
    // (via narrowGrantToEnvelope) its raw excerpts. Isolation wins.
    const scopes = mirrorReadScopes(
      envelopeWith({
        raw_connectors: ['telegram', 'trello'],
        memory_scopes: [
          { kind: 'channel', id: 'telegram:chat-a' },
          { kind: 'global', id: 'system' },
        ],
      }),
      GRANT
    );
    expect(scopes).toEqual([
      { kind: 'channel', id: 'trello:board-alpha' },
      { kind: 'channel', id: 'trello:board-beta' },
    ]);
  });

  it('a temporal binding scope suppresses its connector - strictness is automatic', () => {
    const scopes = mirrorReadScopes(
      envelopeWith({
        raw_connectors: ['trello'],
        memory_scopes: [{ kind: 'channel', id: 'trello:board-alpha' }],
      }),
      GRANT
    );
    expect(scopes).toEqual([]);
  });

  it('no raw connectors, no mirror - the S1 conductor stays inbox-only', () => {
    expect(
      mirrorReadScopes(
        envelopeWith({
          raw_connectors: [],
          memory_scopes: [{ kind: 'channel', id: 'conductor:conductor' }],
        }),
        GRANT
      )
    ).toEqual([]);
  });

  it('a synthetic lane identity scope does not suppress real connectors', () => {
    const scopes = mirrorReadScopes(
      envelopeWith({
        raw_connectors: ['gmail'],
        memory_scopes: [{ kind: 'channel', id: 'operator:worker:board' }],
      }),
      GRANT
    );
    expect(scopes).toEqual([{ kind: 'channel', id: 'gmail:inbox' }]);
  });
});

describe('EnvelopeEnforcer with the read mirror', () => {
  const enforcer = new EnvelopeEnforcer();
  const envelope = makeSignedEnvelope({
    agent_id: 'workorder-board',
    instance_id: 'mirror-read-test',
    scope: {
      project_refs: [],
      raw_connectors: ['trello'],
      memory_scopes: [{ kind: 'global', id: 'system' }],
      allowed_destinations: [],
    },
  });
  const mirror = mirrorReadScopes(envelope, GRANT);

  it('a READ for a mirrored channel passes', () => {
    expect(() =>
      enforcer.check(
        envelope,
        'mama_search',
        { query: 'q', scopes: [{ kind: 'channel', id: 'trello:board-alpha' }] },
        { readScopeMirror: mirror }
      )
    ).not.toThrow();
  });

  it('a READ outside grant and envelope still dies', () => {
    expect(() =>
      enforcer.check(
        envelope,
        'mama_search',
        { query: 'q', scopes: [{ kind: 'channel', id: 'gmail:inbox' }] },
        { readScopeMirror: mirror }
      )
    ).toThrow(/memory_scope_out_of_scope|outside/);
  });

  it('mama_save NEVER widens - the mirror is read-only authority', () => {
    // A save binds permanently (memory_scope_bindings); the mirror must not
    // let a run write into channels the envelope did not name.
    expect(() =>
      enforcer.check(
        envelope,
        'mama_save',
        {
          type: 'decision',
          topic: 't',
          decision: 'd',
          reasoning: 'r',
          scopes: [{ kind: 'channel', id: 'trello:board-alpha' }],
        },
        { readScopeMirror: mirror }
      )
    ).toThrow(/outside/);
  });

  it('without the option the enforcer behaves exactly as before', () => {
    expect(() =>
      enforcer.check(envelope, 'mama_search', {
        query: 'q',
        scopes: [{ kind: 'channel', id: 'trello:board-alpha' }],
      })
    ).toThrow(/outside/);
  });
});

describe('executor scope defaulting under the mirror', () => {
  const envelope = makeSignedEnvelope({
    agent_id: 'workorder-board',
    instance_id: 'mirror-defaulting',
    scope: {
      project_refs: [],
      raw_connectors: ['trello'],
      memory_scopes: [{ kind: 'global', id: 'system' }],
      allowed_destinations: [],
    },
  });

  function makeExecutor(api: Record<string, unknown>) {
    return new GatewayToolExecutor({
      mamaApi: {
        appendToolTrace: vi.fn().mockResolvedValue(undefined),
        beginModelRun: vi.fn().mockResolvedValue({ model_run_id: 'mr_1' }),
        commitModelRun: vi.fn().mockResolvedValue({ model_run_id: 'mr_1' }),
        failModelRun: vi.fn().mockResolvedValue({ model_run_id: 'mr_1' }),
        ...api,
      } as unknown as MAMAApiInterface,
      channelGrantProvider: () => GRANT,
    });
  }

  const ctx = {
    agentId: 'workorder-board',
    source: 'watch',
    channelId: 'c1',
    executionSurface: 'direct' as const,
    envelope,
    modelRunId: 'mr_1',
  };

  it('a scope-less READ defaults to identity PLUS the mirror', async () => {
    // The search handler forwards scopes to api.suggest - capture there.
    const suggest = vi.fn().mockResolvedValue({ results: [] });
    const executor = makeExecutor({ suggest, listDecisions: vi.fn().mockResolvedValue([]) });
    await executor.execute('mama_search', { query: 'q' } as never, ctx).catch(() => undefined);
    const passed = suggest.mock.calls[0]?.[1] as {
      scopes?: Array<{ kind: string; id: string }>;
    };
    const scopes = Array.isArray(passed?.scopes) ? passed.scopes : [];
    expect(scopes).toContainEqual({ kind: 'channel', id: 'trello:board-alpha' });
    expect(scopes).toContainEqual({ kind: 'global', id: 'system' });
  });

  it('a scope-less mama_recall reaches the api with identity + mirror - not denied by its own gate', async () => {
    // Re-review blocking #5: the executor injected identity+mirror, then
    // resolveMamaRecallScopes rejected the mirror against the envelope alone
    // - recall returned memory_scope_denied on every configured daemon.
    const recallMemory = vi.fn().mockResolvedValue({ success: true, results: [] });
    const executor = makeExecutor({ recallMemory });
    const result = (await executor
      .execute('mama_recall', { query: 'q' } as never, ctx)
      .catch((error) => ({ success: false, error: String(error) }))) as {
      success?: boolean;
      code?: string;
    };
    expect(result?.code).not.toBe('memory_scope_denied');
    expect(recallMemory).toHaveBeenCalled();
    const passed = recallMemory.mock.calls[0]?.[1] as {
      scopes?: Array<{ kind: string; id: string }>;
    };
    expect(passed?.scopes ?? []).toContainEqual({ kind: 'channel', id: 'trello:board-alpha' });
  });

  it('a scope-less mama_save defaults to identity ONLY - never the mirror', async () => {
    const save = vi.fn().mockResolvedValue({ success: true, id: 'd1' });
    const executor = makeExecutor({ save });
    await executor
      .execute(
        'mama_save',
        { type: 'decision', topic: 't', decision: 'd', reasoning: 'r' } as never,
        ctx
      )
      .catch(() => undefined);
    const passed = save.mock.calls[0]?.[0] as { scopes?: Array<{ kind: string; id: string }> };
    const scopes = Array.isArray(passed?.scopes) ? passed.scopes : [];
    expect(scopes).toEqual([{ kind: 'global', id: 'system' }]);
  });
});

describe('writeEligiblePacketScopes - the packet back door stays shut', () => {
  it('strips mirror-widened packet scopes down to what the envelope names', () => {
    // Re-review blocking #4: the compile boundary defaults to the read
    // allowance, so packet.scopes can carry mirror channels; a packet-backed
    // mama_save delegates its scopes from the packet with no enforcer check.
    // Only the envelope-named subset may become a permanent write binding.
    expect(
      writeEligiblePacketScopes(
        [
          { kind: 'channel', id: 'operator:worker:board' },
          { kind: 'channel', id: 'trello:board-alpha' }, // mirror-only
          { kind: 'global', id: 'system' },
        ],
        [
          { kind: 'channel', id: 'operator:worker:board' },
          { kind: 'global', id: 'system' },
        ]
      )
    ).toEqual([
      { kind: 'channel', id: 'operator:worker:board' },
      { kind: 'global', id: 'system' },
    ]);
  });

  it('is the identity for pre-mirror packets (packet subset of envelope)', () => {
    const scopes = [{ kind: 'channel' as const, id: 'operator:worker:board' }];
    expect(writeEligiblePacketScopes(scopes, scopes)).toEqual(scopes);
  });
});
