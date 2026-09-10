import { describe, expect, it } from 'vitest';
import {
  ADMINISTRATION_TOOLS,
  ONE_AGENT_TURN_POLICY,
  SCHEDULED_TURN_BLOCKED_TOOLS,
  OPERATOR_REPORT_TOOL_POLICY,
  TURN_KIND_REQUIRED_TOOLS,
  buildTurnAgentPolicy,
} from '../../src/cli/commands/start.js';
import { DEFAULT_ROLES } from '../../src/cli/config/types.js';
import { WORKORDER_KINDS } from '../../src/operator/task-ledger.js';
import { resolvePrivateConnectorPolicy } from '../../src/connectors/private-connector-policy.js';

const privatePolicy = resolvePrivateConnectorPolicy({
  ok: true,
  config: { kagemusha: { enabled: true } },
  enabledNames: ['kagemusha'],
});
const ownerRole = DEFAULT_ROLES.definitions.owner_console;
const turn = (kind: (typeof WORKORDER_KINDS)[number], scope: readonly string[] = []) =>
  buildTurnAgentPolicy(kind, 'gpt-test', 'codex', privatePolicy, scope, ownerRole);

describe('owner runtime report stimulus', () => {
  it('TG-03/TG-04/TG-05 keeps progressive discovery and removes the relay', () => {
    const grant = new Set(OPERATOR_REPORT_TOOL_POLICY.allowedTools);
    expect(grant.has('task_list')).toBe(true);
    expect(grant.has('changes_read')).toBe(true);
    expect(grant.has('report_request')).toBe(false);
  });
});

describe('TG-03/TG-04/TG-05: one owner grant across scheduled stimuli', () => {
  it('keeps one principal and the same ordinary owner business capabilities for every kind', () => {
    const ordinary = [
      'task_create',
      'task_update',
      'task_reclassify',
      'mama_save',
      'mama_update',
      'drive_browse',
      'drive_download',
      'obsidian',
      'Read',
    ];
    for (const kind of WORKORDER_KINDS) {
      const context = turn(kind).agentContext;
      expect(context.roleName).toBe(ONE_AGENT_TURN_POLICY.roleName);
      expect(context.role.allowedTools, kind).toEqual(expect.arrayContaining(ordinary));
      expect(context.role.allowedTools, kind).toEqual(
        expect.arrayContaining([...TURN_KIND_REQUIRED_TOOLS[kind]])
      );
    }
  });

  it('projects configured private reads independently of work kind or hint scope', () => {
    for (const kind of WORKORDER_KINDS) {
      expect(turn(kind, []).agentContext.role.allowedTools).toEqual(
        expect.arrayContaining(['kagemusha_overview', 'kagemusha_entities', 'kagemusha_messages'])
      );
    }
  });

  it('blocks the workspace shell and file writer on every unattended turn', () => {
    // CLAUDE.md and types.ts both said so; SCHEDULED_TURN_BLOCKED_TOOLS did not, and a live
    // unattended turn ran a shell command (2026-09-09).
    for (const kind of WORKORDER_KINDS) {
      const context = turn(kind).agentContext;
      for (const tool of ['Bash', 'Write']) {
        expect(context.role.allowedTools, `${kind} holds ${tool}`).not.toContain(tool);
        expect(context.role.blockedTools, `${kind} does not block ${tool}`).toContain(tool);
      }
    }
    expect(SCHEDULED_TURN_BLOCKED_TOOLS.has('Bash')).toBe(true);
    expect(SCHEDULED_TURN_BLOCKED_TOOLS.has('Write')).toBe(true);
    for (const tool of ADMINISTRATION_TOOLS) {
      expect(SCHEDULED_TURN_BLOCKED_TOOLS.has(tool)).toBe(true);
    }
  });

  it('keeps membership, scope and standing-policy administration protected', () => {
    for (const kind of WORKORDER_KINDS) {
      const context = turn(kind).agentContext;
      for (const tool of ADMINISTRATION_TOOLS) {
        expect(context.role.allowedTools, `${kind} holds ${tool}`).not.toContain(tool);
        expect(context.role.blockedTools, `${kind} does not block ${tool}`).toContain(tool);
      }
    }
  });

  it('grants only registered tools plus the native subagent marker', async () => {
    const { ToolRegistry } = await import('../../src/agent/tool-registry.js');
    const known = new Set(ToolRegistry.getAllTools().map((tool) => tool.name));
    for (const kind of WORKORDER_KINDS) {
      expect(
        turn(kind).agentContext.role.allowedTools.filter(
          (tool) => tool !== 'native_subagent' && !known.has(tool)
        )
      ).toEqual([]);
    }
  });

  it('keeps self-check primitives grantable through the shared owner role', () => {
    expect(turn('self-check').agentContext.role.allowedTools).toEqual(
      expect.arrayContaining(['file_export', 'repair_request', 'issue_close'])
    );
  });
});

/**
 * Owner decision 2026-09-09: the scheduled board delta turn reads the accumulated state, so its
 * three named sources have to be in the lane's own grant - a contract naming a tool the lane
 * cannot call is a script for a failure.
 */
describe('board delta turn sources', () => {
  it('grants board_read, changes_read and task_list to the board lane', () => {
    const allowed = new Set(turn('board').agentContext.role.allowedTools);
    for (const tool of ['board_read', 'changes_read', 'task_list', 'report_publish']) {
      expect(allowed.has(tool), tool).toBe(true);
    }
  });
});
