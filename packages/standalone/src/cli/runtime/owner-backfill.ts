import { deriveTelegramOwnerId } from '../../gateways/principal.js';

export interface OwnerBackfillRegistry {
  ensureOwner(input: {
    connector: string;
    namespace: string;
    externalId: string;
    now: number;
  }): 'created' | 'exists' | 'conflict';
}

interface OwnerBackfillLogger {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
}

interface TelegramOwnerConfig {
  readonly owner_user_ids?: readonly string[];
  readonly allowed_chats?: readonly string[];
}

export function backfillTelegramOwner(input: {
  telegram?: TelegramOwnerConfig;
  registry: OwnerBackfillRegistry;
  now: number;
  logger: OwnerBackfillLogger;
}): 'created' | 'exists' | 'skipped' {
  const ownerId = deriveTelegramOwnerId(input.telegram ?? {});
  if (ownerId === null) {
    input.logger.warn('Telegram owner bookkeeping backfill skipped: owner is unset or ambiguous');
    return 'skipped';
  }

  // TG-04: this row records identity bookkeeping only; ingress config remains the authority source.
  const result = input.registry.ensureOwner({
    connector: 'telegram',
    namespace: 'global',
    externalId: ownerId,
    now: input.now,
  });
  if (result === 'conflict') {
    throw new Error('Telegram owner bookkeeping backfill conflict');
  }

  input.logger.info(`Telegram owner bookkeeping backfill ${result}`);
  return result;
}
