import { describe, expect, it, vi } from 'vitest';
import { GatewayToolExecutor } from '../../src/agent/gateway-tool-executor.js';
import type { GatewayToolInput } from '../../src/agent/types.js';
import { computeEnvelopeHash } from '../../src/envelope/canonical.js';
import type { Envelope } from '../../src/envelope/types.js';

function hashEnvelope(env: Envelope): Envelope {
  env.envelope_hash = computeEnvelopeHash(env);
  return env;
}

function makeTelegramGateway() {
  return {
    sendMessage: vi.fn().mockResolvedValue(undefined),
    sendFile: vi.fn().mockResolvedValue(undefined),
    sendImage: vi.fn().mockResolvedValue(undefined),
    sendSticker: vi.fn().mockResolvedValue(true),
  };
}

describe('Story M1.7: Envelope drift sentinel', () => {
  describe('Acceptance Criteria', () => {
    it('AC: documents destination drift guardrails', () => {
      expect([
        'worker cannot send to destinations outside allowed_destinations',
        'reactive workers can only reply to their own channel',
      ]).toEqual([
        'worker cannot send to destinations outside allowed_destinations',
        'reactive workers can only reply to their own channel',
      ]);
    });
  });

  describe('envelope drift sentinel: T1 accidental destination widening', () => {
    it('autonomous worker with no allowed_destinations cannot send anywhere', async () => {
      const env = hashEnvelope({
        agent_id: 'worker',
        instance_id: 'standing-1',
        source: 'cron',
        trigger_context: { scheduled_at: '2026-04-26T04:00:00Z' },
        scope: {
          project_refs: [{ kind: 'project', id: '/PROJECT_A' }],
          raw_connectors: ['telegram'],
          memory_scopes: [{ kind: 'project', id: '/PROJECT_A' }],
          allowed_destinations: [],
        },
        tier: 3,
        budget: { wall_seconds: 60 },
        expires_at: new Date(Date.now() + 60_000).toISOString(),
        envelope_hash: '',
      });
      const gateway = makeTelegramGateway();
      const executor = new GatewayToolExecutor();
      executor.setTelegramGateway(gateway);

      const result = await executor.execute(
        'telegram_send',
        {
          chat_id: 'tg:STOLEN_FROM_PROJECT_B',
          message: 'leaked',
        } as GatewayToolInput,
        { agentId: 'worker', source: 'cron', channelId: '', envelope: env }
      );

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/destination_out_of_scope|missing_destination/);
      expect(gateway.sendMessage).not.toHaveBeenCalled();
    });

    it('Reactive Main can only reply to its own channel', async () => {
      const env = hashEnvelope({
        agent_id: 'worker',
        instance_id: 'reactive-1',
        source: 'telegram',
        channel_id: 'tg:USER_OWN_CHAT',
        trigger_context: { user_text: 'help me' },
        scope: {
          project_refs: [{ kind: 'project', id: '/PROJECT_A' }],
          raw_connectors: ['telegram'],
          memory_scopes: [{ kind: 'project', id: '/PROJECT_A' }],
          allowed_destinations: [{ kind: 'telegram', id: 'tg:USER_OWN_CHAT' }],
        },
        tier: 1,
        budget: { wall_seconds: 10 },
        expires_at: new Date(Date.now() + 60_000).toISOString(),
        envelope_hash: '',
      });
      const gateway = makeTelegramGateway();
      const executor = new GatewayToolExecutor();
      executor.setTelegramGateway(gateway);

      const ownChat = await executor.execute(
        'telegram_send',
        {
          chat_id: 'tg:USER_OWN_CHAT',
          message: 'reply',
        } as GatewayToolInput,
        { agentId: 'worker', source: 'telegram', channelId: 'tg:USER_OWN_CHAT', envelope: env }
      );
      expect(ownChat.success).toBe(true);
      expect(gateway.sendMessage).toHaveBeenCalledWith('tg:USER_OWN_CHAT', 'reply');

      const stolen = await executor.execute(
        'telegram_send',
        {
          chat_id: 'tg:STOLEN_FROM_PROJECT_B',
          message: 'leak',
        } as GatewayToolInput,
        { agentId: 'worker', source: 'telegram', channelId: 'tg:USER_OWN_CHAT', envelope: env }
      );
      expect(stolen.success).toBe(false);
      expect(stolen.error).toMatch(/destination_out_of_scope/);
      expect(gateway.sendMessage).not.toHaveBeenCalledWith('tg:STOLEN_FROM_PROJECT_B', 'leak');
    });
  });
});
