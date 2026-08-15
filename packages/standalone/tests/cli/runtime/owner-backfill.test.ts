import { describe, expect, it, vi } from 'vitest';

import { backfillTelegramOwner } from '../../../src/cli/runtime/owner-backfill.js';
import {
  overlayMemberPrincipal,
  resolveTelegramPrincipal,
} from '../../../src/gateways/principal.js';

type OwnerBackfillInput = {
  connector: string;
  namespace: string;
  externalId: string;
  now: number;
};

type RegistryRow = {
  principalId: string;
  kind: 'owner' | 'member';
  status: 'active';
};

class InMemoryPrincipalRegistry {
  readonly rows = new Map<string, RegistryRow>();

  ensureOwner(input: OwnerBackfillInput): 'created' | 'exists' | 'conflict' {
    const key = this.key(input.connector, input.namespace, input.externalId);
    const existing = this.rows.get(key);
    if (existing) {
      return existing.kind === 'owner' ? 'exists' : 'conflict';
    }
    if (Array.from(this.rows.values()).some((row) => row.kind === 'owner')) {
      return 'conflict';
    }

    this.rows.set(key, {
      principalId: `principal-${this.rows.size + 1}`,
      kind: 'owner',
      status: 'active',
    });
    return 'created';
  }

  resolveByExternal(connector: string, namespace: string, externalId: string): RegistryRow | null {
    return this.rows.get(this.key(connector, namespace, externalId)) ?? null;
  }

  private key(connector: string, namespace: string, externalId: string): string {
    return `${connector}:${namespace}:${externalId}`;
  }
}

function createLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
  };
}

describe('Telegram owner bookkeeping backfill', () => {
  describe('AC #1: unambiguous owner configuration', () => {
    it('creates one owner row and returns exists on the next boot', () => {
      const registry = new InMemoryPrincipalRegistry();
      const ensureOwner = vi.spyOn(registry, 'ensureOwner');
      const logger = createLogger();
      const telegram = {
        owner_user_ids: ['telegram-owner-1'],
        allowed_chats: ['telegram-owner-1'],
      };

      expect(backfillTelegramOwner({ telegram, registry, now: 100, logger })).toBe('created');
      expect(backfillTelegramOwner({ telegram, registry, now: 101, logger })).toBe('exists');

      expect(ensureOwner).toHaveBeenNthCalledWith(1, {
        connector: 'telegram',
        namespace: 'global',
        externalId: 'telegram-owner-1',
        now: 100,
      });
      expect(ensureOwner).toHaveBeenNthCalledWith(2, {
        connector: 'telegram',
        namespace: 'global',
        externalId: 'telegram-owner-1',
        now: 101,
      });
      expect(registry.rows.size).toBe(1);
      expect(logger.info).toHaveBeenNthCalledWith(1, expect.stringContaining('created'));
      expect(logger.info).toHaveBeenNthCalledWith(2, expect.stringContaining('exists'));
      expect(logger.warn).not.toHaveBeenCalled();
    });
  });

  describe('AC #2: missing or ambiguous owner configuration', () => {
    it.each([
      { label: 'an unset owner', telegram: {} },
      {
        label: 'multiple positive allowlist IDs',
        telegram: { allowed_chats: ['1001', '1002', '-2001'] },
      },
    ])('creates no row and warns for $label', ({ telegram }) => {
      const registry = new InMemoryPrincipalRegistry();
      const ensureOwner = vi.spyOn(registry, 'ensureOwner');
      const logger = createLogger();

      expect(backfillTelegramOwner({ telegram, registry, now: 200, logger })).toBe('skipped');

      expect(ensureOwner).not.toHaveBeenCalled();
      expect(registry.rows.size).toBe(0);
      expect(logger.warn).toHaveBeenCalledOnce();
      expect(logger.info).not.toHaveBeenCalled();
    });
  });

  describe('AC #3: TG-04 bookkeeping does not grant owner access', () => {
    it('keeps a backfilled owner row bookkeeping-only after owner_user_ids becomes empty', () => {
      const registry = new InMemoryPrincipalRegistry();
      const logger = createLogger();
      const ownerId = 'telegram-owner-bookkeeping';

      expect(
        backfillTelegramOwner({
          telegram: { owner_user_ids: [ownerId], allowed_chats: [ownerId] },
          registry,
          now: 300,
          logger,
        })
      ).toBe('created');

      const ingressPrincipal = resolveTelegramPrincipal({
        userId: ownerId,
        chatId: ownerId,
        chatType: 'private',
        allowedChats: new Set([ownerId]),
        ownerUserIds: new Set(),
      });
      const ownerRow = registry.resolveByExternal('telegram', 'global', ownerId);

      expect(ownerRow).toMatchObject({ kind: 'owner', status: 'active' });
      expect(overlayMemberPrincipal(ingressPrincipal, ownerRow)).toEqual({
        class: 'external',
        lane: 'divert',
        canonicalId: `telegram:global:${ownerId}`,
        consoleEligible: false,
      });
    });
  });

  describe('AC #4: owner conflicts fail closed', () => {
    it('throws loudly when ensureOwner reports a conflict', () => {
      const logger = createLogger();
      const registry = {
        ensureOwner: vi.fn(() => 'conflict' as const),
      };

      expect(() =>
        backfillTelegramOwner({
          telegram: { owner_user_ids: ['telegram-owner-conflict'] },
          registry,
          now: 400,
          logger,
        })
      ).toThrow(/conflict/i);
      expect(logger.info).not.toHaveBeenCalled();
      expect(logger.warn).not.toHaveBeenCalled();
    });
  });
});
