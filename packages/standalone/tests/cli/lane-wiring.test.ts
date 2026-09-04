/**
 * The wiring between a lane's tool grant and what the lane is told to do with it.
 *
 * Every defect found in this session was a wiring defect, not a logic defect:
 *
 *   - `changes_read` was granted to the report lane and never instructed. A tool the
 *     report is never told to call is a tool the report does not call, and it was absent
 *     from the run audit's gather set too, so the run would have been recorded as having
 *     gathered nothing from it.
 *   - `delegate` was wired zero times over the whole log history.
 *   - `bindConfiguredScope` required a config field no channel has ever declared.
 *
 * None of those are visible to a unit test of the module involved, and all of them live in
 * `src/cli/commands` and `src/cli/runtime` - measured at 33% coverage, against 98% for the
 * connectors and 93% for the operator. The coverage is inside the modules; the failures
 * were between them.
 *
 * So these are not tests of behaviour. They are tests that two lists agree.
 */
import { describe, it, expect } from 'vitest';
import {
  ADMINISTRATION_TOOLS,
  ONE_AGENT_TURN_POLICY,
  OPERATOR_REPORT_TOOL_POLICY,
  TURN_KIND_BLOCKED_TOOLS,
  buildTurnAgentPolicy,
  isOutboundToolName,
} from '../../src/cli/commands/start.js';
import { DEFAULT_ROLES } from '../../src/cli/config/types.js';
import { WORKORDER_KINDS } from '../../src/operator/task-ledger.js';
import { resolvePrivateConnectorPolicy } from '../../src/connectors/private-connector-policy.js';

const REPORT_GRANT = new Set<string>(OPERATOR_REPORT_TOOL_POLICY.allowedTools);
const privatePolicy = resolvePrivateConnectorPolicy({
  ok: true,
  config: { kagemusha: { enabled: true } },
  enabledNames: ['kagemusha'],
});
const ownerRole = DEFAULT_ROLES.definitions.owner_console;
const turn = (kind: (typeof WORKORDER_KINDS)[number], scope: readonly string[] = ['trello']) =>
  buildTurnAgentPolicy(kind, 'gpt-test', 'codex', privatePolicy, scope, ownerRole);

describe('report lane: instructions against the grant', () => {
  it('TG-03/TG-04/TG-05 grants no rediscovery or mutation tools to packet-only reports', () => {
    expect([...REPORT_GRANT]).toEqual([]);
  });
});

