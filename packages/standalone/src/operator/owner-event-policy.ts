import type { BackendType } from '../agent/model-runner.js';
import type { AgentContext } from '../agent/types.js';
import type { RoleConfig } from '../cli/config/types.js';
import type { PrivateConnectorPolicy } from '../connectors/private-connector-policy.js';

/**
 * Owner-authored chat only: membership, scope and standing-policy administration require an
 * interactive owner. Input source is observation metadata, not ordinary business authority.
 *
 * The single definition for every unattended surface - start.ts re-exports it as
 * ADMINISTRATION_TOOLS, so the two lists cannot drift apart again.
 */
export const ADMINISTRATION_TOOLS: ReadonlySet<string> = new Set([
  'member_register',
  'member_suspend',
  'member_offboard',
  'member_scope_grant',
  'member_scope_revoke',
  'console_brief_update',
]);

export function resolveOwnerEventExecution(input: {
  issuance: 'off' | 'enabled' | 'required';
  hasAuthority: boolean;
}): { enabled: true } | { enabled: false; reason: string } {
  return input.issuance !== 'off' && input.hasAuthority
    ? { enabled: true }
    : { enabled: false, reason: 'owner-event requires envelope authority' };
}

/**
 * The workspace shell and file writer belong to the owner's OWN chat turn (owner decision
 * 2026-09-04). Every unattended turn blocks both BY NAME: no one is in the loop to see
 * what a shell command did.
 */
export const UNATTENDED_BLOCKED_TOOLS: ReadonlySet<string> = new Set([
  ...ADMINISTRATION_TOOLS,
  'Bash',
  'Write',
]);

/**
 * Project any role onto the unattended surface. Used for owner-event turns and for a
 * native subagent, which is unattended by definition: it outlives the turn that started
 * it and reports to no one inside it.
 */
export function projectUnattendedRole(role: RoleConfig): RoleConfig {
  return {
    ...role,
    allowedTools: role.allowedTools.filter((tool) => !UNATTENDED_BLOCKED_TOOLS.has(tool)),
    blockedTools: [...new Set([...(role.blockedTools ?? []), ...UNATTENDED_BLOCKED_TOOLS])],
  };
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
      (tool) => !UNATTENDED_BLOCKED_TOOLS.has(tool)
    ),
    blockedTools: [
      ...new Set([...(input.ownerRole.blockedTools ?? []), ...UNATTENDED_BLOCKED_TOOLS]),
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
