import { describe, expect, it } from 'vitest';

import type { PrincipalScopeGrantRecord, PrincipalScopeGrantRef } from '@jungjaehoon/mama-core';
import { isChannelGranted, type ChannelGrant } from '@jungjaehoon/mama-core/context-compile';
import {
  resolveMemberEffectiveScope,
  type MemberEffectiveScopeInput,
} from '../../src/gateways/member-effective-scope.js';
import type { PrincipalContext } from '../../src/gateways/principal.js';

const PRINCIPAL_ID = 'principal_member_7';

const ACTIVE_MEMBER: PrincipalContext = Object.freeze({
  class: 'member',
  lane: 'public',
  canonicalId: 'telegram:global:member-7',
  principalId: PRINCIPAL_ID,
  consoleEligible: false,
});

function grant(
  scope: PrincipalScopeGrantRef,
  overrides: Partial<PrincipalScopeGrantRecord> = {}
): PrincipalScopeGrantRecord {
  return {
    targetPrincipalId: PRINCIPAL_ID,
    scope,
    grantedByPrincipalId: 'principal_owner',
    createdAt: 100,
    ...overrides,
  };
}

function baseInput(overrides: Partial<MemberEffectiveScopeInput> = {}): MemberEffectiveScopeInput {
  return {
    principal: ACTIVE_MEMBER,
    current: { connector: 'telegram', lane: 'public', channelId: 'dm-7' },
    configuredGrant: {
      discord: ['design'],
      slack: ['shared', 'sibling'],
    },
    principalGrants: [],
    ...overrides,
  };
}

function oneConnectorGrant(connector: string, channelId: string): ChannelGrant {
  const configured = Object.create(null) as ChannelGrant;
  Object.defineProperty(configured, connector, {
    configurable: true,
    enumerable: true,
    value: [channelId],
    writable: true,
  });
  return configured;
}