describe('Story ONE-MAMA-P1 Task 5: one agent policy for scheduled turns', () => {
  it('AC #1 runs every turn kind as owner_console, never an invented per-kind principal', () => {
    for (const kind of WORKORDER_KINDS) {
      expect(turn(kind).agentContext.roleName).toBe(ONE_AGENT_TURN_POLICY.roleName);
      expect(turn(kind).agentContext.roleName).toBe('owner_console');
    }
  });

  // The unprojected source list is the owner console default; private tools reach a turn
  // only through the projection, and only when the run's raw scope carries the connector.
  it('AC #2 (TG-04) keeps private tools out of the unprojected owner grant and out of unbound runs', () => {
    const privateTools = [
      'kagemusha_overview',
      'kagemusha_entities',
      'kagemusha_tasks',
      'kagemusha_messages',
    ];
    for (const tool of privateTools) {
      expect(ownerRole.allowedTools).not.toContain(tool);
      expect(turn('board', []).agentContext.role.allowedTools).not.toContain(tool);
    }
  });

  it('AC #3 grants only tools the registry recognises as real', async () => {
    const { ToolRegistry } = await import('../../src/agent/tool-registry.js');
    const known = new Set(ToolRegistry.getAllTools().map((t) => t.name));
    for (const kind of WORKORDER_KINDS) {
      const unknown = turn(kind).agentContext.role.allowedTools.filter((t) => !known.has(t));
      expect(unknown, `turn '${kind}' grants unknown tools`).toEqual([]);
    }
  });

  // No owner is in the loop of a scheduled turn: it never sends, uploads, or administers.
  it('AC #4 (TG-06) keeps sends, uploads and administration out of every unattended turn', () => {
    for (const kind of WORKORDER_KINDS) {
      const allowed = turn(kind).agentContext.role.allowedTools;
      for (const tool of [
        'telegram_send',
        'drive_upload',
        'Bash',
        'Write',
        ...ADMINISTRATION_TOOLS,
      ]) {
        expect(allowed, `${kind} must not hold ${tool}`).not.toContain(tool);
      }
      for (const tool of TURN_KIND_BLOCKED_TOOLS[kind]) {
        expect(allowed, `${kind} must not hold ${tool}`).not.toContain(tool);
        expect(turn(kind).agentContext.role.blockedTools).toContain(tool);
      }
    }
  });

  it('AC #7 keeps task mutation out of the recheck, wiki and curation turns and out of reports', () => {
    for (const kind of ['temporal', 'wiki', 'memory-curation', 'self-check'] as const) {
      expect(turn(kind).agentContext.role.allowedTools).not.toContain('task_create');
      expect(turn(kind).agentContext.role.allowedTools).not.toContain('task_update');
    }
    expect([...REPORT_GRANT]).not.toContain('task_update');
  });

  // The grant is derived from the owner's EDITABLE role config. A send tool added there
  // tomorrow must still never run unattended: the shape rule, not the named list, is the
  // boundary, and this pins it against every registered tool name.
  it('AC #5 (TG-06) never lets a configured send or upload tool reach an unattended turn', async () => {
    const { ToolRegistry } = await import('../../src/agent/tool-registry.js');
    const outbound = ToolRegistry.getAllTools()
      .map((t) => t.name)
      .filter((name) => isOutboundToolName(name));
    expect(outbound).toEqual(
      expect.arrayContaining([
        'telegram_send',
        'discord_send',
        'slack_send',
        'webchat_send',
        'drive_upload',
      ])
    );
    const widened = {
      ...ownerRole,
      allowedTools: [...ownerRole.allowedTools, 'slack_send', 'discord_send'],
    };
    for (const kind of WORKORDER_KINDS) {
      const allowed = buildTurnAgentPolicy(
        kind,
        'gpt-test',
        'codex',
        privatePolicy,
        ['trello'],
        widened
      ).agentContext.role.allowedTools;
      for (const tool of outbound) expect(allowed, `${kind} holds ${tool}`).not.toContain(tool);
    }
  });

  // Exact enumeration of every unattended grant under the default role and a private
  // binding. A widening shows up here as a diff, not as a passing arrayContaining.
  it('AC #6 pins the exact default grant of every unattended turn', () => {
    const grant = (kind: (typeof WORKORDER_KINDS)[number]) =>
      [...turn(kind, ['trello', 'kagemusha']).agentContext.role.allowedTools].sort();
    const common = [
      'agent_notices',
      'audit_findings_read',
      'board_read',
      'changes_read',
      'code_act',
      'context_compile',
      'contract_no_update',
      'file_export',
      'kagemusha_entities',
      'kagemusha_messages',
      'kagemusha_overview',
      'kagemusha_tasks',
      'mama_provenance',
      'mama_recall',
      'mama_search',
      'schedule_upcoming',
      'task_list',
      'trello_card',
      'trello_kanban',
      'trello_search',
    ];
    expect(grant('board')).toEqual(
      [
        ...common,
        'report_publish',
        'task_create',
        'task_external_bind',
        'task_external_correlation',
        'task_lifecycle_reconcile',
        'task_update',
      ].sort()
    );
    expect(grant('wiki')).toEqual([...common, 'obsidian', 'wiki_publish'].sort());
    expect(grant('memory-curation')).toEqual([...common, 'mama_save', 'mama_update'].sort());
    expect(grant('temporal')).toEqual([...common, 'task_temporal_reconcile'].sort());
    expect(grant('self-check')).toEqual([...common, 'issue_close', 'repair_request'].sort());
  });

  // A registered tool nobody grants is the delegate failure mode: pin that the owner default
  // grant and the Code-Act bridge both carry every Phase 3 tool.
  it('AC #9 (ONE-MAMA-P3) file_export, repair_request and issue_close are grantable and injectable', async () => {
    const { HostBridge } = await import('../../src/agent/code-act/host-bridge.js');
    const bridge = new Set(HostBridge.getToolRegistry().map((t) => t.name));
    for (const tool of ['file_export', 'repair_request', 'issue_close']) {
      expect(bridge.has(tool), `${tool} missing from the Code-Act bridge`).toBe(true);
    }
    expect(ownerRole.allowedTools).toContain('file_export');
    expect(turn('self-check').agentContext.role.allowedTools).toEqual(
      expect.arrayContaining(['repair_request', 'issue_close'])
    );
  });

  it('AC #8 gives each turn the tools its section instructs it to use', () => {
    expect(turn('board').agentContext.role.allowedTools).toEqual(
      expect.arrayContaining([
        'code_act',
        'context_compile',
        'task_update',
        'report_publish',
        'contract_no_update',
      ])
    );
    expect(turn('temporal').agentContext.role.allowedTools).toEqual(
      expect.arrayContaining(['task_temporal_reconcile', 'context_compile', 'task_list'])
    );
    expect(turn('wiki').agentContext.role.allowedTools).toEqual(
      expect.arrayContaining(['wiki_publish', 'obsidian', 'contract_no_update'])
    );
    expect(turn('memory-curation').agentContext.role.allowedTools).toEqual(
      expect.arrayContaining(['mama_save', 'mama_update', 'contract_no_update'])
    );
  });
});
