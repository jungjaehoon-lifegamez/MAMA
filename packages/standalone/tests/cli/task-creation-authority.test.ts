/**
 * Only an owner CONVERSATION may create a native task (owner policy, v0.48.1).
 *
 * Unattended turns inherited task_create from the owner-console grant, and the
 * Board prompt explicitly told a reconcile run to create a row for any connector
 * item with no row. That is how connector records became owner tasks. The host now
 * BLOCKS task_create on every unattended surface and grants task_reclassify
 * instead, so those turns can only recorrect what already exists (TG-03/TG-04).
 */
import { describe, it, expect } from 'vitest';
import {
  SCHEDULED_TURN_BLOCKED_TOOLS,
  TURN_KIND_REQUIRED_TOOLS,
  buildTurnAgentPolicy,
} from '../../src/cli/commands/start.js';
import { WORKORDER_KINDS } from '../../src/operator/task-ledger.js';
import { buildOwnerEventAgentContext } from '../../src/operator/owner-event-policy.js';
import { DEFAULT_ROLES } from '../../src/cli/config/types.js';
import { resolvePrivateConnectorPolicy } from '../../src/connectors/private-connector-policy.js';
import { LEDGER_EFFECT_TOOLS } from '../../src/operator/owner-event-outcome.js';

const privatePolicy = resolvePrivateConnectorPolicy({ ok: true, config: {}, enabledNames: [] });
const ownerRole = DEFAULT_ROLES.definitions.owner_console;

function turnTools(kind: (typeof WORKORDER_KINDS)[number]): string[] {
  return [
    ...buildTurnAgentPolicy(kind, 'gpt-test', 'codex', privatePolicy, ['trello'], ownerRole)
      .agentContext.role.allowedTools,
  ];
}

describe('Story TASK-RECAL-3: unattended task creation authority', () => {
  describe('Acceptance Criteria #1: only the owner conversation can create tasks', () => {
    it('no scheduled turn holds task_create', () => {
      for (const kind of WORKORDER_KINDS) {
        expect(turnTools(kind), `${kind} holds task_create`).not.toContain('task_create');
      }
    });

    it('the board turn keeps task_update and gains task_reclassify', () => {
      const board = turnTools('board');
      expect(board).toContain('task_update');
      expect(board).toContain('task_reclassify');
      // Blocked for EVERY unattended turn, not just the board.
      expect(SCHEDULED_TURN_BLOCKED_TOOLS.has('task_create')).toBe(true);
      expect(TURN_KIND_REQUIRED_TOOLS.board).toContain('task_reclassify');
    });

    it('the owner-event turn blocks task_create but may reclassify and settle no-update', () => {
      const context = buildOwnerEventAgentContext({
        backend: 'codex',
        model: 'gpt-test',
        ownerRole,
        privateConnectorPolicy: privatePolicy,
      });
      const tools = [...context.role.allowedTools];
      expect(tools).not.toContain('task_create');
      expect(context.role.blockedTools ?? []).toContain('task_create');
      expect(tools).toContain('task_reclassify');
      expect(tools).toContain('task_update');
      expect(tools).toContain('contract_no_update');
    });

    it('an owner CONVERSATION keeps task_create (the only surface that may create)', () => {
      expect(ownerRole.allowedTools).toContain('task_create');
      expect(ownerRole.allowedTools).toContain('task_reclassify');
    });

    it('a reclassification counts as owner-event completion (a ledger change, not a send)', () => {
      expect(LEDGER_EFFECT_TOOLS.has('task_reclassify')).toBe(true);
    });
  });
});
