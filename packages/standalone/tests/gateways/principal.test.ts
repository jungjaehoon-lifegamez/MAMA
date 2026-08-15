import { describe, expect, it } from 'vitest';
import type { PrincipalClass, PrincipalContext } from '../../src/gateways/principal.js';
import {
  laneChannelId,
  makeHostPrincipal,
  overlayMemberPrincipal,
  resolveConnectorPrincipal,
  resolveTelegramPrincipal,
} from '../../src/gateways/principal.js';

describe('Gateway principal resolution', () => {
  describe('PrincipalContext contract', () => {
    it('accepts a member class and keeps principalId optional through freezing', () => {
      const memberClass: PrincipalClass = 'member';
      const withoutPrincipalId: PrincipalContext = Object.freeze({
        class: memberClass,
        lane: 'public',
        canonicalId: 'telegram:global:1002',
        consoleEligible: false,
      });
      const withPrincipalId: PrincipalContext = Object.freeze({
        ...withoutPrincipalId,
        principalId: 'principal-1002',
      });

      expect(withoutPrincipalId.principalId).toBeUndefined();
      expect(withPrincipalId.principalId).toBe('principal-1002');
      expect(Object.isFrozen(withoutPrincipalId)).toBe(true);
      expect(Object.isFrozen(withPrincipalId)).toBe(true);
    });
  });

  describe('resolveTelegramPrincipal()', () => {
    it('resolves an explicitly configured owner on a private surface', () => {
      const principal = resolveTelegramPrincipal({
        userId: '1001',
        chatId: '1001',
        chatType: 'private',
        allowedChats: new Set(['1001']),
        ownerUserIds: new Set(['1001']),
      });

      expect(principal).toEqual({
        class: 'owner',
        lane: 'owner',
        canonicalId: 'telegram:global:1001',
        consoleEligible: true,
      });
      expect(Object.isFrozen(principal)).toBe(true);
    });

    it('derives the owner from exactly one positive allowlisted chat ID', () => {
      const principal = resolveTelegramPrincipal({
        userId: '1001',
        chatId: '1001',
        chatType: 'private',
        allowedChats: new Set(['1001', '-2001']),
      });

      expect(principal.class).toBe('owner');
      expect(principal.lane).toBe('owner');
      expect(principal.consoleEligible).toBe(true);
    });

    it('gives explicit owner IDs priority over allowlist derivation', () => {
      const principal = resolveTelegramPrincipal({
        userId: '1001',
        chatId: '1001',
        chatType: 'private',
        allowedChats: new Set(['1001']),
        ownerUserIds: new Set(['1002']),
      });

      expect(principal).toEqual({
        class: 'external',
        lane: 'public',
        canonicalId: 'telegram:global:1001',
        consoleEligible: false,
      });
    });

    it('keeps an owner on the owner lane without console eligibility in a group', () => {
      const principal = resolveTelegramPrincipal({
        userId: '1001',
        chatId: '-2001',
        chatType: 'group',
        allowedChats: new Set(['-2001']),
        ownerUserIds: new Set(['1001']),
      });

      expect(principal.class).toBe('owner');
      expect(principal.lane).toBe('owner');
      expect(principal.consoleEligible).toBe(false);
    });

    it('keeps an external group sender external while admitting only the public lane', () => {
      const principal = resolveTelegramPrincipal({
        userId: '1002',
        chatId: '-2001',
        chatType: 'group',
        allowedChats: new Set(['-2001']),
        ownerUserIds: new Set(['1001']),
      });

      expect(principal).toEqual({
        class: 'external',
        lane: 'public',
        canonicalId: 'telegram:global:1002',
        consoleEligible: false,
      });
    });

    it('diverts every sender when explicit owner IDs are empty', () => {
      const principal = resolveTelegramPrincipal({
        userId: '1002',
        chatId: '-2001',
        chatType: 'group',
        allowedChats: new Set(['-2001']),
        ownerUserIds: new Set(),
      });

      expect(principal.class).toBe('external');
      expect(principal.lane).toBe('divert');
      expect(principal.consoleEligible).toBe(false);
    });

    it('rejects ambiguous derivation from two positive allowlisted IDs', () => {
      const principals = ['1001', '1002'].map((userId) =>
        resolveTelegramPrincipal({
          userId,
          chatId: userId,
          chatType: 'private',
          allowedChats: new Set(['1001', '1002']),
        })
      );

      expect(principals.map((principal) => principal.class)).toEqual(['external', 'external']);
      expect(principals.map((principal) => principal.lane)).toEqual(['divert', 'divert']);
    });

    it('diverts an external sender on a surface outside the allowlist', () => {
      const principal = resolveTelegramPrincipal({
        userId: '1002',
        chatId: '-2002',
        chatType: 'group',
        allowedChats: new Set(['-2001']),
        ownerUserIds: new Set(['1001']),
      });

      expect(principal.class).toBe('external');
      expect(principal.lane).toBe('divert');
    });
  });

  describe('resolveConnectorPrincipal()', () => {
    it('resolves a configured owner in a direct message', () => {
      const principal = resolveConnectorPrincipal({
        connector: 'slack',
        namespace: 'team-a',
        userId: '1001',
        ownerUserId: '1001',
        isDirectMessage: true,
      });

      expect(principal).toEqual({
        class: 'owner',
        lane: 'owner',
        canonicalId: 'slack:team-a:1001',
        consoleEligible: true,
      });
      expect(Object.isFrozen(principal)).toBe(true);
    });

    it('does not grant console eligibility to an owner outside a direct message', () => {
      const principal = resolveConnectorPrincipal({
        connector: 'discord',
        namespace: 'guild-a',
        userId: '1001',
        ownerUserId: '1001',
        isDirectMessage: false,
      });

      expect(principal.class).toBe('owner');
      expect(principal.lane).toBe('owner');
      expect(principal.consoleEligible).toBe(false);
    });

    it('diverts a non-owner instead of admitting a public lane', () => {
      const principal = resolveConnectorPrincipal({
        connector: 'discord',
        namespace: 'guild-a',
        userId: '1002',
        ownerUserId: '1001',
        isDirectMessage: false,
      });

      expect(principal).toEqual({
        class: 'external',
        lane: 'divert',
        canonicalId: 'discord:guild-a:1002',
        consoleEligible: false,
      });
    });
  });

  describe('overlayMemberPrincipal()', () => {
    it('TG-04 replaces an external Telegram principal with a frozen active member without changing its public lane', () => {
      const external = resolveTelegramPrincipal({
        userId: '1002',
        chatId: '-2001',
        chatType: 'group',
        allowedChats: new Set(['-2001']),
        ownerUserIds: new Set(['1001']),
      });

      const member = overlayMemberPrincipal(external, {
        principalId: 'principal-1002',
        kind: 'member',
        status: 'active',
      });

      expect(member).not.toBe(external);
      expect(member).toEqual({
        ...external,
        class: 'member',
        principalId: 'principal-1002',
      });
      expect(member.lane).toBe(external.lane);
      expect(member.lane).toBe('public');
      expect(Object.isFrozen(member)).toBe(true);
    });

    it.each(['slack', 'discord'] as const)(
      'keeps the exact Phase-1 divert lane for an active %s member',
      (connector) => {
        const external = resolveConnectorPrincipal({
          connector,
          namespace: `${connector}-namespace`,
          userId: 'member-user',
          ownerUserId: 'owner-user',
          isDirectMessage: false,
        });

        const member = overlayMemberPrincipal(external, {
          principalId: `${connector}-member-principal`,
          kind: 'member',
          status: 'active',
        });

        expect(member.class).toBe('member');
        expect(member.principalId).toBe(`${connector}-member-principal`);
        expect(member.lane).toBe(external.lane);
        expect(member.lane).toBe('divert');
        expect(Object.isFrozen(member)).toBe(true);
      }
    );

    it('returns an owner unchanged regardless of the registry row', () => {
      const owner = resolveConnectorPrincipal({
        connector: 'slack',
        namespace: 'team-a',
        userId: 'owner-user',
        ownerUserId: 'owner-user',
        isDirectMessage: true,
      });

      expect(
        overlayMemberPrincipal(owner, {
          principalId: 'registry-principal',
          kind: 'member',
          status: 'active',
        })
      ).toBe(owner);
    });

    it.each(['suspended', 'offboarded'])(
      'returns an external principal unchanged for a %s member row',
      (status) => {
        const external = resolveConnectorPrincipal({
          connector: 'discord',
          namespace: 'guild-a',
          userId: 'member-user',
          ownerUserId: 'owner-user',
          isDirectMessage: false,
        });

        expect(
          overlayMemberPrincipal(external, {
            principalId: 'member-principal',
            kind: 'member',
            status,
          })
        ).toBe(external);
      }
    );

    it('returns an external principal unchanged for a null or owner registry row', () => {
      const external = resolveConnectorPrincipal({
        connector: 'discord',
        namespace: 'guild-a',
        userId: 'external-user',
        ownerUserId: 'owner-user',
        isDirectMessage: false,
      });

      expect(overlayMemberPrincipal(external, null)).toBe(external);
      expect(
        overlayMemberPrincipal(external, {
          principalId: 'registry-owner',
          kind: 'owner',
          status: 'active',
        })
      ).toBe(external);
    });
  });

  describe('makeHostPrincipal()', () => {
    it('creates a frozen owner-lane principal for a private host surface', () => {
      const principal = makeHostPrincipal('viewer');

      expect(principal).toEqual({
        class: 'owner',
        lane: 'owner',
        canonicalId: 'viewer:host:host',
        consoleEligible: true,
      });
      expect(Object.isFrozen(principal)).toBe(true);
    });
  });

  describe('laneChannelId()', () => {
    it('maps public channels to an isolated key and preserves other lanes', () => {
      expect(laneChannelId('chat-a', 'public')).toBe('chat-a#public');
      expect(laneChannelId('chat-a', 'owner')).toBe('chat-a');
      expect(laneChannelId('chat-a', 'divert')).toBe('chat-a');
    });
  });
});
