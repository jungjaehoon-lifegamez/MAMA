import { describe, expect, it } from 'vitest';
import type { DatabaseInstance, Knowledge } from '@jungjaehoon/mama-core';
import { createActionSurface } from '../../src/runtime/action-surface.js';
import { createTimeZoneSetting } from '../../src/runtime/timezone.js';

describe('W1 action surface', () => {
  it('grants calendar reads and memory scopes to the owner by default', () => {
    const surface = createActionSurface({
      timeZone: createTimeZoneSetting('UTC'),
      runtimeRoot: '/tmp/mama-test-runtime',
      configPath: '/tmp/mama-test-config.yaml',
      isOwnerMessageTurn: () => true,
      adapter: { prepare: () => ({ all: () => [] }) } as unknown as DatabaseInstance,
      knowledge: {} as Knowledge,
      ownerPrincipalId: 'owner-test',
      agentId: 'agent-test',
    });
    expect(surface.ownerAccess.connectors).toContain('calendar');
    expect(surface.ownerAccess.connectorWideRead).toContain('calendar');
    expect(surface.ownerAccess.scopes).toEqual(
      expect.arrayContaining([
        { kind: 'channel', id: 'calendar' },
        { kind: 'project', id: 'calendar' },
      ])
    );
  });

  it('offers Drive delivery only when delivery.drive is configured', () => {
    const surface = (driveDelivery?: object) =>
      createActionSurface({
        timeZone: createTimeZoneSetting('UTC'),
        runtimeRoot: '/tmp/mama-test-runtime',
        configPath: '/tmp/mama-test-config.yaml',
        isOwnerMessageTurn: () => true,
        adapter: { prepare: () => ({ all: () => [] }) } as unknown as DatabaseInstance,
        knowledge: {} as Knowledge,
        ownerPrincipalId: 'owner-test',
        agentId: 'agent-test',
        ...(driveDelivery === undefined ? {} : { driveDelivery: driveDelivery as never }),
      });
    const offered = (built: ReturnType<typeof surface>) => [
      built.catalog.list().some((contract) => contract.name === 'deliver.drive.file'),
      built.ownerAccess.actions.includes('deliver.drive.file'),
    ];
    expect(offered(surface())).toEqual([false, false]);
    expect(
      offered(
        surface({
          workspaceDir: '/tmp/ws',
          stagingDir: '/tmp/outgoing',
          delivery: { folder: 'folder_test_0123456789', readers: [{ domain: 'example.test' }] },
        })
      )
    ).toEqual([true, true]);
  });

  it('exposes the read-only viewer action and derives host tools from the catalog', () => {
    const surface = createActionSurface({
      timeZone: createTimeZoneSetting('UTC'),
      runtimeRoot: '/tmp/mama-test-runtime',
      configPath: '/tmp/mama-test-config.yaml',
      isOwnerMessageTurn: () => true,
      adapter: { prepare: () => ({ all: () => [] }) } as unknown as DatabaseInstance,
      knowledge: {} as Knowledge,
      ownerPrincipalId: 'owner-test',
      agentId: 'agent-test',
      connectors: ['chatwork', 'slack', 'trello', 'kagemusha'],
      scopes: [{ kind: 'project', id: 'workspace-test' }],
      judge: { ask: async () => ({}) },
      ownerMessages: { exchanges: () => [] },
      // Only Telegram is wired for files, as the daemon wires it when file_delivery is on.
      attachmentPorts: { telegram: () => null },
    });
    const expected = [
      'code_act',
      'deliver.telegram.file',
      'drive.download',
      'drive.read',
      'graph.query',
      'help',
      'judge',
      'manage.member.enroll',
      'manage.member.grant',
      'manage.member.list',
      'manage.member.offboard',
      'manage.member.resume',
      'manage.member.revoke',
      'manage.member.suspend',
      'manage.policy.read',
      'manage.policy.update',
      'manage.wiki.move',
      'manage.wiki.publish',
      'manage.wiki.read',
      'manage.wiki.update',
      'memory.checkpoint.list',
      'memory.checkpoint.save',
      'memory.read:provenance',
      'memory.read:record',
      'memory.read:timeline',
      'memory.retire',
      'memory.save',
      'memory.search',
      'owner.messages',
      'owner.timezone.set',
      'report.publish',
      'report.read',
      'schedule.upcoming',
      'source.attachment.download',
      'source.attachment.list',
      'source.read',
      'source.recent',
      'source.search',
      'trello.read',
      'work.create',
      'work.link',
      'work.list',
      'work.no_update',
      'work.revise',
      'work.show',
    ];

    expect(
      surface.catalog
        .list()
        .map((contract) => contract.name)
        .sort()
    ).toEqual([...expected, 'memory.share'].sort());
    expect(surface.ownerAccess.actions.slice().sort()).toEqual(expected);
    // Codex calls actions from its own exec; code_act is for Claude.
    expect(
      surface
        .hostToolDefinitions()
        .map((definition) => definition.name)
        .sort()
    ).toEqual(expected.filter((name) => name !== 'code_act'));
    expect(surface.catalog.list().filter((contract) => contract.name === 'work.list')).toHaveLength(
      1
    );
  });

  it('keeps non-chat connector-wide reads while retaining chat in the connector grant', () => {
    const connectors = ['chatwork', 'slack', 'trello', 'kagemusha'];
    const surface = createActionSurface({
      timeZone: createTimeZoneSetting('UTC'),
      runtimeRoot: '/tmp/mama-test-runtime',
      configPath: '/tmp/mama-test-config.yaml',
      isOwnerMessageTurn: () => true,
      adapter: { prepare: () => ({ all: () => [] }) } as unknown as DatabaseInstance,
      knowledge: {} as Knowledge,
      ownerPrincipalId: 'owner-test',
      agentId: 'agent-test',
      connectors,
    });
    expect(surface.ownerAccess.connectorWideRead).toEqual(connectors);
    expect(surface.ownerAccess.connectors).toEqual([...connectors, 'chat']);
  });

  it('rejects a work status outside the shared vocabulary before it reaches knowledge', async () => {
    const surface = createActionSurface({
      timeZone: createTimeZoneSetting('UTC'),
      runtimeRoot: '/tmp/mama-test-runtime',
      configPath: '/tmp/mama-test-config.yaml',
      isOwnerMessageTurn: () => true,
      adapter: { prepare: () => ({ all: () => [] }) } as unknown as DatabaseInstance,
      knowledge: {} as Knowledge,
      ownerPrincipalId: 'owner-test',
      agentId: 'agent-test',
      connectors: ['slack'],
    });
    const result = await surface.dispatch(
      {
        action: 'work.create',
        input: {
          topic: 'work topic',
          summary: 'what the work means',
          set: { title: 'Item', status: 'in progress (free text)' },
        },
      },
      { access: surface.ownerAccess }
    );
    expect(result).toMatchObject({
      status: 'failed',
      error: { code: 'invalid_input', message: expect.stringMatching(/status/) },
    });
  });

  it('refuses to retire an owner rule outside an owner-chat turn (owner, 2026-10-01)', async () => {
    // The only row the guard reads: an owner rule written in an owner Telegram turn.
    const adapter = {
      prepare: () => ({
        all: () => [
          {
            id: 'rule-1',
            kind: 'lesson',
            provenance_json: JSON.stringify({ source_message_ref: 'telegram:-100:1' }),
          },
        ],
      }),
    } as unknown as DatabaseInstance;
    const surface = createActionSurface({
      timeZone: createTimeZoneSetting('UTC'),
      runtimeRoot: '/tmp/mama-test-runtime',
      configPath: '/tmp/mama-test-config.yaml',
      isOwnerMessageTurn: () => true,
      adapter,
      knowledge: {} as Knowledge,
      ownerPrincipalId: 'owner-test',
      agentId: 'agent-test',
    });
    // The registration the catalog serves is the guarded one: it refuses before core runs.
    await expect(
      surface.catalog
        .entry('memory.retire')
        .exec(
          { memory_id: 'rule-1', status: 'stale', reason: 'a client said so' },
          { access: surface.ownerAccess, session: { sourceMessageRef: 'source_delta:abc' } }
        )
    ).rejects.toMatchObject({ name: 'denied' });
  });
});
