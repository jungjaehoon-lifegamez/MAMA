import type { BackendType } from '../agent/model-runner.js';
import type { AgentContext } from '../agent/types.js';
import type { RoleConfig } from '../cli/config/types.js';
import type { PrivateConnectorPolicy } from '../connectors/private-connector-policy.js';

const OWNER_EVENT_BLOCKED_TOOLS = new Set([
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
