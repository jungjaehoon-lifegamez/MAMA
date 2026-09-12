import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { AgentContext } from '../../src/agent/types.js';
import type { Envelope } from '../../src/envelope/types.js';
import { OwnerEventInbox } from '../../src/operator/owner-event-inbox.js';
import { OwnerEventLoop } from '../../src/operator/owner-event-loop.js';
import { buildOwnerEventAgentContext } from '../../src/operator/owner-event-policy.js';
import { DEFAULT_ROLES } from '../../src/cli/config/types.js';
import { resolvePrivateConnectorPolicy } from '../../src/connectors/private-connector-policy.js';
import Database from '../../src/sqlite.js';
import { GatewayToolExecutor } from '../../src/agent/gateway-tool-executor.js';
import { makeSignedEnvelope } from '../envelope/fixtures.js';

const ownerContext: AgentContext = {
  source: 'owner-event',
  platform: 'cli',
  roleName: 'owner_console',
  principalId: 'principal-synthetic',
  role: {
    model: 'gpt-5.6-sol',
    allowedTools: ['task_update', 'registry_correct'],
    blockedTools: [],
    allowedPaths: [],
    systemControl: false,
    sensitiveAccess: false,
  },
  session: { sessionId: 'owner-runtime', channelId: 'owner-runtime', startedAt: new Date(0) },
  capabilities: ['task_update', 'registry_correct'],
  limitations: [],
  tier: 1,
  backend: 'codex',
};

