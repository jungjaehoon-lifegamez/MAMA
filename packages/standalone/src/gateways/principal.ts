export type PrincipalClass = 'owner' | 'member' | 'external';

export type AdmissionLane = 'owner' | 'public' | 'divert';

export interface PrincipalContext {
  readonly class: PrincipalClass;
  readonly lane: AdmissionLane;
  readonly canonicalId: string;
  readonly principalId?: string;
  readonly consoleEligible: boolean;
}

export interface TelegramPrincipalInput {
  readonly userId: string;
  readonly chatId: string;
  readonly chatType: string;
  readonly allowedChats: ReadonlySet<string>;
  readonly ownerUserIds?: ReadonlySet<string>;
}

export interface ConnectorPrincipalInput {
  readonly connector: string;
  readonly namespace: string;
  readonly userId: string;
  readonly ownerUserId?: string;
  readonly isDirectMessage: boolean;
}

function freezePrincipal(context: PrincipalContext): PrincipalContext {
  return Object.freeze(context);
}

function normalizedIds(ids: ReadonlySet<string>): ReadonlySet<string> {
  return new Set(Array.from(ids, (id) => id.trim()).filter((id) => id.length > 0));
}

function telegramOwnerUserIds(input: TelegramPrincipalInput): ReadonlySet<string> {
  if (input.ownerUserIds !== undefined) {
    return normalizedIds(input.ownerUserIds);
  }

  const positiveAllowedChatIds = Array.from(normalizedIds(input.allowedChats)).filter((chatId) =>
    /^[1-9]\d*$/.test(chatId)
  );
  return positiveAllowedChatIds.length === 1
    ? new Set([positiveAllowedChatIds[0]])
    : new Set();
}

export function resolveTelegramPrincipal(input: TelegramPrincipalInput): PrincipalContext {
  const ownerUserIds = telegramOwnerUserIds(input);
  const canonicalId = `telegram:global:${input.userId}`;

  if (ownerUserIds.size === 0) {
    return freezePrincipal({
      class: 'external',
      lane: 'divert',
      canonicalId,
      consoleEligible: false,
    });
  }

  if (ownerUserIds.has(input.userId)) {
    return freezePrincipal({
      class: 'owner',
      lane: 'owner',
      canonicalId,
      consoleEligible: input.chatType === 'private',
    });
  }

  const allowedChats = normalizedIds(input.allowedChats);
  return freezePrincipal({
    class: 'external',
    lane: allowedChats.has(input.chatId) ? 'public' : 'divert',
    canonicalId,
    consoleEligible: false,
  });
}

export function resolveConnectorPrincipal(input: ConnectorPrincipalInput): PrincipalContext {
  const isOwner = input.ownerUserId !== undefined && input.ownerUserId === input.userId;
  return freezePrincipal({
    class: isOwner ? 'owner' : 'external',
    lane: isOwner ? 'owner' : 'divert',
    canonicalId: `${input.connector}:${input.namespace}:${input.userId}`,
    consoleEligible: isOwner && input.isDirectMessage,
  });
}

export function makeHostPrincipal(source: string): PrincipalContext {
  return freezePrincipal({
    class: 'owner',
    lane: 'owner',
    canonicalId: `${source}:host:host`,
    consoleEligible: true,
  });
}

export function laneChannelId(channelId: string, lane: AdmissionLane): string {
  return lane === 'public' ? `${channelId}#public` : channelId;
}
