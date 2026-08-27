import { createHash } from 'node:crypto';
import { types as nodeUtilTypes } from 'node:util';

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

function isSortedUnique(values: readonly string[]): boolean {
  for (let index = 1; index < values.length; index += 1) {
    if (values[index - 1] >= values[index]) {
      return false;
    }
  }
  return true;
}

function exactOwnDataValues(
  value: object,
  expectedNames: readonly string[]
): Record<string, unknown> | null {
  if (nodeUtilTypes.isProxy(value) || Object.getOwnPropertySymbols(value).length > 0) {
    return null;
  }
  const names = Object.getOwnPropertyNames(value);
  if (names.length !== expectedNames.length) {
    return null;
  }
  const sortedNames = [...names].sort();
  const sortedExpected = [...expectedNames].sort();
  for (let index = 0; index < sortedExpected.length; index += 1) {
    if (sortedNames[index] !== sortedExpected[index]) {
      return null;
    }
  }
  const values = Object.create(null) as Record<string, unknown>;
  for (const name of expectedNames) {
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    if (!descriptor || !('value' in descriptor) || descriptor.enumerable !== true) {
      return null;
    }
    values[name] = descriptor.value;
  }
  return values;
}

function exactFrozenArrayValues(value: unknown): unknown[] | null {
  if (
    nodeUtilTypes.isProxy(value) ||
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    !Object.isFrozen(value) ||
    Object.getOwnPropertySymbols(value).length > 0
  ) {
    return null;
  }
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
  if (
    !lengthDescriptor ||
    !('value' in lengthDescriptor) ||
    !Number.isSafeInteger(lengthDescriptor.value) ||
    lengthDescriptor.value < 0
  ) {
    return null;
  }
  const length = lengthDescriptor.value as number;
  const names = Object.getOwnPropertyNames(value);
  if (names.length !== length + 1 || !names.includes('length')) {
    return null;
  }
  const copy: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !('value' in descriptor) || descriptor.enumerable !== true) {
      return null;
    }
    copy.push(descriptor.value);
  }
  return copy;
}

export function assertCanonicalMemberEffectiveScope(
  value: unknown,
  principalId: string
): asserts value is MemberEffectiveScope {
  if (
    nodeUtilTypes.isProxy(value) ||
    !isRecord(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    !Object.isFrozen(value) ||
    !isCanonicalComponent(principalId)
  ) {
    throw new Error('Member effective scope snapshot is empty or invalid');
  }

  const outer = exactOwnDataValues(value, MEMBER_EFFECTIVE_SCOPE_KEYS);
  if (!outer) {
    throw new Error('Member effective scope snapshot is empty or invalid');
  }
  const channelGrant = outer.channelGrant;
  const memoryScopes = outer.memoryScopes;
  const fingerprint = outer.fingerprint;
  if (
    nodeUtilTypes.isProxy(channelGrant) ||
    !isRecord(channelGrant) ||
    Object.getPrototypeOf(channelGrant) !== null ||
    !Object.isFrozen(channelGrant) ||
    Object.getOwnPropertySymbols(channelGrant).length > 0 ||
    typeof fingerprint !== 'string' ||
    !/^[a-f0-9]{64}$/.test(fingerprint)
  ) {
    throw new Error('Member effective scope snapshot is empty or invalid');
  }

  const connectorNames = Object.getOwnPropertyNames(channelGrant);
  if (!isSortedUnique(connectorNames)) {
    throw new Error('Member effective scope snapshot is empty or invalid');
  }
  const channelsByConnector = new Map<string, Set<string>>();
  for (const connector of connectorNames) {
    const descriptor = Object.getOwnPropertyDescriptor(channelGrant, connector);
    if (!descriptor || !('value' in descriptor) || descriptor.enumerable !== true) {
      throw new Error('Member effective scope snapshot is empty or invalid');
    }
    const channelValues = exactFrozenArrayValues(descriptor.value);
    if (
      !isCanonicalComponent(connector, true) ||
      !channelValues ||
      channelValues.length === 0 ||
      !channelValues.every((channel) => isCanonicalComponent(channel))
    ) {
      throw new Error('Member effective scope snapshot is empty or invalid');
    }
    const channels = channelValues as string[];
    if (!isSortedUnique(channels)) {
      throw new Error('Member effective scope snapshot is empty or invalid');
    }
    channelsByConnector.set(connector, new Set(channels));
  }

  const memoryScopeValues = exactFrozenArrayValues(memoryScopes);
  if (!memoryScopeValues) {
    throw new Error('Member effective scope snapshot is empty or invalid');
  }
  const copiedScopes: MemoryScopeRef[] = [];
  for (const candidate of memoryScopeValues) {
    if (
      nodeUtilTypes.isProxy(candidate) ||
      !isRecord(candidate) ||
      Object.getPrototypeOf(candidate) !== Object.prototype ||
      !Object.isFrozen(candidate)
    ) {
      throw new Error('Member effective scope snapshot is empty or invalid');
    }
    const fields = exactOwnDataValues(candidate, ['id', 'kind']);
    if (
      !fields ||
      (fields.kind !== 'project' &&
        fields.kind !== 'channel' &&
        fields.kind !== 'user' &&
        fields.kind !== 'global') ||
      !isCanonicalComponent(fields.id)
    ) {
      throw new Error('Member effective scope snapshot is empty or invalid');
    }
    copiedScopes.push({ kind: fields.kind, id: fields.id });
  }
  const canonicalScopes = canonicalMemoryScopes(copiedScopes);
  if (JSON.stringify(canonicalScopes) !== JSON.stringify(copiedScopes)) {
    throw new Error('Member effective scope snapshot is empty or invalid');
  }

  const canonicalGrant = canonicalChannelGrant(channelsByConnector);
  const canonicalFrozenScopes = freezeMemoryScopes(canonicalScopes);
  if (
    fingerprint !==
    fingerprintMemberEffectiveScope(principalId, canonicalGrant, canonicalFrozenScopes)
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
