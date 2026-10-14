import { createPrincipalRepository, type PrincipalRow } from '@jungjaehoon/mama-core';
import type { DatabaseInstance } from '@jungjaehoon/mama-core/db-manager';
import type { JudgmentAccess } from '@jungjaehoon/mama-core/knowledge';
import type { MemoryScopeRef } from '@jungjaehoon/mama-core/memory/types';
import { MEMBER_ACTIONS } from './action-surface.js';
import { MEMBER_MANAGEMENT_ACTIONS } from '../api/member-lifecycle.js';
import { holdsOwnerRole } from './owner-authority.js';

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

export function roomChatFloor(access: JudgmentAccess): number | undefined {
  return (access as JudgmentAccess & { roomChatFloor?: number }).roomChatFloor;
}

export interface PrincipalAccessOptions {
  adapter: DatabaseInstance;
  ownerAccess: JudgmentAccess;
  agentId: string;
  sessionKey?: string;
  /** The common channel; only a room there reads and changes owner policy. */
  commonChannelId?: string;
}

export function memberRoomSessionKey(principalId: string, channel: string): string {
  return `member:${principalId}:room:telegram:${channel}`;
}

export function memberRoomChannel(principalId: string, key?: string): string | undefined {
  const prefix = `member:${principalId}:room:telegram:`;
  return key?.startsWith(prefix) && key.length > prefix.length
    ? key.slice(prefix.length)
    : undefined;
}

/** Set only by the host's session-key resolver, never by action input. */
export function roomChannel(access: JudgmentAccess): string | undefined {
  return (access as JudgmentAccess & { roomChannel?: string }).roomChannel;
}

/** Registry-backed authority for future member turns; admission is wired separately. */
export function resolvePrincipalAccess(
  principalId: string,
  options: PrincipalAccessOptions
): JudgmentAccess {
  const { adapter, ownerAccess, agentId } = options;
  const principal = adapter
    .prepare('SELECT kind, status, created_at FROM principals WHERE principal_id = ?')
    .get(principalId) as
    | (Pick<PrincipalRow, 'kind' | 'status'> & { created_at: number })
    | undefined;
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
  const room = memberRoomChannel(principalId, options.sessionKey);
  const repository = createPrincipalRepository(adapter);
  const ownerRole = holdsOwnerRole(repository, principalId);
  // Unscoped owner work binds its defaults; partition write authority does not make a default.
  const readScopes: MemoryScopeRef[] = [];
  const connectors = new Set(['chat']);
  // chat-sources stores gateway channelKey under the transport prefix.
  const channels: Record<string, string[]> = { chat: [`telegram:${dmId}`] };
  for (const { scope } of repository.listActiveGrants(principalId)) {
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
  if (room !== undefined) {
    const scopes = [
      ...new Map(readScopes.map((scope) => [`${scope.kind}\0${scope.id}`, scope])).values(),
    ];
    return {
      principalId,
      agentId,
      scopes,
      readScopes: scopes,
      defaultScopes: [],
      connectors: [...connectors],
      channels: { ...channels, chat: [`telegram:${room}`] },
      destinations: [{ kind: 'telegram', id: room }],
      actions: [
        ...MEMBER_ACTIONS.filter(
          (action) =>
            !action.startsWith('schedule.job.') &&
            !action.startsWith('memory.checkpoint.') &&
            // Skills include the person's own workflows, and core graph and provenance reads do
            // not know the room's enrollment floor; the room's source reads apply it.
            ![
              'memory.share',
              'records.export',
              'records.erase',
              'skill.list',
              'skill.read',
              'graph.query',
              'memory.read:provenance',
            ].includes(action)
        ),
        'work.create',
        'work.revise',
        'work.link',
        'work.no_update',
        ...(room === options.commonChannelId ? ['manage.policy.read', 'manage.policy.update'] : []),
      ],
      roomChannel: room,
      roomChatFloor: principal.created_at,
    } as JudgmentAccess;
  }
  if (ownerRole) {
    readScopes.push(...ownerAccess.scopes, ...(ownerAccess.readScopes ?? []));
    for (const connector of ownerAccess.connectors ?? []) connectors.add(connector);
    // The shared authority never turns another person's Telegram DM into a common source.
    const privateChannels = new Set(
      (
        adapter
          .prepare(
            `SELECT external_id FROM external_identities
          WHERE connector = 'telegram' AND namespace = 'private' AND principal_id <> ?`
          )
          .all(principalId) as Array<{ external_id: string }>
      ).map(({ external_id }) => `telegram:${external_id}`)
    );
    for (const [connector, commonChannels] of Object.entries(ownerAccess.channels ?? {})) {
      channels[connector] = [
        ...new Set([
          ...(channels[connector] ?? []),
          ...commonChannels.filter(
            (channel) => connector !== 'chat' || !privateChannels.has(channel)
          ),
        ]),
      ];
    }
  }
  const personalScope = { kind: 'user' as const, id: principalId };
  return {
    principalId,
    agentId,
    scopes: [personalScope],
    defaultScopes: [personalScope],
    readScopes: [
      ...new Map(readScopes.map((scope) => [`${scope.kind}\0${scope.id}`, scope])).values(),
    ],
    connectors: [...connectors],
    channels,
    destinations: [{ kind: 'telegram', id: dmId }],
    ...(ownerRole
      ? {
          connectorWideRead: (ownerAccess.connectorWideRead ?? []).filter(
            (source) => source !== 'chat'
          ),
        }
      : {}),
    actions: ownerRole
      ? [
          ...MEMBER_ACTIONS,
          'drive.read',
          'report.read',
          ...MEMBER_MANAGEMENT_ACTIONS,
          'manage.member.enroll',
        ]
      : MEMBER_ACTIONS,
  };
}