describe('Phase 2b member effective-scope resolver', () => {
  it('returns only the intrinsic conversation/private scope plus explicitly granted shared authority', () => {
    const result = resolveMemberEffectiveScope(
      baseInput({
        principalGrants: [
          grant({ kind: 'source', connector: 'slack', channelId: 'shared' }),
          grant({ kind: 'memory', scopeKind: 'project', scopeId: 'mama' }),
          grant({ kind: 'memory', scopeKind: 'channel', scopeId: 'slack:shared' }),
          grant({ kind: 'memory', scopeKind: 'global', scopeId: 'team' }),
        ],
      })
    );

    expect(result.channelGrant).toEqual({
      slack: ['shared'],
      telegram: ['dm-7'],
    });
    expect(result.memoryScopes).toEqual([
      { kind: 'project', id: 'mama' },
      { kind: 'channel', id: 'slack:shared' },
      { kind: 'user', id: PRINCIPAL_ID },
      { kind: 'global', id: 'team' },
    ]);
    expect(result.fingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  it('does not treat a connector grant as authority for a sibling channel', () => {
    const result = resolveMemberEffectiveScope(
      baseInput({
        principalGrants: [grant({ kind: 'source', connector: 'slack', channelId: 'shared' })],
      })
    );

    expect(result.channelGrant).toEqual({
      slack: ['shared'],
      telegram: ['dm-7'],
    });
    expect(result.channelGrant.slack).not.toContain('sibling');
  });

  it('fails closed for wrong-target, wrong-case, wildcard, and malformed shared grants', () => {
    const malformed = [
      grant({ kind: 'source', connector: 'Slack', channelId: 'shared' }),
      grant({ kind: 'source', connector: '*', channelId: '*' }),
      grant(
        { kind: 'source', connector: 'slack', channelId: 'shared' },
        { targetPrincipalId: 'principal_someone_else' }
      ),
      grant({ kind: 'memory', scopeKind: 'project', scopeId: '*' }),
      {
        targetPrincipalId: PRINCIPAL_ID,
        scope: { kind: 'memory', scopeKind: 'user', scopeId: 'principal_someone_else' },
        grantedByPrincipalId: 'principal_owner',
        createdAt: 100,
      },
      null,
    ] as unknown as readonly PrincipalScopeGrantRecord[];

    const result = resolveMemberEffectiveScope(
      baseInput({
        configuredGrant: { slack: ['shared', '*'] },
        principalGrants: malformed,
      })
    );

    expect(result.channelGrant).toEqual({ telegram: ['dm-7'] });
    expect(result.memoryScopes).toEqual([{ kind: 'user', id: PRINCIPAL_ID }]);
  });

  it.each(['__proto__', 'constructor', 'prototype'])(
    'keeps the %s connector visible in authority and fingerprint canonicalization',
    (connector) => {
      const baseline = resolveMemberEffectiveScope(baseInput());
      const result = resolveMemberEffectiveScope(
        baseInput({
          configuredGrant: oneConnectorGrant(connector, 'shared'),
          principalGrants: [grant({ kind: 'source', connector, channelId: 'shared' })],
        })
      );

      expect(Object.getPrototypeOf(result.channelGrant)).toBeNull();
      expect(Object.keys(result.channelGrant)).toContain(connector);
      expect(isChannelGranted(connector, 'shared', result.channelGrant)).toBe(true);
      expect(result.fingerprint).not.toBe(baseline.fingerprint);
    }
  );

  it('rejects source records with missing or malformed grant metadata', () => {
    const malformedSourceRecords = [
      {
        targetPrincipalId: PRINCIPAL_ID,
        scope: { kind: 'source', connector: 'slack', channelId: 'shared' },
        createdAt: 100,
      },
      {
        targetPrincipalId: PRINCIPAL_ID,
        scope: { kind: 'source', connector: 'slack', channelId: 'shared' },
        grantedByPrincipalId: 'principal_owner',
        createdAt: Number.NaN,
      },
      {
        targetPrincipalId: PRINCIPAL_ID,
        scope: { kind: 'source', connector: 'slack', channelId: 'shared' },
        grantedByPrincipalId: '*',
        createdAt: 100,
      },
    ] as unknown as readonly PrincipalScopeGrantRecord[];

    const result = resolveMemberEffectiveScope(
      baseInput({ principalGrants: malformedSourceRecords })
    );

    expect(result.channelGrant).toEqual({ telegram: ['dm-7'] });
  });

  it('rejects memory records with missing or malformed grant metadata', () => {
    const malformedMemoryRecords = [
      {
        targetPrincipalId: PRINCIPAL_ID,
        scope: { kind: 'memory', scopeKind: 'project', scopeId: 'mama' },
        grantedByPrincipalId: 'principal_owner',
      },
      {
        targetPrincipalId: PRINCIPAL_ID,
        scope: { kind: 'memory', scopeKind: 'project', scopeId: 'mama' },
        grantedByPrincipalId: 7,
        createdAt: 100,
      },
      {
        targetPrincipalId: PRINCIPAL_ID,
        scope: { kind: 'memory', scopeKind: 'project', scopeId: 'mama' },
        grantedByPrincipalId: 'principal_owner',
        createdAt: Number.POSITIVE_INFINITY,
      },
    ] as unknown as readonly PrincipalScopeGrantRecord[];

    const result = resolveMemberEffectiveScope(
      baseInput({ principalGrants: malformedMemoryRecords })
    );

    expect(result.memoryScopes).toEqual([{ kind: 'user', id: PRINCIPAL_ID }]);
  });

  it('lets caller and envelope narrowing remove authority but never add it', () => {
    const result = resolveMemberEffectiveScope(
      baseInput({
        principalGrants: [
          grant({ kind: 'source', connector: 'slack', channelId: 'shared' }),
          grant({ kind: 'memory', scopeKind: 'project', scopeId: 'mama' }),
        ],
        narrowing: {
          sourceGrant: {
            discord: ['design'],
            slack: ['sibling'],
            telegram: ['dm-7'],
          },
          memoryScopes: [
            { kind: 'user', id: PRINCIPAL_ID },
            { kind: 'project', id: 'ungranted' },
          ],
        },
      })
    );

    expect(result.channelGrant).toEqual({ telegram: ['dm-7'] });
    expect(result.memoryScopes).toEqual([{ kind: 'user', id: PRINCIPAL_ID }]);

    const empty = resolveMemberEffectiveScope(
      baseInput({
        principalGrants: [
          grant({ kind: 'source', connector: 'slack', channelId: 'shared' }),
          grant({ kind: 'memory', scopeKind: 'project', scopeId: 'mama' }),
        ],
        narrowing: { sourceGrant: {}, memoryScopes: [] },
      })
    );
    expect(empty.channelGrant).toEqual({});
    expect(empty.memoryScopes).toEqual([]);
  });

  it('canonicalizes order and duplicates while ignoring timestamps and grantor identity in the fingerprint', () => {
    const first = resolveMemberEffectiveScope(
      baseInput({
        configuredGrant: { slack: ['sibling', 'shared', 'shared'] },
        principalGrants: [
          grant({ kind: 'memory', scopeKind: 'global', scopeId: 'team' }),
          grant({ kind: 'source', connector: 'slack', channelId: 'shared' }),
          grant({ kind: 'memory', scopeKind: 'project', scopeId: 'mama' }),
          grant({ kind: 'source', connector: 'slack', channelId: 'shared' }),
        ],
      })
    );
    const reordered = resolveMemberEffectiveScope(
      baseInput({
        configuredGrant: { slack: ['shared', 'sibling'] },
        principalGrants: [
          grant(
            { kind: 'source', connector: 'slack', channelId: 'shared' },
            { createdAt: 999, grantedByPrincipalId: 'principal_old_owner' }
          ),
          grant(
            { kind: 'memory', scopeKind: 'project', scopeId: 'mama' },
            { createdAt: 998, grantedByPrincipalId: 'principal_old_owner' }
          ),
          grant(
            { kind: 'memory', scopeKind: 'global', scopeId: 'team' },
            { createdAt: 997, grantedByPrincipalId: 'principal_old_owner' }
          ),
        ],
      })
    );

    expect(reordered.channelGrant).toEqual(first.channelGrant);
    expect(reordered.memoryScopes).toEqual(first.memoryScopes);
    expect(reordered.fingerprint).toBe(first.fingerprint);

    const sourceChanged = resolveMemberEffectiveScope(
      baseInput({
        configuredGrant: { slack: ['shared'] },
        principalGrants: [
          grant({ kind: 'memory', scopeKind: 'project', scopeId: 'mama' }),
          grant({ kind: 'memory', scopeKind: 'global', scopeId: 'team' }),
        ],
      })
    );
    expect(sourceChanged.memoryScopes).toEqual(first.memoryScopes);
    expect(sourceChanged.fingerprint).not.toBe(first.fingerprint);

    const memoryChanged = resolveMemberEffectiveScope(
      baseInput({
        configuredGrant: { slack: ['shared'] },
        principalGrants: [
          grant({ kind: 'source', connector: 'slack', channelId: 'shared' }),
          grant({ kind: 'memory', scopeKind: 'project', scopeId: 'different-project' }),
          grant({ kind: 'memory', scopeKind: 'global', scopeId: 'team' }),
        ],
      })
    );
    expect(memoryChanged.channelGrant).toEqual(first.channelGrant);
    expect(memoryChanged.fingerprint).not.toBe(first.fingerprint);
  });

  it('returns a deeply frozen detached snapshot and rejects non-member authority paths', () => {
    const configuredGrant: ChannelGrant = { slack: ['shared'] };
    const principalGrants = [grant({ kind: 'source', connector: 'slack', channelId: 'shared' })];
    const result = resolveMemberEffectiveScope(baseInput({ configuredGrant, principalGrants }));

    configuredGrant.slack = ['sibling'];
    principalGrants[0] = grant({ kind: 'source', connector: 'discord', channelId: 'design' });

    expect(result.channelGrant).toEqual({
      slack: ['shared'],
      telegram: ['dm-7'],
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.channelGrant)).toBe(true);
    expect(Object.isFrozen(result.channelGrant.slack)).toBe(true);
    expect(Object.isFrozen(result.memoryScopes)).toBe(true);
    expect(Object.isFrozen(result.memoryScopes[0])).toBe(true);
    expect(() => {
      (result.channelGrant.slack as string[]).push('sibling');
    }).toThrow();

    expect(() =>
      resolveMemberEffectiveScope(
        baseInput({
          principal: { ...ACTIVE_MEMBER, class: 'owner', lane: 'owner' },
          current: { connector: 'telegram', lane: 'owner', channelId: 'dm-7' },
        })
      )
    ).toThrow(/active public member/i);
  });
});
