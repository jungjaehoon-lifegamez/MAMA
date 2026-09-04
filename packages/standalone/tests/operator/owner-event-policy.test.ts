import { describe, expect, it } from 'vitest';
import { DEFAULT_ROLES } from '../../src/cli/config/types.js';
import { buildAgentToolExecutionContext } from '../../src/agent/agent-loop.js';
import { resolvePrivateConnectorPolicy } from '../../src/connectors/private-connector-policy.js';
import {
  buildOwnerEventAgentContext,
  resolveOwnerEventExecution,
} from '../../src/operator/owner-event-policy.js';

describe('Story TG-03/TG-04: owner-event policy', () => {
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
    'AC #2 keeps MAMA owner abilities on the %s backend without a Conductor role',
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
          'drive_upload',
          'kagemusha_messages',
          // One MAMA Phase 1 Task 1: the event turn may change the ledger and memory.
          'task_create',
          'task_update',
          'mama_save',
          'mama_update',
        ])
      );
      // Never on the event turn: connector text must not become a command.
      expect(context.role.blockedTools).toEqual(expect.arrayContaining(['Bash', 'Write']));
      expect(context.role.allowedTools).not.toContain('Bash');
      expect(context.role.allowedTools).not.toContain('Write');
      for (const administrationOrSecondJudgmentSurface of [
        'member_register',
        'member_suspend',
        'member_offboard',
        'member_scope_grant',
        'member_scope_revoke',
        'console_brief_update',
        'report_request',
        'obsidian',
        'drive_translate_conti',
      ]) {
        expect(context.role.allowedTools).not.toContain(administrationOrSecondJudgmentSurface);
        expect(context.role.blockedTools).toContain(administrationOrSecondJudgmentSurface);
      }
      // Delegation tools no longer exist anywhere on the surface.
      expect(context.role.allowedTools).not.toContain('workorder_request');
      expect(context.role.allowedTools).not.toContain('workorder_status');
      expect(
        buildAgentToolExecutionContext({ agentContext: context, actorId: 'mama-owner' })?.agentId
      ).toBe('mama-owner');
    }
  );
});
