import type { BackendType } from '../agent/model-runner.js';
import type { AgentContext, PrincipalRepository } from '../agent/types.js';
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

const CONFIGURED_OWNER_SINGLETON_ID = 'singleton';

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

export interface ConfiguredOwnerPrincipalResolver {
  resolve(
    connector: string,
    namespace: string,
    externalId: string
  ): { principalId: string; kind: 'owner' | 'member'; status: string } | null;
  requireOwnerPrincipalId(): string;
}

export function createConfiguredOwnerPrincipalResolver(input: {
  repository: PrincipalRepository;
  ownerExternalIds: {
    telegram?: readonly string[];
    slack?: string;
    discord?: string;
  };
  now?: () => number;
}): ConfiguredOwnerPrincipalResolver {
  const now = input.now ?? Date.now;
  const configured = new Map<string, ReadonlySet<string>>([
    ['telegram', new Set(input.ownerExternalIds.telegram ?? [])],
    ['slack', new Set(input.ownerExternalIds.slack ? [input.ownerExternalIds.slack] : [])],
    ['discord', new Set(input.ownerExternalIds.discord ? [input.ownerExternalIds.discord] : [])],
  ]);
  let ownerPrincipalId: string | null = null;

  const acceptOwner = (row: { principalId: string; kind: string; status: string }): string => {
    if (row.kind !== 'owner' || row.status !== 'active') {
      throw new Error('Configured owner identity is not bound to an active owner principal');
    }
    if (ownerPrincipalId && ownerPrincipalId !== row.principalId) {
      throw new Error('Configured owner identities resolve to different owner principals');
    }
    ownerPrincipalId = row.principalId;
    return row.principalId;
  };

  for (const externalId of configured.get('telegram') ?? []) {
    const row = input.repository.resolveByExternal('telegram', 'global', externalId);
    if (row) {
      acceptOwner(row);
    }
  }

  const hasConfiguredIdentity = [...configured.values()].some(
    (externalIds) => externalIds.size > 0
  );
  const canonicalExternalId = CONFIGURED_OWNER_SINGLETON_ID;
  const existingSingleton = input.repository.resolveByExternal(
    'mama',
    'configured-owner',
    canonicalExternalId
  );
  if (existingSingleton) {
    acceptOwner(existingSingleton);
  } else if (hasConfiguredIdentity) {
    if (ownerPrincipalId) {
      input.repository.bindIdentity(
        ownerPrincipalId,
        'mama',
        'configured-owner',
        canonicalExternalId,
        now()
      );
    } else {
      const outcome = input.repository.ensureOwner({
        connector: 'mama',
        namespace: 'configured-owner',
        externalId: canonicalExternalId,
        now: now(),
      });
      if (outcome === 'conflict') {
        throw new Error('Configured owner contract conflicts with the durable owner principal');
      }
      const created = input.repository.resolveByExternal(
        'mama',
        'configured-owner',
        canonicalExternalId
      );
      if (!created) {
        throw new Error('Configured owner contract did not persist');
      }
      acceptOwner(created);
    }
  }

  const resolve: ConfiguredOwnerPrincipalResolver['resolve'] = (
    connector,
    namespace,
    externalId
  ) => {
    const existing = input.repository.resolveByExternal(connector, namespace, externalId);
    const isConfiguredOwner = configured.get(connector)?.has(externalId) === true;
    if (!isConfiguredOwner) {
      return existing;
    }
    if (existing) {
      acceptOwner(existing);
      return existing;
    }
    if (ownerPrincipalId) {
      input.repository.bindIdentity(ownerPrincipalId, connector, namespace, externalId, now());
    } else {
      const outcome = input.repository.ensureOwner({
        connector,
        namespace,
        externalId,
        now: now(),
      });
      if (outcome === 'conflict') {
        throw new Error('Configured owner identity conflicts with the durable owner principal');
      }
    }
    const bound = input.repository.resolveByExternal(connector, namespace, externalId);
    if (!bound) {
      throw new Error('Configured owner identity binding did not persist');
    }
    acceptOwner(bound);
    return bound;
  };

  return {
    resolve,
    requireOwnerPrincipalId: () => {
      if (!ownerPrincipalId) {
        throw new Error('Authenticated owner principal is unavailable');
      }
      return ownerPrincipalId;
    },
  };
}

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
  principalId: string;
  ownerRole: RoleConfig;
  privateConnectorPolicy: PrivateConnectorPolicy;
}): AgentContext {
  const principalId = typeof input.principalId === 'string' ? input.principalId.trim() : '';
  if (!principalId) {
    throw new Error('Authenticated owner principal is required for unattended work');
  }
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
    principalId,
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
