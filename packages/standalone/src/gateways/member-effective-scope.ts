import { createHash } from 'node:crypto';

import type { MemoryScopeRef, PrincipalScopeGrantRecord } from '@jungjaehoon/mama-core';
import {
  canonicalizeContextScopes,
  isChannelGranted,
  type ChannelGrant,
} from '@jungjaehoon/mama-core/context-compile';

import type { AdmissionLane, PrincipalContext } from './principal.js';

export interface MemberEffectiveScopeInput {
  readonly principal: PrincipalContext;
  readonly current: {
    readonly connector: string;
    readonly lane: AdmissionLane;
    readonly channelId: string;
  };
  readonly configuredGrant: ChannelGrant;
  readonly principalGrants: readonly PrincipalScopeGrantRecord[];
  readonly narrowing?: {
    readonly sourceGrant?: ChannelGrant;
    readonly memoryScopes?: readonly MemoryScopeRef[];
  };
}

export interface MemberEffectiveScope {
  readonly channelGrant: Readonly<ChannelGrant>;
  readonly memoryScopes: readonly Readonly<MemoryScopeRef>[];
  readonly fingerprint: string;
}

const MEMBER_EFFECTIVE_SCOPE_KEYS = ['channelGrant', 'fingerprint', 'memoryScopes'] as const;

const MAX_SCOPE_COMPONENT_LENGTH = 512;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function isCanonicalComponent(value: unknown, lowercase = false): value is string {
  if (typeof value !== 'string') {
    return false;
  }
  if (
    value.length === 0 ||
    value.length > MAX_SCOPE_COMPONENT_LENGTH ||
    value !== value.trim() ||
    value === '*' ||
    Array.from(value).some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint < 32 || codePoint === 127;
    })
  ) {
    return false;
  }
  return !lowercase || value === value.toLowerCase();
}

function assertActivePublicMember(input: MemberEffectiveScopeInput): string {
  const { principal, current } = input;
  if (
    principal.class !== 'member' ||
    principal.lane !== 'public' ||
    current.lane !== 'public' ||
    current.lane !== principal.lane ||
    !isCanonicalComponent(principal.principalId) ||
    !isCanonicalComponent(current.connector, true) ||
    !isCanonicalComponent(current.channelId)
  ) {
    throw new Error('Member effective scope requires an active public member and canonical facts');
  }
  return principal.principalId;
}

function addChannel(
  channelsByConnector: Map<string, Set<string>>,
  connector: string,
  channel: string
) {
  const channels = channelsByConnector.get(connector) ?? new Set<string>();
  channels.add(channel);
  channelsByConnector.set(connector, channels);
}

function canonicalChannelGrant(channelsByConnector: Map<string, Set<string>>): ChannelGrant {
  const grant = Object.create(null) as ChannelGrant;
  for (const connector of [...channelsByConnector.keys()].sort()) {
    const channels = [...(channelsByConnector.get(connector) ?? [])].sort();
    if (channels.length > 0) {
      grant[connector] = Object.freeze(channels);
    }
  }
  return Object.freeze(grant);
}

function validGrantScope(value: unknown): PrincipalScopeGrantRecord['scope'] | null {
  if (!isRecord(value)) {
    return null;
  }
  if (
    hasOwn(value, 'kind') &&
    hasOwn(value, 'connector') &&
    hasOwn(value, 'channelId') &&
    value.kind === 'source' &&
    isCanonicalComponent(value.connector, true) &&
    isCanonicalComponent(value.channelId)
  ) {
    return { kind: 'source', connector: value.connector, channelId: value.channelId };
  }
  if (
    hasOwn(value, 'kind') &&
    hasOwn(value, 'scopeKind') &&
    hasOwn(value, 'scopeId') &&
    value.kind === 'memory' &&
    (value.scopeKind === 'project' ||
      value.scopeKind === 'channel' ||
      value.scopeKind === 'global') &&
    isCanonicalComponent(value.scopeId)
  ) {
    return { kind: 'memory', scopeKind: value.scopeKind, scopeId: value.scopeId };
  }
  return null;
}

