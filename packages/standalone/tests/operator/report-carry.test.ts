/**
 * TG-06: a delivered owner report is injected into exactly one intended
 * Telegram owner turn, and durable carry never revives after acknowledgement.
 */

import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  FileReportCarryStore,
  buildCarryTemporaryPath,
  type PersistDeliveredInput,
  type ReportCarryTarget,
} from '../../src/operator/report-carry.js';

const TARGET: ReportCarryTarget = { source: 'telegram', channelId: 'C1' };
const OTHER_TARGET: ReportCarryTarget = { source: 'telegram', channelId: 'C2' };
const DELIVERED_AT = '2026-08-02T00:00:00.000Z';
const RUN = { status: 'available' as const, modelRunId: 'mr_1' };

function tempCarryPath(): string {
  return join(mkdtempSync(join(tmpdir(), 'mama-carry-')), 'last-full-report.json');
}

function input(overrides: Partial<PersistDeliveredInput> = {}): PersistDeliveredInput {
  return {
    deliveryId: 'd1',
    target: TARGET,
    deliveredAt: DELIVERED_AT,
    text: 'owner report',
    provenance: RUN,
    ...overrides,
  };
}

describe('TG-06: versioned one-shot report carry', () => {
  it('peeks once for the exact unexpired Telegram chat and then acknowledges it', () => {
    const store = new FileReportCarryStore(tempCarryPath());
    const deliveredAt = new Date().toISOString();
    store.persistDelivered(input({ deliveredAt }));

    expect(store.peek(OTHER_TARGET, Date.parse(deliveredAt))).toBeNull();
    expect(
      store.peek(
        { source: 'discord', channelId: 'C1' } as unknown as ReportCarryTarget,
        Date.parse(deliveredAt)
      )
    ).toBeNull();
    expect(store.peek(TARGET, Date.parse(deliveredAt))?.deliveryId).toBe('d1');
    expect(
      store.acknowledge({
        deliveryId: 'd1',
        target: TARGET,
        consumingChannelKey: 'telegram:C1',
        consumedAtIso: '2026-08-02T00:01:00.000Z',
      })
    ).toBe(true);
    expect(store.peek(TARGET, Date.parse(deliveredAt))).toBeNull();
  });

  it('allows exactly the inclusive 24-hour boundary and refuses later carry', () => {
    const store = new FileReportCarryStore(tempCarryPath());
    store.persistDelivered(input());

    expect(store.peek(TARGET, Date.parse(DELIVERED_AT) + 24 * 60 * 60 * 1000)).not.toBeNull();
    expect(store.peek(TARGET, Date.parse(DELIVERED_AT) + 24 * 60 * 60 * 1000 + 1)).toBeNull();
  });

  it('never acknowledges an old delivery after a newer delivery replaces it', () => {
    const path = tempCarryPath();
    const store = new FileReportCarryStore(path);
    const deliveredAt = new Date().toISOString();
    store.persistDelivered(input({ deliveredAt }));
    store.persistDelivered(input({ deliveryId: 'd2', text: 'newer owner report' }));

    expect(
      store.acknowledge({
        deliveryId: 'd1',
        target: TARGET,
        consumingChannelKey: 'telegram:C1',
        consumedAtIso: '2026-08-02T00:01:00.000Z',
      })
    ).toBe(false);
    expect(store.peek(TARGET, Date.parse(DELIVERED_AT))?.deliveryId).toBe('d2');
  });

  it('does not revive a consumed carry when the same delivery is replayed', () => {
    const path = tempCarryPath();
    const store = new FileReportCarryStore(path);
    const deliveredAt = new Date().toISOString();
    store.persistDelivered(input({ deliveredAt }));
    store.acknowledge({
      deliveryId: 'd1',
      target: TARGET,
      consumingChannelKey: 'telegram:C1',
      consumedAtIso: '2026-08-02T00:01:00.000Z',
    });
    store.persistDelivered(input({ deliveredAt: '2026-08-02T00:05:00.000Z' }));

    expect(store.peek(TARGET, Date.parse(deliveredAt))).toBeNull();
    expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({
      deliveredAt,
      consumedAt: '2026-08-02T00:01:00.000Z',
      consumingChannelKey: 'telegram:C1',
    });
  });

  it.each([
    ['text', input({ text: 'changed report' })],
    ['target', input({ target: OTHER_TARGET })],
    ['provenance', input({ provenance: { status: 'unavailable', reason: 'commit_failed' } })],
  ])('rejects a same-ID %s mismatch without changing persisted bytes', (_field, changed) => {
    const path = tempCarryPath();
    const store = new FileReportCarryStore(path);
    store.persistDelivered(input());
    const before = readFileSync(path);

    expect(() => store.persistDelivered(changed)).toThrow(/same delivery ID/i);
    expect(readFileSync(path)).toEqual(before);
  });

  it('fails closed with a warning for corrupt and legacy unscoped records', () => {
    const path = tempCarryPath();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      writeFileSync(path, '{not json');
      expect(new FileReportCarryStore(path).peek(TARGET, Date.parse(DELIVERED_AT))).toBeNull();
      writeFileSync(path, JSON.stringify({ deliveredAt: DELIVERED_AT, text: 'legacy' }));
      expect(new FileReportCarryStore(path).peek(TARGET, Date.parse(DELIVERED_AT))).toBeNull();
      expect(warn).toHaveBeenCalledTimes(2);
    } finally {
      warn.mockRestore();
    }
  });

  it('validates the closed provenance reasons before storing or injecting carry', () => {
    const path = tempCarryPath();
    const store = new FileReportCarryStore(path);
    const malformed = {
      ...input(),
      provenance: { status: 'unavailable' as const, reason: 'invented_reason' },
    } as unknown as PersistDeliveredInput;

    expect(() => store.persistDelivered(malformed)).toThrow(/provenance/i);
    expect(store.peek(TARGET, Date.parse(DELIVERED_AT))).toBeNull();
  });

  it('caps and wraps report content as untrusted in the injected prefix', () => {
    const store = new FileReportCarryStore(tempCarryPath());
    store.persistDelivered(input({ text: 'x'.repeat(5_000) }));

    const prefix = store.peek(TARGET, Date.parse(DELIVERED_AT))?.prefix ?? '';
    expect(prefix.length).toBeLessThan(1_600);
    expect(prefix).toContain('<<<UNTRUSTED-CONTENT source=operator-report-carry>>>');
    expect(prefix).toContain('truncated');
  });

  it('cannot accept consumed fields from a delivery caller', () => {
    const store = new FileReportCarryStore(tempCarryPath());
    const untrustedInput = {
      ...input(),
      consumedAt: '2026-08-02T00:00:01.000Z',
      consumingChannelKey: 'telegram:C1',
    } as PersistDeliveredInput & { consumedAt: string; consumingChannelKey: string };
    store.persistDelivered(untrustedInput);

    expect(store.peek(TARGET, Date.parse(DELIVERED_AT))).not.toBeNull();
  });

  it('uses a distinct UUID temporary path and leaves the final carry file 0600', () => {
    const path = tempCarryPath();
    const first = buildCarryTemporaryPath(path);
    const second = buildCarryTemporaryPath(path);

    expect(first).not.toBe(second);
    expect(first).toMatch(/\.last-full-report\.\d+\.[0-9a-f-]{36}\.tmp$/);
    new FileReportCarryStore(path).persistDelivered(input());
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });
});
