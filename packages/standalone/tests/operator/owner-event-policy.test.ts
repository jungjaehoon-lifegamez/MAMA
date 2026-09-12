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
        principalId: 'principal-owner-event-policy',
        ownerRole: DEFAULT_ROLES.definitions.owner_console,
        privateConnectorPolicy: privatePolicy,
      });

      expect(context.source).toBe('owner-event');
      expect(context.roleName).toBe('owner_console');
      expect(context.backend).toBe(backend);
      expect(context.principalId).toBe('principal-owner-event-policy');
      expect(context.role.allowedTools).toEqual(
        expect.arrayContaining([
          'code_act',
          'telegram_send',
          'contract_no_update',
          'drive_upload',
          'kagemusha_messages',
          // One MAMA Phase 1 Task 1: the event turn may change the ledger and memory.
          // v0.48.1: records and tasks are separate - the event turn may RECORRECT
          // existing rows but never create one from a connector observation.
          'task_update',
          'task_create',
          'task_reclassify',
          'mama_save',
          'mama_update',
          'obsidian',
          'drive_translate_conti',
        ])
      );
      // Owner decision 2026-09-04, enforced here since 2026-09-09: the workspace shell and
      // file writer belong to the owner's OWN chat turn. A live owner-event turn ran
      // `find ~/.mama/workspace -name '*.zip'` because this surface still held Bash.
      for (const unattendedBlocked of ['Bash', 'Write']) {
        expect(context.role.allowedTools).not.toContain(unattendedBlocked);
        expect(context.role.blockedTools).toContain(unattendedBlocked);
      }
      for (const administrationSurface of [
        'member_register',
        'member_suspend',
        'member_offboard',
        'member_scope_grant',
        'member_scope_revoke',
        'console_brief_update',
      ]) {
        expect(context.role.allowedTools).not.toContain(administrationSurface);
        expect(context.role.blockedTools).toContain(administrationSurface);
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
