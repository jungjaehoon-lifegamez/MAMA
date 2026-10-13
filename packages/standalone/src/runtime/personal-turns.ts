import type { JudgmentAccess } from '@jungjaehoon/mama-core';
import type { NativeTurnResult } from '@jungjaehoon/mama-core/runtime/native-turn';
import {
  isDefinitiveTelegramRejection,
  TelegramJobDeliveryRejected,
} from '../gateways/telegram-errors.js';

/** Final product failures settle an autonomous input without a successful completion. */
export class PersonalTurnFinalFailure extends Error {}

export const isPersonalTurnTextKey = (key: string) =>
  key.startsWith('job:') || key.startsWith('notice:');

/** Native results, DM receipts and chat are independently durable for jobs and notices. */
export async function deliverPersonalTurnResult(
  result: NativeTurnResult,
  ports: {
    label: string;
    key: string;
    isClosed(): boolean;
    isActive(): boolean;
    isOffboarded(): boolean;
    assertCurrent(): void;
    completeIfCurrent(): Promise<void>;
    complete(access: JudgmentAccess): Promise<void>;
    hasExchange(): boolean;
    archive(text: string): void;
    access(): JudgmentAccess;
    delivered(key: string): boolean;
    send(access: JudgmentAccess, text: string, key: string): Promise<boolean>;
  }
) {
  if (ports.isClosed()) return;
  if (ports.hasExchange()) {
    await ports.completeIfCurrent();
    return;
  }
  if (ports.isOffboarded())
    throw new PersonalTurnFinalFailure(`${ports.label} person is no longer active`);
  const text = result.response.trim();
  // A confirmed send still owes its archive after suspension or a job revision.
  if (text !== '[ack]' && ports.delivered(ports.key)) {
    ports.archive(text);
    await ports.completeIfCurrent();
    return;
  }
  if (!ports.isActive())
    throw new PersonalTurnFinalFailure(`${ports.label} person is no longer active`);
  ports.assertCurrent();
  const access = ports.access();
  if (!text)
    throw new PersonalTurnFinalFailure(
      `${ports.label} returned no result; use [ack] when there is nothing to tell`
    );
  if (text !== '[ack]') {
    try {
      if (!(await ports.send(access, text, ports.key)))
        throw new Error(`${ports.label} DM delivery was not confirmed`);
    } catch (error) {
      if (error instanceof TelegramJobDeliveryRejected || isDefinitiveTelegramRejection(error))
        throw new PersonalTurnFinalFailure(`${ports.label} DM delivery was rejected`, {
          cause: error,
        });
      throw error;
    }
    ports.archive(text);
  }
  await ports.complete(access);
}
