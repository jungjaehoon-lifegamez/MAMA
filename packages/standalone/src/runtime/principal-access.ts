import { createPrincipalRepository, type PrincipalRow } from '@jungjaehoon/mama-core';
import type { DatabaseInstance } from '@jungjaehoon/mama-core/db-manager';
import type { JudgmentAccess } from '@jungjaehoon/mama-core/knowledge';
import type { MemoryScopeRef } from '@jungjaehoon/mama-core/memory/types';
import { MEMBER_ACTIONS } from './action-surface.js';

/** A member grant must not expose the owner's default records or make boot/turn access fail. */
export function validateMemberMemoryGrant(
  scope: { scopeKind: string; scopeId: string },
  ownerAccess: JudgmentAccess
): void {
  if (
    (ownerAccess.defaultScopes ?? ownerAccess.scopes).some(
      (defaultScope) => defaultScope.kind === scope.scopeKind && defaultScope.id === scope.scopeId
    )
  )
    throw new Error(
      `member memory grant overlaps owner default scope: ${scope.scopeKind}:${scope.scopeId}`
    );
}

export interface PrincipalAccessOptions {
  adapter: DatabaseInstance;
  ownerAccess: JudgmentAccess;
  agentId: string;
}

/** Registry-backed authority for future member turns; admission is wired separately. */
export function resolvePrincipalAccess(
  principalId: string,
  options: PrincipalAccessOptions
): JudgmentAccess {
  const { adapter, ownerAccess, agentId } = options;
  const principal = adapter
    .prepare('SELECT kind, status FROM principals WHERE principal_id = ?')
    .get(principalId) as Pick<PrincipalRow, 'kind' | 'status'> | undefined;
  if (!principal) throw new Error(`unknown principal: ${principalId}`);
  if (principal.status !== 'active')
    throw new Error(`principal ${principalId} is ${principal.status}`);
  if (principal.kind === 'owner') {
    if (principalId !== ownerAccess.principalId)
      throw new Error(`principal ${principalId} is not the configured owner`);
    return ownerAccess;
  }

  const identities = adapter
    .prepare(
      `SELECT external_id FROM external_identities
      WHERE principal_id = ? AND connector = 'telegram' AND namespace = 'private'`
    )
    .all(principalId) as Array<{ external_id: string }>;
  if (identities.length !== 1)
    throw new Error(`member ${principalId} requires exactly one Telegram private identity`);
  const dmId = identities[0]!.external_id;
  // Unscoped owner work binds its defaults; partition write authority does not make a default.
  const readScopes: MemoryScopeRef[] = [];
  const connectors = new Set(['chat']);
  // chat-sources stores gateway channelKey under the transport prefix.
  const channels: Record<string, string[]> = { chat: [`telegram:${dmId}`] };
  for (const { scope } of createPrincipalRepository(adapter).listActiveGrants(principalId)) {
    if (scope.kind === 'memory') {
      validateMemberMemoryGrant(scope, ownerAccess);
      readScopes.push({ kind: scope.scopeKind, id: scope.scopeId });
    } else {
      connectors.add(scope.connector);
      const granted = channels[scope.connector] ?? [];
      if (!granted.includes(scope.channelId)) granted.push(scope.channelId);
      channels[scope.connector] = granted;
    }
  }
  const personalScope = { kind: 'user' as const, id: principalId };
  return {
    principalId,
    agentId,
    scopes: [personalScope],
    defaultScopes: [personalScope],
    readScopes,
    connectors: [...connectors],
    channels,
    destinations: [{ kind: 'telegram', id: dmId }],
    actions: MEMBER_ACTIONS,
  };
}
