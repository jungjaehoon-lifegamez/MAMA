import { spawn } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { describe, expect, it, vi } from 'vitest';

import {
  FilePendingReportStore,
  pendingReportDeliveryPayloadIdentity,
  pendingReportRequestPayloadIdentity,
  type PendingReportDelivery,
  type PendingReportOccurrence,
} from '../../src/operator/pending-report-store.js';
import { SituationReporter } from '../../src/operator/situation-report.js';

const TEST_REPORT_TARGET = { source: 'telegram', channelId: 'test-owner-chat' } as const;

function bindDelivery<T extends Omit<PendingReportDelivery, 'target' | 'payloadIdentity'>>(
  delivery: T
) {
  const bound = { ...delivery, target: TEST_REPORT_TARGET };
  return {
    ...bound,
    payloadIdentity: pendingReportDeliveryPayloadIdentity(bound),
  };
}

function bindRequest<
  T extends {
    mode: 'full';
    deliveryId: string;
    occurrence: PendingReportOccurrence;
    acceptedAtIso: string;
  },
>(request: T) {
  const bound = { ...request, target: TEST_REPORT_TARGET };
  return {
    ...bound,
    payloadIdentity: pendingReportRequestPayloadIdentity(bound),
  };
}

interface PendingStoreChild {
  ready: Promise<void>;
  exited: Promise<void>;
}

