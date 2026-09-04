import type { BackendType } from '../agent/model-runner.js';
import type { AgentContext } from '../agent/types.js';
import type { RoleConfig } from '../cli/config/types.js';
import type { PrivateConnectorPolicy } from '../connectors/private-connector-policy.js';

/**
 * One MAMA (2026-09-04): the event turn holds the owner console grant minus the
 * entries below, each with the reason it is not "minus nothing". Ledger and memory
 * tools (task_create/task_update/mama_save/mama_update) are deliberately NOT here
 * any more - blocking them since v0.37.0 is what left the owner ledger without a
 * single agent-authored task for two weeks.
 */
const OWNER_EVENT_BLOCKED_TOOLS = new Set([
  // administration: owner-authored chat only
  'member_register',
  'member_suspend',
  'member_offboard',
  'member_scope_grant',
  'member_scope_revoke',
  // an event turn is driven by UNTRUSTED connector content; letting it rewrite the
  // one operating brief is a prompt-injection amplifier. Brief edits stay on chat.
  'console_brief_update',
  // fire-and-forget into another model turn = a second judgment surface
  'report_request',
  // delegation no longer completes a batch (owner-event-outcome.ts); a callable tool
  // that never completes only burns a turn. Task 4 deletes the tools themselves.
  'workorder_request',
  'workorder_status',
  // not in the completion set (owner-event-outcome.ts) and not receipted anywhere the
  // crash-recovery resolver can read: `obsidian` covers reads as well as writes, and
  // drive_translate_conti uploads outside the owner-event effect ledger, so a retry
  // would upload again. Granting a durable-looking tool that can never complete the
  // turn only repeats its side effect until the batch dies.
  'obsidian',
  'drive_translate_conti',
]);

export function resolveOwnerEventExecution(input: {
  issuance: 'off' | 'enabled' | 'required';
  hasAuthority: boolean;
}): { enabled: true } | { enabled: false; reason: string } {
  return input.issuance !== 'off' && input.hasAuthority
    ? { enabled: true }
    : { enabled: false, reason: 'owner-event requires envelope authority' };
}

export function buildOwnerEventAgentContext(input: {
  backend: BackendType;
  model: string;
  ownerRole: RoleConfig;
  privateConnectorPolicy: PrivateConnectorPolicy;
}): AgentContext {
  const projected = input.privateConnectorPolicy.projectRole('owner_console', {
    ...input.ownerRole,
    model: input.model,
    allowedTools: [...new Set([...input.ownerRole.allowedTools, 'contract_no_update'])].filter(
      (tool) => !OWNER_EVENT_BLOCKED_TOOLS.has(tool)
    ),
    blockedTools: [
      ...new Set([...(input.ownerRole.blockedTools ?? []), ...OWNER_EVENT_BLOCKED_TOOLS]),
    ],
    allowedPaths: [...(input.ownerRole.allowedPaths ?? [])],
  });
  return {
    source: 'owner-event',
    platform: 'cli',
    roleName: 'owner_console',
    role: projected,
    session: {
      sessionId: 'owner-event',
      channelId: 'owner-event',
      startedAt: new Date(),
    },
    capabilities: [...projected.allowedTools],
    limitations: (projected.blockedTools ?? []).map((tool) => `Cannot use ${tool}`),
    tier: 1,
    backend: input.backend,
  };
}
