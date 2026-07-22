import { mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { FilePendingReportStore } from '../../src/operator/pending-report-store.js';
import { SituationReporter } from '../../src/operator/situation-report.js';

describe('FilePendingReportStore', () => {
  it('persists both report windows atomically for restart recovery', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mama-report-buffer-'));
    const path = join(root, 'pending.json');
    const digest = new SituationReporter();
    digest.recordAuthored(1);
    const full = new SituationReporter();
    full.recordAuthored(2);

    new FilePendingReportStore(path).save({
      version: 1,
      digest: digest.snapshot(),
      full: full.snapshot(),
    });

    const loaded = new FilePendingReportStore(path).load();
    expect(loaded?.digest.authored).toBe(1);
    expect(loaded?.full.authored).toBe(2);
  });

  it('round-trips the exact pending delivery operation used for restart replay', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mama-report-buffer-'));
    const path = join(root, 'pending.json');
    const reporter = new SituationReporter();
    const snapshot = reporter.snapshot();

    new FilePendingReportStore(path).save({
      version: 1,
      digest: snapshot,
      full: snapshot,
      delivery: {
        mode: 'full',
        text: 'owner-visible report',
        citedTriggerIds: ['temporal-1'],
        createdAtIso: '2026-07-22T03:00:00.000Z',
        deliveryId: 'operator-report:scheduled:2026-07-22:12',
        occurrence: {
          kind: 'scheduled_full',
          hourKey: '2026-07-22:12',
          firedAtIso: '2026-07-22T03:00:00.000Z',
        },
      },
    });

    expect(new FilePendingReportStore(path).load()?.delivery).toMatchObject({
      text: 'owner-visible report',
      deliveryId: 'operator-report:scheduled:2026-07-22:12',
      occurrence: { kind: 'scheduled_full', hourKey: '2026-07-22:12' },
    });
  });

  it('round-trips an accepted on-demand request before report composition starts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mama-report-buffer-'));
    const path = join(root, 'pending.json');
    const snapshot = new SituationReporter().snapshot();
    const store = new FilePendingReportStore(path);
    store.save({
      version: 1,
      digest: snapshot,
      full: snapshot,
      request: {
        mode: 'full',
        deliveryId: 'operator-report:on_demand_full:request-1',
        occurrence: {
          kind: 'on_demand_full',
          hourKey: '2026-07-22:13',
          firedAtIso: '2026-07-22T04:00:00.000Z',
        },
        acceptedAtIso: '2026-07-22T04:00:00.000Z',
      },
    });

    expect(store.load()?.request).toMatchObject({
      deliveryId: 'operator-report:on_demand_full:request-1',
      occurrence: { kind: 'on_demand_full' },
    });
  });

  it('quarantines malformed nested report state instead of disabling the trigger loop', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mama-report-buffer-'));
    const path = join(root, 'pending.json');
    const log = vi.fn();
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        digest: {
          version: 1,
          channels: [{ channelId: { injected: true }, count: -1, excerpts: ['secret'] }],
          windowTotal: 1,
          fires: [],
          authored: 0,
          recalled: [],
        },
        full: {
          version: 1,
          channels: [],
          windowTotal: 0,
          fires: [],
          authored: 0,
          recalled: [],
        },
      })
    );

    expect(new FilePendingReportStore(path, log).load()).toBeNull();
    expect(await readdir(root)).toEqual([expect.stringMatching(/^pending\.json\.corrupt-/)]);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('quarantined'));
  });

  it('round-trips a reporter after more channels and fires than the persisted detail bounds', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mama-report-buffer-'));
    const path = join(root, 'pending.json');
    const reporter = new SituationReporter();
    for (let index = 0; index < 120; index += 1) {
      reporter.recordWindow([
        {
          id: index,
          channel: 'telegram',
          channelId: `channel-${index}`,
          userId: 'owner',
          role: 'user',
          content: `event-${index}`,
          createdAt: index,
        },
      ]);
      reporter.recordFire({
        triggerId: `trigger-${index}`,
        kind: 'temporal',
        channelId: `channel-${index}`,
        recalled: [],
      });
    }
    const snapshot = reporter.snapshot();
    const store = new FilePendingReportStore(path);

    store.save({ version: 1, digest: snapshot, full: snapshot });

    const loaded = store.load();
    expect(loaded?.digest.windowTotal).toBe(120);
    expect(loaded?.digest.channels).toHaveLength(48);
    expect(loaded?.digest.fires).toHaveLength(100);
  });
});