function startPendingStoreChild(
  operation: 'load' | 'save' | 'recover',
  path: string,
  state: unknown,
  options: { barrierEnteredPath?: string; barrierReleasePath?: string; attemptPath?: string } = {}
): PendingStoreChild {
  const moduleUrl = pathToFileURL(join(process.cwd(), 'src/operator/pending-report-store.ts')).href;
  const tsxCli = join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const script = `
    import { existsSync, writeFileSync } from 'node:fs';
    import { FilePendingReportStore } from ${JSON.stringify(moduleUrl)};
    const barrier = process.env.MAMA_PENDING_BARRIER_ENTERED
      ? {
          afterInvalidReadBeforeQuarantine: () => {
            writeFileSync(process.env.MAMA_PENDING_BARRIER_ENTERED, 'entered');
            const sleeper = new Int32Array(new SharedArrayBuffer(4));
            while (!existsSync(process.env.MAMA_PENDING_BARRIER_RELEASE)) {
              Atomics.wait(sleeper, 0, 0, 10);
            }
          },
        }
      : undefined;
    const store = new FilePendingReportStore(process.env.MAMA_PENDING_PATH, () => {}, barrier);
    const state = JSON.parse(process.env.MAMA_PENDING_STATE);
    const run = () => {
      if (process.env.MAMA_PENDING_OPERATION === 'load') store.load();
      if (process.env.MAMA_PENDING_OPERATION === 'save') store.save(state);
      if (process.env.MAMA_PENDING_OPERATION === 'recover') store.recoverWithValidState(state);
      process.stdout.write('done\\n');
    };
    process.stdout.write('ready\\n');
    if (process.env.MAMA_PENDING_ATTEMPT) writeFileSync(process.env.MAMA_PENDING_ATTEMPT, 'attempted');
    run();
  `;
  const child = spawn(process.execPath, [tsxCli, '--eval', script], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      MAMA_PENDING_OPERATION: operation,
      MAMA_PENDING_PATH: path,
      MAMA_PENDING_STATE: JSON.stringify(state),
      ...(options.barrierEnteredPath
        ? {
            MAMA_PENDING_BARRIER_ENTERED: options.barrierEnteredPath,
            MAMA_PENDING_BARRIER_RELEASE: options.barrierReleasePath,
          }
        : {}),
      ...(options.attemptPath ? { MAMA_PENDING_ATTEMPT: options.attemptPath } : {}),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const ready = new Promise<void>((resolve, reject) => {
    child.stdout?.on('data', (chunk: Buffer) => {
      if (chunk.toString().includes('ready')) {
        resolve();
      }
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`Pending-store child exited ${code}: ${stderr}`));
      }
    });
  });
  const exited = new Promise<void>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Pending-store child exited ${code}: ${stderr}`));
      }
    });
  });
  return { ready, exited };
}

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for test barrier ${path}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

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
      delivery: bindDelivery({
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
      }),
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
      delivery: bindDelivery({
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
      }),
    });

    expect(store.load()?.delivery?.provenance).toEqual(provenance);
  });

  it('TG-06 quarantines a legacy pending full delivery without provenance', async () => {
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
          target: TEST_REPORT_TARGET,
          payloadIdentity: '8f622df5cedccfd4c41d26bcfd62ad0ecaa342953876b85a27bafeb3b037703f',
        },
      })
    );

    expect(new FilePendingReportStore(path).loadStatus()).toBe('quarantined');
  });

  it('TG-06 quarantines a pending delivery whose exact payload no longer matches its identity', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mama-report-buffer-'));
    const path = join(root, 'pending.json');
    const snapshot = new SituationReporter().snapshot();
    const store = new FilePendingReportStore(path);
    store.save({
      version: 1,
      digest: snapshot,
      full: snapshot,
      delivery: bindDelivery({
        mode: 'full',
        text: 'authorized payload',
        citedTriggerIds: [],
        createdAtIso: '2026-08-02T00:00:00.000Z',
        deliveryId: 'payload-bound-d1',
        provenance: { status: 'available', modelRunId: 'mr_payload_1' },
        occurrence: { kind: 'scheduled_full', hourKey: '2026-08-02:09' },
      }),
    });
    const tampered = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
    (tampered.delivery as Record<string, unknown>).text = 'different payload';
    await writeFile(path, JSON.stringify(tampered));

    expect(new FilePendingReportStore(path).loadStatus()).toBe('quarantined');
    expect(await readdir(root)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^pending\.json\.corrupt-/),
        'pending.json.quarantined',
      ])
    );
  });

  it.each([
    [
      'mode',
      (delivery: Record<string, unknown>) => {
        delivery.mode = 'digest';
        delivery.occurrence = { kind: 'digest' };
        delete delivery.provenance;
      },
    ],
    [
      'citations',
      (delivery: Record<string, unknown>) => {
        delivery.citedTriggerIds = ['trigger-mutated'];
      },
    ],
    [
      'creation timestamp',
      (delivery: Record<string, unknown>) => {
        delivery.createdAtIso = '2026-08-02T00:01:00.000Z';
      },
    ],
    [
      'provenance',
      (delivery: Record<string, unknown>) => {
        delivery.provenance = { status: 'available', modelRunId: 'mr_mutated' };
      },
    ],
    [
      'scheduled occurrence',
      (delivery: Record<string, unknown>) => {
        delivery.occurrence = {
          kind: 'scheduled_full',
          hourKey: '2026-08-02:10',
          firedAtIso: '2026-08-02T01:00:00.000Z',
        };
      },
    ],
  ] as const)(
    'TG-06 quarantines a structurally valid delivery whose bound %s changed',
    async (_field, mutate) => {
      const root = await mkdtemp(join(tmpdir(), 'mama-report-buffer-'));
      const path = join(root, 'pending.json');
      const snapshot = new SituationReporter().snapshot();
      const state = {
        version: 1 as const,
        digest: snapshot,
        full: snapshot,
        delivery: bindDelivery({
          mode: 'full' as const,
          text: 'owner report',
          citedTriggerIds: ['trigger-1'],
          createdAtIso: '2026-08-02T00:00:00.000Z',
          deliveryId: 'fully-bound-d1',
          provenance: { status: 'available' as const, modelRunId: 'mr_original' },
          occurrence: {
            kind: 'scheduled_full' as const,
            hourKey: '2026-08-02:09',
            firedAtIso: '2026-08-02T00:00:00.000Z',
          },
        }),
      };
      const tampered = structuredClone(state);
      mutate(tampered.delivery as unknown as Record<string, unknown>);
      await writeFile(path, JSON.stringify(tampered));

      expect(new FilePendingReportStore(path).loadStatus()).toBe('quarantined');
      expect(await readdir(root)).toEqual(
        expect.arrayContaining([
          expect.stringMatching(/^pending\.json\.corrupt-/),
          'pending.json.quarantined',
        ])
      );
    }
  );

  it('TG-06 quarantines the legacy weaker delivery identity instead of accepting it', async () => {
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
          deliveryId: 'legacy-weak-d1',
          provenance: { status: 'available', modelRunId: 'mr_original' },
          occurrence: { kind: 'scheduled_full', hourKey: '2026-08-02:09' },
          target: TEST_REPORT_TARGET,
          payloadIdentity: '8b44012855f58b25ef968f78012982f3d4691e136d0644bfcd0ca6ed1401f57d',
        },
      })
    );

    expect(new FilePendingReportStore(path).loadStatus()).toBe('quarantined');
  });

  it.each([
    [
      'scheduled delivery',
      (snapshot: ReturnType<SituationReporter['snapshot']>) => {
        const occurrence = {
          kind: 'scheduled_full' as const,
          hourKey: '2026-08-02:09',
          unknown: 'substitutes-for-firedAtIso',
        };
        const delivery = {
          mode: 'full' as const,
          text: 'owner report',
          citedTriggerIds: [],
          createdAtIso: '2026-08-02T00:00:00.000Z',
          deliveryId: 'unknown-scheduled-key-d1',
          provenance: { status: 'available' as const, modelRunId: 'mr_original' },
          occurrence,
          target: TEST_REPORT_TARGET,
        };
        return {
          version: 1 as const,
          digest: snapshot,
          full: snapshot,
          delivery: {
            ...delivery,
            payloadIdentity: pendingReportDeliveryPayloadIdentity(delivery),
          },
        };
      },
    ],
    [
      'on-demand request',
      (snapshot: ReturnType<SituationReporter['snapshot']>) => {
        const request = {
          mode: 'full' as const,
          deliveryId: 'unknown-on-demand-key-d1',
          occurrence: {
            kind: 'on_demand_full' as const,
            firedAtIso: '2026-08-02T00:00:00.000Z',
            unknown: 'substitutes-for-hourKey',
          },
          acceptedAtIso: '2026-08-02T00:00:00.000Z',
          target: TEST_REPORT_TARGET,
        };
        return {
          version: 1 as const,
          digest: snapshot,
          full: snapshot,
          request: {
            ...request,
            payloadIdentity: pendingReportRequestPayloadIdentity(request),
          },
        };
      },
    ],
  ] as const)(
    'TG-06 quarantines a persisted %s with an unknown occurrence key',
    async (_phase, buildState) => {
      const root = await mkdtemp(join(tmpdir(), 'mama-report-buffer-'));
      const path = join(root, 'pending.json');
      const state = buildState(new SituationReporter().snapshot());
      await writeFile(path, JSON.stringify(state));

      expect(new FilePendingReportStore(path).loadStatus()).toBe('quarantined');
      expect(await readdir(root)).toEqual(
        expect.arrayContaining([
          expect.stringMatching(/^pending\.json\.corrupt-/),
          'pending.json.quarantined',
        ])
      );
    }
  );

  it('TG-06 quarantines a legacy active delivery without an authorized target binding', async () => {
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
          text: 'unbound legacy payload',
          citedTriggerIds: [],
          createdAtIso: '2026-08-02T00:00:00.000Z',
          deliveryId: 'legacy-unbound-d1',
          occurrence: { kind: 'digest' },
        },
      })
    );

    expect(new FilePendingReportStore(path).loadStatus()).toBe('quarantined');
    expect(await readdir(root)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^pending\.json\.corrupt-/),
        'pending.json.quarantined',
      ])
    );
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

  it('TG-06 preserves a durable quarantine until explicit recovery replaces it', async () => {
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

    const recovered = { version: 1, digest: snapshot, full: snapshot } as const;
    expect(() => store.save(recovered)).toThrow(
      'Pending owner-report state is quarantined; explicit recovery is required'
    );
    expect(new FilePendingReportStore(path).loadStatus()).toBe('quarantined');

    store.recoverWithValidState(recovered);

    expect(new FilePendingReportStore(path).loadStatus()).toBe('ready');
    expect(new FilePendingReportStore(path).load()?.digest).toEqual(snapshot);
    expect(await readdir(root)).not.toContain('pending.json.quarantined');
  });

  it('TG-06 causally serializes loader-first and recovery-first child-process races', async () => {
    const snapshot = new SituationReporter().snapshot();
    const valid = { version: 1, digest: snapshot, full: snapshot };
    const invalid = JSON.stringify({ version: 1, digest: snapshot, full: { invalid: true } });

    const loaderFirstRoot = await mkdtemp(join(tmpdir(), 'mama-report-buffer-'));
    const loaderFirstPath = join(loaderFirstRoot, 'pending.json');
    const loaderEntered = join(loaderFirstRoot, 'loader-entered');
    const releaseLoader = join(loaderFirstRoot, 'release-loader');
    const recoveryAttempted = join(loaderFirstRoot, 'recovery-attempted');
    await writeFile(loaderFirstPath, invalid);
    const invalidLoader = startPendingStoreChild('load', loaderFirstPath, null, {
      barrierEnteredPath: loaderEntered,
      barrierReleasePath: releaseLoader,
    });
    await invalidLoader.ready;
    await waitForFile(loaderEntered);
    const recoveryAfterLoad = startPendingStoreChild('recover', loaderFirstPath, valid, {
      attemptPath: recoveryAttempted,
    });
    await recoveryAfterLoad.ready;
    await waitForFile(recoveryAttempted);
    expect(existsSync(releaseLoader)).toBe(false);
    writeFileSync(releaseLoader, 'release');
    await Promise.all([invalidLoader.exited, recoveryAfterLoad.exited]);
    expect(new FilePendingReportStore(loaderFirstPath).load()).toEqual(valid);
    const loaderFirstEvidence = (await readdir(loaderFirstRoot)).find((entry) =>
      entry.startsWith('pending.json.corrupt-')
    );
    expect(loaderFirstEvidence).toBeDefined();
    expect(await readFile(join(loaderFirstRoot, loaderFirstEvidence as string), 'utf8')).toBe(
      invalid
    );

    const recoveryFirstRoot = await mkdtemp(join(tmpdir(), 'mama-report-buffer-'));
    const recoveryFirstPath = join(recoveryFirstRoot, 'pending.json');
    await writeFile(recoveryFirstPath, invalid);
    const recoveryFirst = startPendingStoreChild('recover', recoveryFirstPath, valid);
    await recoveryFirst.ready;
    await recoveryFirst.exited;
    const staleLoader = startPendingStoreChild('load', recoveryFirstPath, null);
    await staleLoader.ready;
    await staleLoader.exited;
    expect(new FilePendingReportStore(recoveryFirstPath).load()).toEqual(valid);
    expect(
      (await readdir(recoveryFirstRoot)).filter((entry) => entry.includes('.corrupt-'))
    ).toEqual([]);
  });

  it('TG-06 rejects a normal save whose empty read lost to explicit recovery', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mama-report-buffer-'));
    const path = join(root, 'pending.json');
    const snapshot = new SituationReporter().snapshot();
    const store = new FilePendingReportStore(path);
    const empty = store.loadOutcome();
    expect(empty).toEqual({ status: 'empty', revision: null });
    const recovered = {
      version: 1,
      digest: snapshot,
      full: snapshot,
      delivery: bindDelivery({
        mode: 'digest' as const,
        text: 'externally recovered d1',
        citedTriggerIds: [],
        createdAtIso: '2026-08-02T00:00:00.000Z',
        deliveryId: 'd1',
        occurrence: { kind: 'digest' as const },
      }),
    };
    store.recoverWithValidState(recovered);

    expect(() => store.save({ version: 1, digest: snapshot, full: snapshot }, empty)).toThrow(
      'Pending owner-report state changed before normal save'
    );
    expect(store.loadOutcome()).toMatchObject({
      status: 'ready',
      state: { delivery: { deliveryId: 'd1', text: 'externally recovered d1' } },
    });
  });

  it('TG-06 serializes concurrent invalid loaders into one preserved quarantine', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mama-report-buffer-'));
    const path = join(root, 'pending.json');
    const snapshot = new SituationReporter().snapshot();
    await writeFile(
      path,
      JSON.stringify({ version: 1, digest: snapshot, full: { invalid: true } })
    );
    const first = startPendingStoreChild('load', path, null);
    const second = startPendingStoreChild('load', path, null);

    await Promise.all([first.ready, second.ready]);
    await Promise.all([first.exited, second.exited]);

    const entries = await readdir(root);
    expect(entries.filter((entry) => entry.startsWith('pending.json.corrupt-'))).toHaveLength(1);
    expect(entries).toContain('pending.json.quarantined');
    expect(new FilePendingReportStore(path).loadStatus()).toBe('quarantined');
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
      request: bindRequest({
        mode: 'full',
        deliveryId: 'operator-report:on_demand_full:request-1',
        occurrence: {
          kind: 'on_demand_full',
          hourKey: '2026-07-22:13',
          firedAtIso: '2026-07-22T04:00:00.000Z',
        },
        acceptedAtIso: '2026-07-22T04:00:00.000Z',
      }),
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
