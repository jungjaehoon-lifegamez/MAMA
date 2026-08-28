/**
 * TG-05/TG-06: the single production boundary for all owner-report modes.
 *
 * Digest, scheduled full, and on-demand full owner reports flow through this
 * coordinator (docs/development/telegram-outbound-context-inbox-design.md,
 * Decisions 1-3). It reserves durable report context in the messenger SQLite
 * database BEFORE any Telegram API call, executes exactly one send per CAS
 * attempt lease, and returns typed outcomes. No caller may swallow coordinator
 * persistence failure and report success.
 */

import type {
  ReportContextTarget,
  TelegramReportContextStore,
} from '../gateways/telegram-report-context-store.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DebugLogger } from '@jungjaehoon/mama-core/debug-logger';
import {
  pendingReportDeliveryPayloadIdentity,
  type PendingReportDelivery,
} from './pending-report-store.js';

export type ReportDeliveryOutcome =
  | { status: 'delivered' }
  | { status: 'retry_scheduled'; nextAttemptAt: string }
  | { status: 'definite_rejection'; reason: string }
  | { status: 'cancelled'; reason: string }
  /**
   * Live capacity refused the reservation BEFORE any Telegram send (design
   * Decision 5). Typed, not thrown: a full inbox must degrade the report leg
   * loudly, never abort the caller's whole tick.
   */
  | { status: 'capacity_full'; reason: string };

export interface ReportDeliveryPort {
  deliverPrepared(report: PendingReportDelivery): Promise<ReportDeliveryOutcome>;
}

export interface ReportDeliveryBinding {
  deliveryId: string;
  target: ReportContextTarget;
  payloadIdentity: string;
  text: string;
}

export interface ReportDeliveryLease {
  deliveryId: string;
}

export type TypedTelegramDeliveryOutcome =
  | { kind: 'confirmed' }
  | { kind: 'retryable'; detail: string }
  | { kind: 'definite_rejection'; reason: string };

/**
 * Narrow Telegram-ledger control surface (intentionally smaller than the
 * ledger itself): pin a delivery entry against TTL/count pruning before the
 * send, send the pinned entry, and release or reconcile pins.
 */
export interface TelegramReportDeliveryControl {
  claimAndPin(binding: ReportDeliveryBinding): Promise<ReportDeliveryLease>;
  sendPinned(lease: ReportDeliveryLease): Promise<TypedTelegramDeliveryOutcome>;
  releasePin(deliveryId: string): Promise<void>;
  reconcilePins(nonterminalIds: string[], terminalIds: string[]): Promise<void>;
}

export interface ReportDeliveryCoordinatorOptions {
  store: TelegramReportContextStore;
  control: TelegramReportDeliveryControl;
  ownerTarget: ReportContextTarget;
  executorId: string;
  nowIso?: () => string;
  attemptLeaseMs?: number;
  mamaHome?: string;
}

/** Design Decision 3: 1m, 5m, 30m, 2h, then 12h capped. */
const RETRY_BACKOFF_MS = [60_000, 300_000, 1_800_000, 7_200_000, 43_200_000] as const;
const DEFAULT_ATTEMPT_LEASE_MS = 5 * 60_000;
const deliveryLogger = new DebugLogger('ReportDeliveryCoordinator');

function hasErrorCode(error: unknown, code: string): boolean {
  return error !== null && typeof error === 'object' && 'code' in error && error.code === code;
}

function addMs(iso: string, ms: number): string {
  return new Date(new Date(iso).getTime() + ms).toISOString();
}

export class ReportDeliveryCoordinator implements ReportDeliveryPort {
  private readonly nowIso: () => string;
  private readonly attemptLeaseMs: number;

  constructor(private readonly opts: ReportDeliveryCoordinatorOptions) {
    this.nowIso = opts.nowIso ?? (() => new Date().toISOString());
    this.attemptLeaseMs = opts.attemptLeaseMs ?? DEFAULT_ATTEMPT_LEASE_MS;
  }