describe('TG-05 immutable owner-event observation flow', () => {
  let dir = '';

  afterEach(() => {
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
      dir = '';
    }
  });

  it('requires and carries one authenticated owner principal for unattended work', () => {
    const input = {
      backend: 'codex' as const,
      model: 'gpt-5.6-sol',
      ownerRole: DEFAULT_ROLES.definitions.owner_console,
      privateConnectorPolicy: resolvePrivateConnectorPolicy({
        ok: true,
        config: {},
        enabledNames: [],
      }),
    };
    expect(() => buildOwnerEventAgentContext({ ...input, principalId: '' })).toThrow(
      /owner principal/i
    );
    expect(
      buildOwnerEventAgentContext({ ...input, principalId: 'principal-unattended-owner' })
        .principalId
    ).toBe('principal-unattended-owner');
  });

  it('reopens the inbox and hands the exact event-observation pairs to the model run', async () => {
    dir = mkdtempSync(join(tmpdir(), 'owner-event-observation-'));
    const path = join(dir, 'owner-events.db');
    let db = new Database(path);
    const first = new OwnerEventInbox(db, () => 100);
    first.enqueue({
      channelKey: 'slack:synthetic-channel',
      eventIds: ['event-1', 'event-legacy'],
      eventRefs: [
        { eventId: 'event-1', observationRef: 'obs-exact-1' },
        { eventId: 'event-legacy', observationRef: null },
      ],
      lines: ['synthetic change'],
      activations: [],
    });
    db.close();

    db = new Database(path);
    const reopened = new OwnerEventInbox(db, () => 101);
    const seen: Array<readonly { eventId: string; observationRef: string | null }[]> = [];
    const loop = new OwnerEventLoop({
      inbox: reopened,
      agentContext: ownerContext,
      issueEnvelope: async () => ({ agent_id: 'agent-synthetic' }) as Envelope,
      getNoUpdateMaxId: () => 0,
      buildPrompt: () => 'inspect the captured observation',
      log: () => {},
      runner: {
        run: async (_prompt, options) => {
          seen.push(options.observationRefs);
          return {
            response: 'recorded',
            history: [
              {
                role: 'assistant',
                content: [{ type: 'tool_use', id: 'task-1', name: 'task_update', input: {} }],
              },
              {
                role: 'user',
                content: [
                  {
                    type: 'tool_result',
                    tool_use_id: 'task-1',
                    content: JSON.stringify({ success: true }),
                  },
                ],
              },
            ],
          };
        },
      },
    });

    expect(await loop.tick()).toBe('processed');
    expect(seen).toEqual([
      [
        { eventId: 'event-1', observationRef: 'obs-exact-1' },
        { eventId: 'event-legacy', observationRef: null },
      ],
    ]);
    db.close();
  });

  it('runs agent-chosen registry_correct with matching unattended principal and signed envelope', async () => {
    const core = await import('@jungjaehoon/mama-core');
    const testUtils = await import('@jungjaehoon/mama-core/test-utils');
    const corePath = await testUtils.initTestDB('owner-event-registry-correct');
    const db = new Database(':memory:');
    const inbox = new OwnerEventInbox(db, () => 200);
    const scope = { kind: 'project' as const, id: 'owner-event-project' };
    const nodeId = core.createNode({ kind: 'item', name: 'owner event item', scopes: [scope] });
    inbox.enqueue({
      channelKey: 'slack:owner-event-channel',
      eventIds: ['owner-event-1'],
      eventRefs: [{ eventId: 'owner-event-1', observationRef: null }],
      lines: ['synthetic identity correction evidence'],
      activations: [],
    });
    const context = { ...ownerContext, principalId: 'principal-owner-event' };
    const executor = new GatewayToolExecutor({
      mamaApi: (await import('@jungjaehoon/mama-core/mama-api')).default,
    });
    const envelope = makeSignedEnvelope({
      agent_id: 'mama-owner',
      source: 'watch',
      channel_id: 'slack:owner-event-channel',
      scope: {
        principal_id: context.principalId,
        project_refs: [{ kind: 'project', id: scope.id }],
        raw_connectors: ['slack'],
        memory_scopes: [scope],
        allowed_destinations: [],
      },
    });
    const loop = new OwnerEventLoop({
      inbox,
      agentContext: context,
      issueEnvelope: async () => envelope,
      getNoUpdateMaxId: () => 0,
      buildPrompt: () => 'inspect and choose the correction',
      log: () => {},
      runner: {
        run: async (_prompt, options) => {
          const signed = await options.prepareEnvelope();
          expect(signed.scope.principal_id).toBe(options.agentContext.principalId);
          let result: Awaited<ReturnType<typeof executor.execute>> | undefined;
          await executor.withExecutionContext(
            { envelope: signed, agentContext: options.agentContext },
            async () => {
              result = await executor.execute('registry_correct', {
                command_id: 'owner-event-correction-1',
                expected_revision: core.currentIdentityRevision(),
                operation: 'add_alias',
                reason: 'agent judged the identity from the event',
                node_id: nodeId,
                alias: 'owner event alias',
                scopes: [scope],
              });
            }
          );
          expect(result).toMatchObject({ success: true });
          return {
            response: 'corrected',
            history: [
              {
                role: 'assistant',
                content: [
                  {
                    type: 'tool_use',
                    id: 'registry-correct-1',
                    name: 'registry_correct',
                    input: {},
                  },
                ],
              },
              {
                role: 'user',
                content: [
                  {
                    type: 'tool_result',
                    tool_use_id: 'registry-correct-1',
                    content: JSON.stringify(result),
                  },
                ],
              },
            ],
          };
        },
      },
    });
    try {
      expect(await loop.tick()).toBe('processed');
      expect(core.resolveAlias('owner event alias', 'item', [scope])?.id).toBe(nodeId);
    } finally {
      db.close();
      await testUtils.cleanupTestDB(corePath);
    }
  });

  it('fails explicitly on malformed or inconsistent stored event refs', () => {
    const db = new Database(':memory:');
    const inbox = new OwnerEventInbox(db, () => 100);
    inbox.enqueue({
      channelKey: 'slack:synthetic-channel',
      eventIds: ['event-1'],
      eventRefs: [{ eventId: 'event-1', observationRef: 'obs-exact-1' }],
      lines: ['synthetic change'],
      activations: [],
    });
    db.prepare('UPDATE owner_event_inbox SET event_refs_json = ?').run('{malformed');
    expect(() => inbox.claimNext()).toThrow(/event_refs_json is malformed/);
    db.prepare(
      "UPDATE owner_event_inbox SET status = 'pending', claimed_at = NULL, event_refs_json = ?"
    ).run(JSON.stringify([{ eventId: 'different', observationRef: 'obs-other' }]));
    expect(() => inbox.claimNext()).toThrow(/do not match event ids/);
    db.close();
  });
});
