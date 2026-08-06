/**
 * TG-05 Slice K: V2 carry migration has exact mappings and one owner
 * (design Decision 8). The inbox store constructor solely migrates
 * last-full-report.json; no component reads or writes V2 afterward.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database, { type SQLiteDatabase } from '../../src/sqlite.js';
import { TelegramReportContextStore } from '../../src/gateways/telegram-report-context-store.js';
import { FileReportCarryStore, type ReportCarryV2 } from '../../src/operator/report-carry.js';

const OWNER_CHAT = '777001';

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function v2Record(overrides: Partial<ReportCarryV2> = {}): ReportCarryV2 {
  return {
    version: 2,
    deliveryId: 'operator-report:on_demand_full:legacy-1',
    target: { source: 'telegram', channelId: OWNER_CHAT },
    deliveredAt: '2026-08-03T11:54:37.222Z',
    text: 'legacy full report text',
    provenance: { status: 'available', modelRunId: 'run_legacy' },
    ...overrides,
  };
}

describe('TelegramReportContextStore V2 migration', () => {
  let db: SQLiteDatabase;
  let dir: string;
  let carryPath: string;

  beforeEach(() => {
    db = new Database(':memory:');
    dir = mkdtempSync(join(tmpdir(), 'mama-v2-migration-'));
    carryPath = join(dir, 'last-full-report.json');
  });

  afterEach(() => {
    db.close();
  });

  function migrate(): TelegramReportContextStore {
    return new TelegramReportContextStore(db, { legacyCarryPath: carryPath });
  }

  it('maps an unconsumed record to a delivered-pending event even past the old TTL', () => {
    writeFileSync(carryPath, JSON.stringify(v2Record()));

    const store = migrate();

    const row = db
      .prepare(
        'SELECT state, disposition, mode, text, delivered_at, payload_identity FROM telegram_report_context_events WHERE delivery_id = ?'
      )
      .get('operator-report:on_demand_full:legacy-1') as Record<string, unknown>;
    expect(row).toMatchObject({
      state: 'delivered',
      disposition: 'pending',
      mode: 'full',
      text: 'legacy full report text',
      delivered_at: '2026-08-03T11:54:37.222Z',
    });
    const expectedIdentity = sha256(
      JSON.stringify([
        'legacy-report-carry-v2',
        'operator-report:on_demand_full:legacy-1',
        'telegram',
        OWNER_CHAT,
        '2026-08-03T11:54:37.222Z',
        'legacy full report text',
        ['available', 'run_legacy'],
      ])
    );
    expect(row.payload_identity).toBe(expectedIdentity);
    expect(existsSync(`${carryPath}.migrated`)).toBe(true);
    expect(existsSync(carryPath)).toBe(false);
    expect(store.listDeliveredPending({ source: 'telegram', channelId: OWNER_CHAT })).toHaveLength(
      1
    );
  });

  it('maps a consumed record to a legacy restoration with the exact old prefix bytes', () => {
    const record = v2Record({
      text: `${'x'.repeat(699)}\u{1F600}tail beyond the cut`,
      consumedAt: '2026-08-03T12:11:32.262Z',
      consumingChannelKey: `telegram:${OWNER_CHAT}`,
    });
    writeFileSync(carryPath, JSON.stringify(record));

    // Differential oracle BEFORE migration renames the file: the public
    // peek() surface renders the legacy prefix via the real (unexported)
    // builder, pinning the migration's replica byte-for-byte.
    const unconsumed = { ...record };
    delete (unconsumed as Record<string, unknown>).consumedAt;
    delete (unconsumed as Record<string, unknown>).consumingChannelKey;
    const oraclePath = join(dir, 'oracle.json');
    writeFileSync(oraclePath, JSON.stringify(unconsumed));
    const expectedText = new FileReportCarryStore(oraclePath).peek(
      record.target,
      Date.parse(record.deliveredAt) + 1_000
    )?.prefix;
    expect(expectedText).toBeDefined();

    migrate();

    const events = db.prepare('SELECT COUNT(*) AS n FROM telegram_report_context_events').get() as {
      n: number;
    };
    expect(events.n).toBe(0);
    const legacy = db
      .prepare(
        'SELECT restoration_text, legacy_projection_hash, consumed_at, channel_key FROM telegram_report_legacy_restorations WHERE delivery_id = ?'
      )
      .get(record.deliveryId) as Record<string, string>;
    // The legacy UTF-16 slice(0, 700) splits the surrogate pair - preserved
    // exactly through JSON encoding (a lone surrogate cannot survive SQLite's
    // UTF-8 TEXT round-trip unescaped).
    expect(expectedText).toContain('\ud83d');
    expect(JSON.parse(legacy.restoration_text)).toBe(expectedText);
    expect(legacy.legacy_projection_hash).toBe(sha256(expectedText as string));
    expect(legacy.consumed_at).toBe('2026-08-03T12:11:32.262Z');
  });

  it('replays idempotently after a crash between commit and rename', () => {
    const record = v2Record();
    writeFileSync(carryPath, JSON.stringify(record));
    migrate();
    // Simulate the crash window: the source file reappears (rename lost).
    writeFileSync(carryPath, JSON.stringify(record));

    migrate();

    const count = db.prepare('SELECT COUNT(*) AS n FROM telegram_report_context_events').get() as {
      n: number;
    };
    expect(count.n).toBe(1);
    expect(existsSync(carryPath)).toBe(false);
  });

  it('quarantines an invalid legacy file and never injects it', () => {
    writeFileSync(carryPath, '{not json');

    migrate();

    const count = db.prepare('SELECT COUNT(*) AS n FROM telegram_report_context_events').get() as {
      n: number;
    };
    expect(count.n).toBe(0);
    expect(existsSync(carryPath)).toBe(false);
    const quarantined = readdirSync(dir).filter((name) => name.includes('quarantine'));
    expect(quarantined).toHaveLength(1);
  });

  it('does nothing when no legacy file exists', () => {
    migrate();

    const count = db.prepare('SELECT COUNT(*) AS n FROM telegram_report_context_events').get() as {
      n: number;
    };
    expect(count.n).toBe(0);
  });

  it('accepts a richer pending artifact replaying the migrated delivery ID and records an alias', () => {
    writeFileSync(carryPath, JSON.stringify(v2Record()));
    const store = migrate();

    const richer = store.reserve({
      deliveryId: 'operator-report:on_demand_full:legacy-1',
      target: { source: 'telegram', channelId: OWNER_CHAT },
      mode: 'full',
      occurrence: { kind: 'on_demand_full' },
      provenance: { status: 'available', modelRunId: 'run_legacy' },
      text: 'legacy full report text',
      payloadIdentity: 'r'.repeat(64),
    });

    expect(richer.state).toBe('delivered');
    const row = db
      .prepare(
        'SELECT payload_identity_alias FROM telegram_report_context_events WHERE delivery_id = ?'
      )
      .get('operator-report:on_demand_full:legacy-1') as { payload_identity_alias: string };
    expect(row.payload_identity_alias).toBe('r'.repeat(64));
  });

  it('quarantines a semantic mismatch on the migrated delivery ID as an identity conflict', () => {
    writeFileSync(carryPath, JSON.stringify(v2Record()));
    const store = migrate();

    expect(() =>
      store.reserve({
        deliveryId: 'operator-report:on_demand_full:legacy-1',
        target: { source: 'telegram', channelId: OWNER_CHAT },
        mode: 'full',
        occurrence: { kind: 'on_demand_full' },
        text: 'DIFFERENT text',
        payloadIdentity: 's'.repeat(64),
      })
    ).toThrow(/identity conflict/i);
  });
});
