import { describe, expect, it } from 'vitest';
import { DEFAULT_ROLES } from '../../src/cli/config/types.js';
import { buildAgentToolExecutionContext } from '../../src/agent/agent-loop.js';
import { resolvePrivateConnectorPolicy } from '../../src/connectors/private-connector-policy.js';
import {
  buildOwnerEventAgentContext,
  resolveOwnerEventExecution,
} from '../../src/operator/owner-event-policy.js';

describe('TG-03/TG-04 owner-event policy', () => {
  it('disables automatic owner work when no host envelope authority exists', () => {
    expect(resolveOwnerEventExecution({ issuance: 'off', hasAuthority: false })).toEqual({
      enabled: false,
      reason: 'owner-event requires envelope authority',
    });
    expect(resolveOwnerEventExecution({ issuance: 'enabled', hasAuthority: true })).toEqual({
      enabled: true,
    });
  });

  it.each(['claude', 'codex', 'cline'] as const)(
    'keeps MAMA owner abilities on the %s backend without a Conductor role',
    (backend) => {
      const privatePolicy = resolvePrivateConnectorPolicy({
        ok: true,
        config: { kagemusha: { enabled: true } },
        enabledNames: ['kagemusha'],
      });
      const context = buildOwnerEventAgentContext({
        backend,
        model: backend === 'codex' ? 'gpt-5.6-sol' : 'test-model',
        ownerRole: DEFAULT_ROLES.definitions.owner_console,
        privateConnectorPolicy: privatePolicy,
      });

      expect(context.source).toBe('owner-event');
      expect(context.roleName).toBe('owner_console');
      expect(context.backend).toBe(backend);
      expect(context.role.allowedTools).toEqual(
        expect.arrayContaining([
          'code_act',
          'telegram_send',
          'contract_no_update',
          'workorder_request',
          'drive_upload',
          'kagemusha_messages',
        ])
      );
      expect(context.role.blockedTools).toEqual(expect.arrayContaining(['Bash', 'Write']));
      for (const ownerMessageOnlyOrNonIdempotent of [
        'member_register',
        'member_suspend',
        'member_offboard',
        'console_brief_update',
        'task_create',
        'task_update',
        'mama_save',
        'mama_update',
        'drive_translate_conti',
        'obsidian',
        'report_publish',
        'report_request',
      ]) {
        expect(context.role.allowedTools).not.toContain(ownerMessageOnlyOrNonIdempotent);
      }
      expect(
        buildAgentToolExecutionContext({ agentContext: context, actorId: 'mama-owner' })?.agentId
      ).toBe('mama-owner');
    }
  );
});