function validGrantRecords(
  records: readonly PrincipalScopeGrantRecord[],
  principalId: string
): Array<PrincipalScopeGrantRecord['scope']> {
  if (!Array.isArray(records)) {
    return [];
  }
  const scopes: Array<PrincipalScopeGrantRecord['scope']> = [];
  for (const candidate of records as readonly unknown[]) {
    if (
      !isRecord(candidate) ||
      !hasOwn(candidate, 'targetPrincipalId') ||
      !hasOwn(candidate, 'scope') ||
      !hasOwn(candidate, 'grantedByPrincipalId') ||
      !hasOwn(candidate, 'createdAt') ||
      candidate.targetPrincipalId !== principalId ||
      !isCanonicalComponent(candidate.grantedByPrincipalId) ||
      typeof candidate.createdAt !== 'number' ||
      !Number.isSafeInteger(candidate.createdAt)
    ) {
      continue;
    }
    const scope = validGrantScope(candidate.scope);
    if (scope !== null) {
      scopes.push(scope);
    }
  }
  return scopes;
}

function canonicalMemoryScopes(scopes: readonly MemoryScopeRef[]): MemoryScopeRef[] {
  return canonicalizeContextScopes(scopes).scopes;
}

function narrowChannels(
  effective: ChannelGrant,
  narrowing: ChannelGrant | undefined
): ChannelGrant {
  if (narrowing === undefined) {
    return effective;
  }
  const narrowed = new Map<string, Set<string>>();
  if (!isRecord(narrowing)) {
    return canonicalChannelGrant(narrowed);
  }
  for (const [connector, channels] of Object.entries(effective)) {
    for (const channel of channels) {
      if (isChannelGranted(connector, channel, narrowing)) {
        addChannel(narrowed, connector, channel);
      }
    }
  }
  return canonicalChannelGrant(narrowed);
}

function narrowMemoryScopes(
  effective: readonly MemoryScopeRef[],
  narrowing: readonly MemoryScopeRef[] | undefined
): MemoryScopeRef[] {
  if (narrowing === undefined) {
    return [...effective];
  }
  const validNarrowing = Array.isArray(narrowing)
    ? narrowing.filter(
        (scope): scope is MemoryScopeRef =>
          isRecord(scope) &&
          (scope.kind === 'project' ||
            scope.kind === 'channel' ||
            scope.kind === 'user' ||
            scope.kind === 'global') &&
          isCanonicalComponent(scope.id)
      )
    : [];
  const requestedKeys = new Set(
    canonicalMemoryScopes(validNarrowing).map((scope) => `${scope.kind}\0${scope.id}`)
  );
  return effective.filter((scope) => requestedKeys.has(`${scope.kind}\0${scope.id}`));
}

function freezeMemoryScopes(
  scopes: readonly MemoryScopeRef[]
): readonly Readonly<MemoryScopeRef>[] {
  return Object.freeze(scopes.map((scope) => Object.freeze({ ...scope })));
}

function fingerprintMemberEffectiveScope(
  principalId: string,
  channelGrant: Readonly<ChannelGrant>,
  memoryScopes: readonly Readonly<MemoryScopeRef>[]
): string {
  return createHash('sha256')
    .update(JSON.stringify({ version: 1, principalId, channelGrant, memoryScopes }), 'utf8')
    .digest('hex');
}

function isDenseArray(value: readonly unknown[]): boolean {
  return Object.keys(value).length === value.length;
}

function isSortedUnique(values: readonly string[]): boolean {
  return values.every((value, index) => index === 0 || values[index - 1] < value);
}

