import type { PersistDeliveredInput } from './report-carry.js';
import type { DeliveredFullReport } from './situation-report.js';
import { pendingReportDeliveryPayloadIdentity } from './pending-report-store.js';
import { randomUUID } from 'node:crypto';

/** Narrow persistence port so startup wiring stays independent of the concrete file implementation. */
export interface ReportCarryDeliveryStore {
  persistDelivered(input: PersistDeliveredInput): void;
}

export interface TelegramReportCarryDeliveryOptions {
  reportChatId: string;
  carryStore: ReportCarryDeliveryStore;
}

/** The Telegram boundary used by detached operator reports. */
export interface TelegramSystemMessageSender {
  sendSystemMessage(chatId: string, text: string, deliveryId?: string): Promise<void>;
}

export interface TelegramReportOutputOptions {
  reportChatId: string;
  telegramSender: TelegramSystemMessageSender;
}

function requireCanonicalTelegramReportChatId(reportChatId: string): void {
  if (reportChatId.length === 0 || reportChatId.trim() !== reportChatId) {
    throw new Error('Telegram report delivery requires a canonical report chat ID');
  }
}

/**
 * Binds the host-authorized Telegram destination to the operator output surface.
 * Prepared full reports retain their delivery identity; legacy digest sends receive a new one.
 */
export function createTelegramReportOutput({
  reportChatId,
  telegramSender,
}: TelegramReportOutputOptions): {
  target: { source: 'telegram'; channelId: string };
  send(text: string, deliveryId?: string): Promise<void>;
} {
  requireCanonicalTelegramReportChatId(reportChatId);
  return {
    target: { source: 'telegram', channelId: reportChatId },
    send: (text, deliveryId) =>
      telegramSender.sendSystemMessage(
        reportChatId,
        text,
        deliveryId ?? `operator-report:legacy:${randomUUID()}`
      ),
  };
}

/**
 * Binds an already-authorized Telegram report destination to the durable carry store.
 * The returned callback receives only the successful full-delivery artifact from the reporter.
 */
export function createTelegramReportCarryDelivery({
  reportChatId,
  carryStore,
}: TelegramReportCarryDeliveryOptions): (report: DeliveredFullReport) => void {
  requireCanonicalTelegramReportChatId(reportChatId);
  return (report) => {
    if (
      report.target?.source !== 'telegram' ||
      report.target.channelId !== reportChatId ||
      report.payloadIdentity !==
        pendingReportDeliveryPayloadIdentity({
          deliveryId: report.deliveryId,
          text: report.text,
          target: report.target,
        })
    ) {
      throw new Error('Full report carry delivery binding does not match its Telegram target');
    }
    carryStore.persistDelivered({
      deliveryId: report.deliveryId,
      target: report.target,
      deliveredAt: report.deliveredAtIso,
      text: report.text,
      provenance: report.provenance,
    });
  };
}
