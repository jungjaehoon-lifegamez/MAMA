import { describe, expect, it } from 'vitest';
import { DEFAULT_ROLES } from '../../src/cli/config/types.js';
import { resolvePrivateConnectorPolicy } from '../../src/connectors/private-connector-policy.js';
import { WORKORDER_KINDS } from '../../src/operator/task-ledger.js';
import { LEDGER_EFFECT_TOOLS } from '../../src/operator/owner-event-outcome.js';
import { buildOwnerEventAgentContext } from '../../src/operator/owner-event-policy.js';
import { ADMINISTRATION_TOOLS, buildTurnAgentPolicy } from '../../src/cli/commands/start.js';

const privatePolicy = resolvePrivateConnectorPolicy({
  ok: true,
  config: { kagemusha: { enabled: true } },
  enabledNames: ['kagemusha'],
});
const ownerRole = DEFAULT_ROLES.definitions.owner_console;

describe('TG-03/TG-04/TG-05: ordinary owner business authority', () => {
  const ordinaryBusinessTools = [
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

  it('projects the same owner-granted business tools through every scheduled kind', () => {
    for (const kind of WORKORDER_KINDS) {
      const tools = buildTurnAgentPolicy(
        kind,
        'gpt-test',
        'codex',
        privatePolicy,
        ['trello', 'kagemusha'],
        ownerRole
      ).agentContext.role.allowedTools;
      expect(tools, kind).toEqual(expect.arrayContaining(ordinaryBusinessTools));
    }
  });

  it('projects the same owner-granted business tools through owner events', () => {
    const tools = buildOwnerEventAgentContext({
      backend: 'codex',
      model: 'gpt-test',
      principalId: 'principal-task-creation-authority',
      ownerRole,
      privateConnectorPolicy: privatePolicy,
    }).role.allowedTools;
    expect(tools).toEqual(expect.arrayContaining(ordinaryBusinessTools));
  });

  it('keeps membership and standing-policy administration outside background stimuli', () => {
    for (const kind of WORKORDER_KINDS) {
      const context = buildTurnAgentPolicy(
        kind,
        'gpt-test',
        'codex',
        privatePolicy,
        ['trello', 'kagemusha'],
        ownerRole
      ).agentContext;
      for (const tool of ADMINISTRATION_TOOLS) {
        expect(context.role.allowedTools, `${kind} holds ${tool}`).not.toContain(tool);
        expect(context.role.blockedTools, `${kind} does not block ${tool}`).toContain(tool);
      }
    }
  });

  it('counts task creation as a durable owner-event ledger effect', () => {
    expect(LEDGER_EFFECT_TOOLS.has('task_create')).toBe(true);
    expect(LEDGER_EFFECT_TOOLS.has('task_reclassify')).toBe(true);
  });
});
