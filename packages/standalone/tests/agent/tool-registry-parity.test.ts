/**
 * Two registries, one contract text.
 *
 * The owner agent's code-act `tool_search` / `tool_describe` read the code-act
 * HostBridge TOOL_REGISTRY (src/agent/code-act/host-bridge.ts). The outer
 * gateway surface reads ToolRegistry (src/agent/tool-registry.ts). When the two
 * descriptions for one tool diverge, what the agent learns at the moment of use
 * is whichever copy sits in the code-act registry -- which is how the board card
 * vocabulary was published to the gateway registry only and the delegated board
 * child, calling tool_search/tool_describe, never saw it.
 *
 * This test pins report_publish EQUALITY (single source: the shared builder) and
 * freezes the remaining divergences, which are the norm rather than exceptions:
 * the two registries were written as independent texts. Each name below is a
 * known gap, not an accepted design. Closing one means choosing one
 * authoritative string -- ideally a shared builder, as report_publish does --
 * and deleting the other copy, then removing the name here.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { HostBridge } from '../../src/agent/code-act/host-bridge.js';
import { GatewayToolExecutor } from '../../src/agent/gateway-tool-executor.js';
import { ToolRegistry } from '../../src/agent/tool-registry.js';
import { buildReportPublishToolContract } from '../../src/operator/board-slot-instructions.js';

const hostByName = new Map(HostBridge.getToolRegistry().map((tool) => [tool.name, tool]));

/** Tools in BOTH registries whose description text differs today. */
const KNOWN_DESCRIPTION_DIVERGENCES: readonly string[] = [
  'Bash',
  'Read',
  'Write',
  'agent_notices',
  'audit_findings_read',
  'board_read',
  'changes_read',
  'console_brief_update',
  'contract_no_update',
  'create_fb_overlay',
  'discord_send',
  'drive_browse',
  'drive_find_folder',
  'drive_list_drives',
  'drive_translate_conti',
  'experience_read',
  'file_export',
  'issue_close',
  'mama_load_checkpoint',
  'mama_provenance',
  'mama_recall',
  'mama_save',
  'mama_search',
  'mama_update',
  'member_candidates',
  'member_list',
  'member_offboard',
  'member_register',
  'member_scope_grant',
  'member_scope_list',
  'member_scope_revoke',
  'member_suspend',
  'obsidian',
  'ocr_image',
  'os_get_config',
  'procedure_list',
  'procedure_observe',
  'procedure_read',
  'procedure_retire',
  'procedure_update',
  'repair_request',
  'schedule_upcoming',
  'slack_send',
  'task_create',
  'task_external_bind',
  'task_external_candidates',
  'task_external_correlation',
  'task_lifecycle_reconcile',
  'task_list',
  'task_reclassify',
  'task_temporal_reconcile',
  'task_update',
  'telegram_send',
  'translate_conti',
  'trello_card',
  'trello_kanban',
  'trello_search',
  'wiki_publish',
  'wiki_read',
];

function collectDivergences(): string[] {
  const divergent: string[] = [];
  for (const gateway of ToolRegistry.getAllTools()) {
    const host = hostByName.get(gateway.name);
    if (!host) continue;
    if (host.description !== gateway.description) divergent.push(gateway.name);
  }
  return divergent.sort();
}

describe('code-act / gateway registry description parity', () => {
  it('does not advertise or dispatch the retired webchat action', async () => {
    expect(ToolRegistry.getTool('webchat_send')).toBeUndefined();
    expect(ToolRegistry.generatePrompt(['*'])).not.toContain('webchat_send');
    expect(HostBridge.getToolRegistry().map((tool) => tool.name)).not.toContain('webchat_send');
    expect(
      readFileSync(join(process.cwd(), 'src', 'agent', 'gateway-tools.md'), 'utf8')
    ).not.toContain('webchat');

    await expect(new GatewayToolExecutor().execute('webchat_send', {})).rejects.toMatchObject({
      code: 'UNKNOWN_TOOL',
    });
  });

  it('report_publish carries the identical board contract in both registries', () => {
    const host = hostByName.get('report_publish');
    const gateway = ToolRegistry.getTool('report_publish');
    expect(host).toBeDefined();
    expect(gateway).toBeDefined();
    expect(host?.description).toBe(buildReportPublishToolContract());
    expect(gateway?.description).toBe(buildReportPublishToolContract());
    expect(host?.description).toBe(gateway?.description);
  });

  it('the board card vocabulary reaches the code-act registry the agent reads', () => {
    const host = hostByName.get('report_publish');
    for (const token of ['report-card', 'report-summary', 'report-section-title', 'report-table']) {
      expect(host?.description).toContain(token);
    }
  });

  it('report_publish is not among the divergences', () => {
    expect(KNOWN_DESCRIPTION_DIVERGENCES).not.toContain('report_publish');
    expect(collectDivergences()).not.toContain('report_publish');
  });

  // Freeze, so a NEW divergence (or a silently closed one) is visible instead of
  // accumulating unseen. This is not a claim that the frozen set is correct.
  it('the divergence set is exactly the frozen known list', () => {
    expect(collectDivergences()).toEqual([...KNOWN_DESCRIPTION_DIVERGENCES]);
  });

  it.todo(
    `close ${KNOWN_DESCRIPTION_DIVERGENCES.length} remaining description divergences one by one, starting with the tools whose gateway text carries contract vocabulary the code-act copy omits (task_list, board_read, wiki_publish, file_export)`
  );
});
