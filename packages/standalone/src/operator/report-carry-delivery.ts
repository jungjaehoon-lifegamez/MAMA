import type { PersistDeliveredInput } from './report-carry.js';
import type { DeliveredFullReport } from './situation-report.js';

/** Narrow persistence port so startup wiring stays independent of the concrete file implementation. */
export interface ReportCarryDeliveryStore {
  persistDelivered(input: PersistDeliveredInput): void;
}

export interface TelegramReportCarryDeliveryOptions {
  reportChatId: string;
  carryStore: ReportCarryDeliveryStore;
}

/**
 * Binds an already-authorized Telegram report destination to the durable carry store.
 * The returned callback receives only the successful full-delivery artifact from the reporter.
 */
export function createTelegramReportCarryDelivery({
  reportChatId,
  carryStore,
}: TelegramReportCarryDeliveryOptions): (report: DeliveredFullReport) => void {
  if (reportChatId.length === 0 || reportChatId.trim() !== reportChatId) {
    throw new Error('Telegram report carry requires a canonical report chat ID');
  }
  return (report) => {
    carryStore.persistDelivered({
      deliveryId: report.deliveryId,
      target: { source: 'telegram', channelId: reportChatId },
      deliveredAt: report.deliveredAtIso,
      text: report.text,
      provenance: report.provenance,
    });
  };
}
