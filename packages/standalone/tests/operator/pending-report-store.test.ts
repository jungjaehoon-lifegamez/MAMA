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
        provenance: { status: 'available', modelRunId: 'mr_current_1' },
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

  it('TG-06 round-trips full report provenance across restart replay', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mama-report-buffer-'));
    const path = join(root, 'pending.json');
    const snapshot = new SituationReporter().snapshot();
    const provenance = { status: 'available', modelRunId: 'mr_1' } as const;
    const store = new FilePendingReportStore(path);

    store.save({
      version: 1,
      digest: snapshot,
      full: snapshot,
      delivery: {
        mode: 'full',
        text: 'owner report',
        citedTriggerIds: [],
        createdAtIso: '2026-08-02T00:00:00.000Z',
        deliveryId: 'd1',
        provenance,
        occurrence: {
          kind: 'scheduled_full',
          hourKey: '2026-08-02:09',
          firedAtIso: '2026-08-02T00:00:00.000Z',
        },
      },
    });

    expect(store.load()?.delivery?.provenance).toEqual(provenance);
  });

  it('TG-06 labels a legacy pending full delivery without provenance', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mama-report-buffer-'));
    const path = join(root, 'pending.json');
    const snapshot = new SituationReporter().snapshot();
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        digest: snapshot,
        full: snapshot,
        delivery: {
          mode: 'full',
          text: 'legacy owner report',
          citedTriggerIds: [],
          createdAtIso: '2026-08-02T00:00:00.000Z',
          deliveryId: 'legacy-d1',
          occurrence: { kind: 'scheduled_full', hourKey: '2026-08-02:09' },
        },
      })
    );

    expect(new FilePendingReportStore(path).load()?.delivery?.provenance).toEqual({
      status: 'unavailable',
      reason: 'legacy_record',
    });
  });

  it('TG-06 quarantines malformed pending full-report provenance', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mama-report-buffer-'));
    const path = join(root, 'pending.json');
    const snapshot = new SituationReporter().snapshot();
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        digest: snapshot,
        full: snapshot,
        delivery: {
          mode: 'full',
          text: 'malformed owner report',
          citedTriggerIds: [],
          createdAtIso: '2026-08-02T00:00:00.000Z',
          deliveryId: 'd1',
          provenance: { status: 'available', modelRunId: '' },
          occurrence: { kind: 'scheduled_full', hourKey: '2026-08-02:09' },
        },
      })
    );

    expect(new FilePendingReportStore(path).load()).toBeNull();
    expect(await readdir(root)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^pending\.json\.corrupt-/),
        'pending.json.quarantined',
      ])
    );
  });

  it('TG-06 preserves a durable quarantine until an explicit valid save clears it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mama-report-buffer-'));
    const path = join(root, 'pending.json');
    const snapshot = new SituationReporter().snapshot();
    await writeFile(
      path,
      JSON.stringify({ version: 1, digest: snapshot, full: { invalid: true } })
    );
    const store = new FilePendingReportStore(path);

    expect(store.load()).toBeNull();
    expect(store.loadStatus()).toBe('quarantined');
    expect(new FilePendingReportStore(path).loadStatus()).toBe('quarantined');
    expect(await readdir(root)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^pending\.json\.corrupt-/),
        'pending.json.quarantined',
      ])
    );

    store.save({ version: 1, digest: snapshot, full: snapshot });

    expect(new FilePendingReportStore(path).loadStatus()).toBe('ready');
    expect(new FilePendingReportStore(path).load()?.digest).toEqual(snapshot);
    expect(await readdir(root)).not.toContain('pending.json.quarantined');
  });

  it.each([
    ['an empty current full delivery id', 'full', '', { kind: 'scheduled_full', hourKey: 'h1' }],
    ['a blank current full delivery id', 'full', '   ', { kind: 'scheduled_full', hourKey: 'h1' }],
    ['a digest occurrence on a current full delivery', 'full', 'full-1', { kind: 'digest' }],
    [
      'a scheduled occurrence on a digest delivery',
      'digest',
      'digest-1',
      {
        kind: 'scheduled_full',
        hourKey: 'h1',
      },
    ],
    [
      'an on-demand occurrence on a digest delivery',
      'digest',
      'digest-1',
      {
        kind: 'on_demand_full',
        firedAtIso: '2026-08-02T00:00:00.000Z',
      },
    ],
  ])(
    'TG-06 quarantines %s instead of recovering it',
    async (_caseName, mode, deliveryId, occurrence) => {
      const root = await mkdtemp(join(tmpdir(), 'mama-report-buffer-'));
      const path = join(root, 'pending.json');
      const snapshot = new SituationReporter().snapshot();
      await writeFile(
        path,
        JSON.stringify({
          version: 1,
          digest: snapshot,
          full: snapshot,
          delivery: {
            mode,
            text: 'owner report',
            citedTriggerIds: [],
            createdAtIso: '2026-08-02T00:00:00.000Z',
            deliveryId,
            ...(mode === 'full'
              ? { provenance: { status: 'available', modelRunId: 'mr_current_1' } }
              : {}),
            occurrence,
          },
        })
      );

      expect(new FilePendingReportStore(path).load()).toBeNull();
      expect(await readdir(root)).toEqual(
        expect.arrayContaining([
          expect.stringMatching(/^pending\.json\.corrupt-/),
          'pending.json.quarantined',
        ])
      );
    }
  );

  it('TG-06 refuses to save a new full delivery without provenance', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mama-report-buffer-'));
    const path = join(root, 'pending.json');
    const snapshot = new SituationReporter().snapshot();
    const invalidState = {
      version: 1,
      digest: snapshot,
      full: snapshot,
      delivery: {
        mode: 'full',
        text: 'owner report',
        citedTriggerIds: [],
        createdAtIso: '2026-08-02T00:00:00.000Z',
        deliveryId: 'full-1',
        occurrence: { kind: 'scheduled_full', hourKey: 'h1' },
      },
    } as unknown as Parameters<FilePendingReportStore['save']>[0];

    expect(() => new FilePendingReportStore(path).save(invalidState)).toThrow(
      'Refusing to persist invalid pending operator report state'
    );
  });

  it('TG-06 refuses to save a state with both a pending delivery and request', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mama-report-buffer-'));
    const path = join(root, 'pending.json');
    const snapshot = new SituationReporter().snapshot();

    expect(() =>
      new FilePendingReportStore(path).save({
        version: 1,
        digest: snapshot,
        full: snapshot,
        delivery: {
          mode: 'digest',
          text: 'digest report',
          citedTriggerIds: [],
          createdAtIso: '2026-08-02T00:00:00.000Z',
          deliveryId: 'digest-1',
          occurrence: { kind: 'digest' },
        },
        request: {
          mode: 'full',
          deliveryId: 'request-1',
          acceptedAtIso: '2026-08-02T00:00:00.000Z',
          occurrence: {
            kind: 'on_demand_full',
            firedAtIso: '2026-08-02T00:00:00.000Z',
          },
        },
      })
    ).toThrow('Refusing to persist invalid pending operator report state');
  });

  it('TG-06 quarantines a persisted state with both pending phases', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mama-report-buffer-'));
    const path = join(root, 'pending.json');
    const snapshot = new SituationReporter().snapshot();
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        digest: snapshot,
        full: snapshot,
        delivery: {
          mode: 'digest',
          text: 'digest report',
          citedTriggerIds: [],
          createdAtIso: '2026-08-02T00:00:00.000Z',
          deliveryId: 'digest-1',
          occurrence: { kind: 'digest' },
        },
        request: {
          mode: 'full',
          deliveryId: 'request-1',
          acceptedAtIso: '2026-08-02T00:00:00.000Z',
          occurrence: {
            kind: 'on_demand_full',
            firedAtIso: '2026-08-02T00:00:00.000Z',
          },
        },
      })
    );

    expect(new FilePendingReportStore(path).load()).toBeNull();
    expect(await readdir(root)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^pending\.json\.corrupt-/),
        'pending.json.quarantined',
      ])
    );
  });

  it.each(['', '   ', ' mr_1', 'mr_1 '])(
    'TG-06 quarantines a supplied non-canonical available model run id %j',
    async (modelRunId) => {
      const root = await mkdtemp(join(tmpdir(), 'mama-report-buffer-'));
      const path = join(root, 'pending.json');
      const snapshot = new SituationReporter().snapshot();
      await writeFile(
        path,
        JSON.stringify({
          version: 1,
          digest: snapshot,
          full: snapshot,
          delivery: {
            mode: 'full',
            text: 'owner report',
            citedTriggerIds: [],
            createdAtIso: '2026-08-02T00:00:00.000Z',
            deliveryId: 'full-1',
            provenance: { status: 'available', modelRunId },
            occurrence: { kind: 'scheduled_full', hourKey: 'h1' },
          },
        })
      );

      expect(new FilePendingReportStore(path).load()).toBeNull();
      expect(await readdir(root)).toEqual(
        expect.arrayContaining([
          expect.stringMatching(/^pending\.json\.corrupt-/),
          'pending.json.quarantined',
        ])
      );
    }
  );

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
    expect(await readdir(root)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^pending\.json\.corrupt-/),
        'pending.json.quarantined',
      ])
    );
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