export function assertCanonicalMemberEffectiveScope(
  value: unknown,
  principalId: string
): asserts value is MemberEffectiveScope {
  if (
    !isRecord(value) ||
    !Object.isFrozen(value) ||
    Object.keys(value).sort().join('\0') !== MEMBER_EFFECTIVE_SCOPE_KEYS.join('\0') ||
    !isCanonicalComponent(principalId)
  ) {
    throw new Error('Member effective scope snapshot is empty or invalid');
  }

  const channelGrant = value.channelGrant;
  const memoryScopes = value.memoryScopes;
  const fingerprint = value.fingerprint;
  if (
    !isRecord(channelGrant) ||
    Object.getPrototypeOf(channelGrant) !== null ||
    !Object.isFrozen(channelGrant) ||
    !Array.isArray(memoryScopes) ||
    !isDenseArray(memoryScopes) ||
    !Object.isFrozen(memoryScopes) ||
    typeof fingerprint !== 'string' ||
    !/^[a-f0-9]{64}$/.test(fingerprint)
  ) {
    throw new Error('Member effective scope snapshot is empty or invalid');
  }

  const connectorNames = Object.keys(channelGrant);
  if (!isSortedUnique(connectorNames)) {
    throw new Error('Member effective scope snapshot is empty or invalid');
  }
  for (const connector of connectorNames) {
    const channels = channelGrant[connector];
    if (
      !isCanonicalComponent(connector, true) ||
      !Array.isArray(channels) ||
      channels.length === 0 ||
      !isDenseArray(channels) ||
      !Object.isFrozen(channels) ||
      !channels.every((channel) => isCanonicalComponent(channel)) ||
      !isSortedUnique(channels)
    ) {
      throw new Error('Member effective scope snapshot is empty or invalid');
    }
  }

  if (
    !memoryScopes.every(
      (scope) =>
        isRecord(scope) &&
        Object.isFrozen(scope) &&
        Object.keys(scope).sort().join('\0') === 'id\0kind' &&
        (scope.kind === 'project' ||
          scope.kind === 'channel' ||
          scope.kind === 'user' ||
          scope.kind === 'global') &&
        isCanonicalComponent(scope.id)
    )
  ) {
    throw new Error('Member effective scope snapshot is empty or invalid');
  }
  const canonicalScopes = canonicalMemoryScopes(memoryScopes as readonly MemoryScopeRef[]);
  if (JSON.stringify(canonicalScopes) !== JSON.stringify(memoryScopes)) {
    throw new Error('Member effective scope snapshot is empty or invalid');
  }

  if (
    fingerprint !==
    fingerprintMemberEffectiveScope(
      principalId,
      channelGrant as Readonly<ChannelGrant>,
      memoryScopes
    )
  ) {
    throw new Error('Member effective scope snapshot is empty or invalid');
  }
}

export function resolveMemberEffectiveScope(
  input: MemberEffectiveScopeInput
): MemberEffectiveScope {
  const principalId = assertActivePublicMember(input);
  const grantScopes = validGrantRecords(input.principalGrants, principalId);

  const channelsByConnector = new Map<string, Set<string>>();
  addChannel(channelsByConnector, input.current.connector, input.current.channelId);
  if (isRecord(input.configuredGrant)) {
    for (const scope of grantScopes) {
      if (
        scope.kind === 'source' &&
        isChannelGranted(scope.connector, scope.channelId, input.configuredGrant)
      ) {
        addChannel(channelsByConnector, scope.connector, scope.channelId);
      }
    }
  }
  const channelGrant = narrowChannels(
    canonicalChannelGrant(channelsByConnector),
    input.narrowing?.sourceGrant
  );

  const grantedMemoryScopes: MemoryScopeRef[] = [{ kind: 'user', id: principalId }];
  for (const scope of grantScopes) {
    if (scope.kind === 'memory') {
      grantedMemoryScopes.push({ kind: scope.scopeKind, id: scope.scopeId });
    }
  }
  const memoryScopes = freezeMemoryScopes(
    narrowMemoryScopes(canonicalMemoryScopes(grantedMemoryScopes), input.narrowing?.memoryScopes)
  );

  const fingerprint = fingerprintMemberEffectiveScope(principalId, channelGrant, memoryScopes);

  return Object.freeze({
    channelGrant,
    memoryScopes,
    fingerprint,
  });
}