  async deliverPrepared(report: PendingReportDelivery): Promise<ReportDeliveryOutcome> {
    this.verifyBinding(report);

    let reserved: ReturnType<TelegramReportContextStore['reserve']>;
    try {
      reserved = this.opts.store.reserve({
        deliveryId: report.deliveryId,
        target: report.target,
        mode: report.mode,
        occurrence: report.occurrence as unknown as Record<string, unknown>,
        ...(report.provenance
          ? { provenance: report.provenance as unknown as Record<string, unknown> }
          : {}),
        text: report.text,
        payloadIdentity: report.payloadIdentity,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.startsWith('capacity_full')) {
        return { status: 'capacity_full', reason: message };
      }
      throw error;
    }

    if (reserved.state === 'delivered') {
      // Crash between delivered-commit and unpin converges here: success
      // without another send, and an idempotent pin release.
      await this.opts.control.releasePin(report.deliveryId);
      this.recordFirstReport(report);
      return { status: 'delivered' };
    }
    if (reserved.state === 'cancelled') {
      return {
        status: 'cancelled',
        reason: this.opts.store.getEvent(report.deliveryId)?.cancelReason ?? 'cancelled',
      };
    }
    if (reserved.state === 'prepared_definite_rejection') {
      return {
        status: 'definite_rejection',
        reason:
          this.opts.store.getEvent(report.deliveryId)?.rejectionReason ?? 'definite rejection',
      };
    }

    const now = this.nowIso();
    const lease = this.opts.store.claimAttempt(
      report.deliveryId,
      this.opts.executorId,
      now,
      addMs(now, this.attemptLeaseMs)
    );
    if (!lease) {
      // Another executor (or a not-yet-due backoff) owns this delivery. The
      // trigger loop observes status and waits; it never races to a send.
      const event = this.opts.store.getEvent(report.deliveryId);
      const nextAttemptAt =
        event?.nextAttemptAt ?? event?.leaseUntil ?? addMs(now, this.attemptLeaseMs);
      return { status: 'retry_scheduled', nextAttemptAt };
    }

    const pinned = await this.opts.control.claimAndPin({
      deliveryId: report.deliveryId,
      target: report.target,
      payloadIdentity: report.payloadIdentity,
      text: report.text,
    });

    let outcome: TypedTelegramDeliveryOutcome;
    try {
      outcome = await this.opts.control.sendPinned(pinned);
    } catch (error) {
      outcome = {
        kind: 'retryable',
        detail: error instanceof Error ? error.message : String(error),
      };
    }

    if (outcome.kind === 'confirmed') {
      this.opts.store.markDelivered(report.deliveryId, this.nowIso());
      await this.opts.control.releasePin(report.deliveryId);
      this.recordFirstReport(report);
      return { status: 'delivered' };
    }

    if (outcome.kind === 'definite_rejection') {
      this.opts.store.markDefiniteRejection(
        report.deliveryId,
        this.opts.executorId,
        outcome.reason
      );
      return { status: 'definite_rejection', reason: outcome.reason };
    }

    const attemptCount = this.opts.store.getEvent(report.deliveryId)?.attemptCount ?? 1;
    const backoff = RETRY_BACKOFF_MS[Math.min(attemptCount - 1, RETRY_BACKOFF_MS.length - 1)];
    const nextAttemptAt = addMs(this.nowIso(), backoff);
    this.opts.store.scheduleRetry(report.deliveryId, this.opts.executorId, nextAttemptAt);
    return { status: 'retry_scheduled', nextAttemptAt };
  }

  private recordFirstReport(report: PendingReportDelivery): void {
    const stateDir = join(this.opts.mamaHome ?? join(homedir(), '.mama'), 'state');
    const markerPath = join(stateDir, 'first-report.json');
    try {
      mkdirSync(stateDir, { recursive: true });
      writeFileSync(
        markerPath,
        `${JSON.stringify({ at: this.nowIso(), channel: report.target.source }, null, 2)}\n`,
        { encoding: 'utf8', flag: 'wx', mode: 0o600 }
      );
    } catch (error) {
      if (!hasErrorCode(error, 'EEXIST')) {
        deliveryLogger.warn(
          `first-report marker write failed: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
  }

  private verifyBinding(report: PendingReportDelivery): void {
    if (
      report.target?.source !== this.opts.ownerTarget.source ||
      report.target.channelId !== this.opts.ownerTarget.channelId
    ) {
      throw new Error(
        `Owner report delivery ${report.deliveryId} does not match the configured owner-report target`
      );
    }
    const expected = pendingReportDeliveryPayloadIdentity(report);
    if (report.payloadIdentity !== expected) {
      throw new Error(`Owner report delivery ${report.deliveryId} payload identity mismatch`);
    }
  }
}
