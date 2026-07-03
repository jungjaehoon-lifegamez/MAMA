import { beforeAll, describe, expect, it } from 'vitest';
import { appendFileSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  MemoryProvenanceRecord,
  MemoryStatus,
  PublicSaveMemoryInput,
  RecallBundle,
  TrustedMemoryWriteOptions,
} from '@jungjaehoon/mama-core';
import type { SyntheticDogfoodMemoryBackend } from '../../src/operator-vnext/synthetic-dogfood-harness.js';
import type { SQLiteDatabase } from '../../src/sqlite.js';

process.env.MAMA_FORCE_TIER_3 = 'true';

const require = createRequire(import.meta.url);

type HarnessModule = typeof import('../../src/operator-vnext/synthetic-dogfood-harness.js');
type FixturesModule = typeof import('./fixtures.js');

interface MamaApiModule {
  saveMemoryWithTrustedProvenance: (
    input: PublicSaveMemoryInput,
    options: TrustedMemoryWriteOptions
  ) => Promise<{ success: boolean; id: string }>;
  recallMemory: (
    query: string,
    options?: { scopes?: Array<{ kind: string; id: string }>; includeProfile?: boolean }
  ) => Promise<RecallBundle>;
  listMemoriesByGatewayCallId: (gatewayCallId: string) => Promise<MemoryProvenanceRecord[]>;
}

interface MamaCoreModule {
  promoteMemoryStatus: (input: { memoryId: string; status: MemoryStatus }) => Promise<void>;
}

interface DbManagerModule {
  initDB: () => Promise<unknown>;
  closeDB: () => Promise<void>;
  getAdapter: () => {
    prepare: (sql: string) => {
      get: (...params: unknown[]) => unknown;
    };
  };
}

let runSyntheticDogfoodHarness: HarnessModule['runSyntheticDogfoodHarness'];
let createSyntheticDogfoodMemoryStore: HarnessModule['createSyntheticDogfoodMemoryStore'];
let SYNTHETIC_DOGFOOD_CHANNEL: HarnessModule['SYNTHETIC_DOGFOOD_CHANNEL'];
let SYNTHETIC_DOGFOOD_CONNECTOR: HarnessModule['SYNTHETIC_DOGFOOD_CONNECTOR'];
let SYNTHETIC_DOGFOOD_RAW_CANARIES: HarnessModule['SYNTHETIC_DOGFOOD_RAW_CANARIES'];
let countRows: FixturesModule['countRows'];
let makeOperatorVNextDb: FixturesModule['makeOperatorVNextDb'];

beforeAll(async () => {
  const harness = await import('../../src/operator-vnext/synthetic-dogfood-harness.js');
  const fixtures = await import('./fixtures.js');

  runSyntheticDogfoodHarness = harness.runSyntheticDogfoodHarness;
  createSyntheticDogfoodMemoryStore = harness.createSyntheticDogfoodMemoryStore;
  SYNTHETIC_DOGFOOD_CHANNEL = harness.SYNTHETIC_DOGFOOD_CHANNEL;
  SYNTHETIC_DOGFOOD_CONNECTOR = harness.SYNTHETIC_DOGFOOD_CONNECTOR;
  SYNTHETIC_DOGFOOD_RAW_CANARIES = harness.SYNTHETIC_DOGFOOD_RAW_CANARIES;
  countRows = fixtures.countRows;
  makeOperatorVNextDb = fixtures.makeOperatorVNextDb;
});

function readNonRawLedgerRows(db: SQLiteDatabase): Record<string, unknown[]> {
  return {
    commits: db
      .prepare(
        `SELECT cursor_name, first_change_seq, last_change_seq, status, idempotency_key,
                source_refs_json, changed_refs_json
         FROM vnext_operator_commits
         ORDER BY last_change_seq`
      )
      .all() as unknown[],
    noUpdates: db
      .prepare(
        `SELECT scope_key, reason, source_refs_json
         FROM operator_no_updates
         ORDER BY created_at_ms`
      )
      .all() as unknown[],
    wikiArtifacts: db
      .prepare(
        `SELECT path, title, content, source_refs_json
         FROM wiki_artifacts
         ORDER BY path`
      )
      .all() as unknown[],
    memoryIntents: db
      .prepare(
        `SELECT cursor_name, memory_payload_hash, source_refs_json, status
         FROM operator_memory_commit_intents
         ORDER BY created_at_ms`
      )
      .all() as unknown[],
  };
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

async function withIsolatedMamaCoreDb<T>(
  fn: (modules: {
    mamaApi: MamaApiModule;
    mamaCore: MamaCoreModule;
    dbManager: DbManagerModule;
  }) => Promise<T>
): Promise<T> {
  const tempDir = mkdtempSync(join(tmpdir(), 'mama-dogfood-real-core-'));
  const dbPath = join(tempDir, 'mama-memory.db');
  const previousDbPath = process.env.MAMA_DB_PATH;
  const previousTier3 = process.env.MAMA_FORCE_TIER_3;
  process.env.MAMA_DB_PATH = dbPath;
  process.env.MAMA_FORCE_TIER_3 = 'true';

  const dbManager = require('@jungjaehoon/mama-core/db-manager') as DbManagerModule;
  await dbManager.closeDB();

  try {
    const mamaApi = require('@jungjaehoon/mama-core/mama-api') as MamaApiModule;
    const mamaCore = require('@jungjaehoon/mama-core') as MamaCoreModule;
    return await fn({ mamaApi, mamaCore, dbManager });
  } finally {
    await dbManager.closeDB();
    restoreEnv('MAMA_DB_PATH', previousDbPath);
    restoreEnv('MAMA_FORCE_TIER_3', previousTier3);
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function createRealMamaCoreMemoryBackend(input: {
  mamaApi: MamaApiModule;
  mamaCore: MamaCoreModule;
  dbManager: DbManagerModule;
}): SyntheticDogfoodMemoryBackend {
  let recallCalls = 0;
  return {
    saveMemory: input.mamaApi.saveMemoryWithTrustedProvenance,
    listMemoriesByGatewayCallId: input.mamaApi.listMemoriesByGatewayCallId,
    setMemoryStatus: ({ memoryId, status }) =>
      input.mamaCore.promoteMemoryStatus({ memoryId, status }),
    recallMemory: async (query, options) => {
      recallCalls += 1;
      return input.mamaApi.recallMemory(query, options);
    },
    getTotalRecallCalls: () => recallCalls,
    hasActiveMemory: async (topic) => {
      await input.dbManager.initDB();
      const row = input.dbManager
        .getAdapter()
        .prepare(
          `SELECT id
           FROM decisions
           WHERE topic = ?
             AND status = 'active'
           LIMIT 1`
        )
        .get(topic) as { id: string } | undefined;
      return row !== undefined;
    },
  };
}

function withMutatingSaveMemory(
  memoryStore: SyntheticDogfoodMemoryBackend,
  mutate: () => void
): SyntheticDogfoodMemoryBackend {
  return {
    saveMemory: async (...args: Parameters<SyntheticDogfoodMemoryBackend['saveMemory']>) => {
      mutate();
      return memoryStore.saveMemory(...args);
    },
    listMemoriesByGatewayCallId: memoryStore.listMemoriesByGatewayCallId,
    setMemoryStatus: memoryStore.setMemoryStatus,
    recallMemory: memoryStore.recallMemory.bind(memoryStore),
    getTotalRecallCalls: () => memoryStore.getTotalRecallCalls(),
    hasActiveMemory: (topic) => memoryStore.hasActiveMemory(topic),
  };
}

describe('STORY-VNEXT-PR16-SYNTHETIC-DOGFOOD: synthetic end-to-end dogfood harness', () => {
  describe('AC: repeatable synthetic connector review proves preview, commit, projection, and recall gates', () => {
    it('runs one synthetic batch without real connector data, local artifacts, or raw-data leakage', async () => {
      const db = makeOperatorVNextDb();
      const memoryStore = createSyntheticDogfoodMemoryStore();
      const artifactRoot = mkdtempSync(join(tmpdir(), 'mama-dogfood-artifacts-'));
      writeFileSync(join(artifactRoot, 'preexisting.db'), 'synthetic pre-existing artifact');

      try {
        const result = await runSyntheticDogfoodHarness({
          db,
          memoryStore,
          artifactRoot,
          nowMs: () => 1_710_000_000_000,
        });

        expect(result.scenario).toMatchObject({
          synthetic: true,
          connector: SYNTHETIC_DOGFOOD_CONNECTOR,
          channel: SYNTHETIC_DOGFOOD_CHANNEL,
        });
        expect(result.events.map((event) => event.sourceId)).toEqual([
          'synthetic-no-update-001',
          'synthetic-wiki-001',
          'synthetic-memory-001',
        ]);

        expect(result.preview).toMatchObject({
          advancedThroughSeq: 0,
          events: [
            { seq: 1, sourceId: 'synthetic-no-update-001' },
            { seq: 2, sourceId: 'synthetic-wiki-001' },
            { seq: 3, sourceId: 'synthetic-memory-001' },
          ],
        });
        expect(result.dryRun).toMatchObject({
          mode: 'dry_run',
          status: 'ready',
          candidateCount: 3,
          durableWrites: { commits: 0, cursors: 0, noUpdates: 0 },
        });
        expect(result.dryRunWriteCounts).toEqual({
          commits: 0,
          cursors: 0,
          noUpdates: 0,
          wikiArtifacts: 0,
          memoryIntents: 0,
        });

        expect(result.commits.noUpdate).toMatchObject({
          ok: true,
          status: 'committed',
          processed: 1,
          advancedThroughSeq: 1,
          commits: [{ seq: 1, status: 'no_update', outcome: 'committed' }],
        });
        expect(result.commits.wiki).toMatchObject({
          ok: true,
          status: 'committed',
          processed: 1,
          advancedThroughSeq: 2,
          pagesStored: 1,
          commits: [{ seq: 2, status: 'changed', outcome: 'committed' }],
        });
        expect(result.commits.memory).toMatchObject({
          ok: true,
          status: 'committed',
          processed: 1,
          advancedThroughSeq: 3,
          memoriesSaved: 1,
          commits: [{ seq: 3, status: 'changed', outcome: 'committed' }],
        });
        expect(result.replay.memory).toMatchObject({
          ok: true,
          status: 'committed',
          processed: 1,
          memoriesSaved: 0,
          commits: [{ seq: 3, outcome: 'already_committed', cursorAdvanced: false }],
        });

        expect(result.projection).toMatchObject({
          projectionVersion: 1,
          status: { total: 1, live: 1, pendingVerification: 0, verified: 1 },
        });
        expect(result.projection.today[0]).toMatchObject({
          situation_id: 'synthetic_dogfood_memory_follow_up',
          title: 'Synthetic memory follow-up is committed',
          evidence_refs: [`raw:${SYNTHETIC_DOGFOOD_CONNECTOR}:${result.events[2].eventIndexId}`],
        });

        expect(result.recall.ordinary).toEqual({
          recallInvoked: false,
          memories: [],
        });
        expect(result.recall.negativeExplicit).toEqual({
          recallInvoked: true,
          memories: [],
        });
        expect(result.recall.explicit).toMatchObject({
          recallInvoked: true,
          memories: [
            {
              topic: 'operator/manual-memory',
              summary: 'Synthetic reviewed memory is available after explicit recall.',
            },
          ],
        });
        expect(result.recall.totalRecallCalls).toBe(2);

        const countsAfterFirstRun = {
          commits: countRows(db, 'vnext_operator_commits'),
          cursors: countRows(db, 'vnext_operator_cursors'),
          noUpdates: countRows(db, 'operator_no_updates'),
          wikiArtifacts: countRows(db, 'wiki_artifacts'),
          memoryIntents: countRows(db, 'operator_memory_commit_intents'),
        };
        expect(countsAfterFirstRun).toEqual({
          commits: 3,
          cursors: 1,
          noUpdates: 1,
          wikiArtifacts: 1,
          memoryIntents: 1,
        });
        expect(countRows(db, 'vnext_operator_commits')).toBe(3);
        expect(countRows(db, 'operator_no_updates')).toBe(1);
        expect(countRows(db, 'wiki_artifacts')).toBe(1);
        expect(countRows(db, 'operator_memory_commit_intents')).toBe(1);
        expect(result.artifacts.repoDbFilesCreated).toEqual([]);

        const durableLedgers = JSON.stringify(readNonRawLedgerRows(db));
        expect(durableLedgers).not.toContain('SYNTHETIC RAW REDACTED BODY');
        expect(durableLedgers).not.toContain('synthetic-redacted-author');
        expect(durableLedgers).not.toContain('metadata_json');
        expect(durableLedgers).not.toContain('/Users/');
        for (const canary of SYNTHETIC_DOGFOOD_RAW_CANARIES) {
          expect(durableLedgers).not.toContain(canary);
        }

        const serialized = JSON.stringify(result);
        expect(serialized).not.toContain('SYNTHETIC RAW REDACTED BODY');
        expect(serialized).not.toContain('synthetic-redacted-author');
        expect(serialized).not.toContain('metadata_json');
        expect(serialized).not.toContain('/Users/');
        expect(serialized).not.toContain('memory_synthetic_');
        for (const canary of SYNTHETIC_DOGFOOD_RAW_CANARIES) {
          expect(serialized).not.toContain(canary);
        }

        const repeat = await runSyntheticDogfoodHarness({
          db,
          memoryStore,
          artifactRoot,
          nowMs: () => 1_710_000_000_000,
        });

        expect(repeat.preview).toMatchObject({
          advancedThroughSeq: 3,
          events: [],
        });
        expect(repeat.commits.noUpdate.commits).toEqual([
          { seq: 1, status: 'no_update', outcome: 'already_committed', cursorAdvanced: false },
        ]);
        expect(repeat.commits.wiki).toMatchObject({
          pagesStored: 0,
          commits: [{ seq: 2, status: 'changed', outcome: 'already_committed' }],
        });
        expect(repeat.commits.memory).toMatchObject({
          memoriesSaved: 0,
          commits: [{ seq: 3, status: 'changed', outcome: 'already_committed' }],
        });
        expect(repeat.recall.totalRecallCalls).toBe(4);
        expect(repeat.recall.explicit.memories).toEqual(result.recall.explicit.memories);
        expect(repeat.artifacts.repoDbFilesCreated).toEqual([]);
        expect({
          commits: countRows(db, 'vnext_operator_commits'),
          cursors: countRows(db, 'vnext_operator_cursors'),
          noUpdates: countRows(db, 'operator_no_updates'),
          wikiArtifacts: countRows(db, 'wiki_artifacts'),
          memoryIntents: countRows(db, 'operator_memory_commit_intents'),
        }).toEqual(countsAfterFirstRun);

        await expect(
          runSyntheticDogfoodHarness({
            db,
            memoryStore: createSyntheticDogfoodMemoryStore(),
            artifactRoot,
            nowMs: () => 1_710_000_000_000,
          })
        ).rejects.toThrow(/committed memory intent without retrievable memory state/);
        expect({
          commits: countRows(db, 'vnext_operator_commits'),
          cursors: countRows(db, 'vnext_operator_cursors'),
          noUpdates: countRows(db, 'operator_no_updates'),
          wikiArtifacts: countRows(db, 'wiki_artifacts'),
          memoryIntents: countRows(db, 'operator_memory_commit_intents'),
        }).toEqual(countsAfterFirstRun);
      } finally {
        db.close();
        rmSync(artifactRoot, { recursive: true, force: true });
      }
    });

    it('uses the repository root for database artifact checks by default', async () => {
      const db = makeOperatorVNextDb();
      const memoryStore = createSyntheticDogfoodMemoryStore();

      try {
        const result = await runSyntheticDogfoodHarness({
          db,
          memoryStore,
          nowMs: () => 1_710_000_000_000,
        });

        expect(result.artifacts.repoDbFilesCreated).toEqual([]);
      } finally {
        db.close();
      }
    });

    it('fails if a synthetic run mutates an existing repository database artifact', async () => {
      const db = makeOperatorVNextDb();
      const memoryStore = createSyntheticDogfoodMemoryStore();
      const artifactRoot = mkdtempSync(join(tmpdir(), 'mama-dogfood-artifact-mutation-'));
      const preexistingDb = join(artifactRoot, 'preexisting.db');
      writeFileSync(preexistingDb, 'synthetic pre-existing artifact');
      const mutatingMemoryStore = withMutatingSaveMemory(memoryStore, () => {
        appendFileSync(preexistingDb, '\nmodified during synthetic run');
      });

      try {
        await expect(
          runSyntheticDogfoodHarness({
            db,
            memoryStore: mutatingMemoryStore,
            artifactRoot,
            nowMs: () => 1_710_000_000_000,
          })
        ).rejects.toThrow(/created or modified repository DB artifacts: preexisting\.db/);
      } finally {
        db.close();
        rmSync(artifactRoot, { recursive: true, force: true });
      }
    });

    it('fails if a synthetic run deletes an existing repository database artifact', async () => {
      const db = makeOperatorVNextDb();
      const memoryStore = createSyntheticDogfoodMemoryStore();
      const artifactRoot = mkdtempSync(join(tmpdir(), 'mama-dogfood-artifact-delete-'));
      const preexistingDb = join(artifactRoot, 'preexisting.db');
      writeFileSync(preexistingDb, 'synthetic pre-existing artifact');
      const mutatingMemoryStore = withMutatingSaveMemory(memoryStore, () => {
        unlinkSync(preexistingDb);
      });

      try {
        await expect(
          runSyntheticDogfoodHarness({
            db,
            memoryStore: mutatingMemoryStore,
            artifactRoot,
            nowMs: () => 1_710_000_000_000,
          })
        ).rejects.toThrow(/created or modified repository DB artifacts: preexisting\.db/);
      } finally {
        db.close();
        rmSync(artifactRoot, { recursive: true, force: true });
      }
    });

    it('fails if a synthetic run rewrites an existing repository database artifact at the same size', async () => {
      const db = makeOperatorVNextDb();
      const memoryStore = createSyntheticDogfoodMemoryStore();
      const artifactRoot = mkdtempSync(join(tmpdir(), 'mama-dogfood-artifact-same-size-'));
      const preexistingDb = join(artifactRoot, 'preexisting.db');
      writeFileSync(preexistingDb, 'AAAA');
      const mutatingMemoryStore = withMutatingSaveMemory(memoryStore, () => {
        writeFileSync(preexistingDb, 'BBBB');
      });

      try {
        await expect(
          runSyntheticDogfoodHarness({
            db,
            memoryStore: mutatingMemoryStore,
            artifactRoot,
            nowMs: () => 1_710_000_000_000,
          })
        ).rejects.toThrow(/created or modified repository DB artifacts: preexisting\.db/);
      } finally {
        db.close();
        rmSync(artifactRoot, { recursive: true, force: true });
      }
    });

    it('uses real isolated mama-core save, provenance, and recall across replay restart', async () => {
      await withIsolatedMamaCoreDb(async ({ mamaApi, mamaCore, dbManager }) => {
        const db = makeOperatorVNextDb();
        const artifactRoot = mkdtempSync(join(tmpdir(), 'mama-dogfood-real-artifacts-'));

        try {
          const result = await runSyntheticDogfoodHarness({
            db,
            memoryStore: createRealMamaCoreMemoryBackend({ mamaApi, mamaCore, dbManager }),
            artifactRoot,
            nowMs: () => 1_710_000_000_000,
          });

          expect(result.commits.memory).toMatchObject({
            memoriesSaved: 1,
            commits: [{ seq: 3, status: 'changed', outcome: 'committed' }],
          });
          expect(result.recall.explicit).toMatchObject({
            recallInvoked: true,
            memories: [
              {
                topic: 'operator/manual-memory',
                summary: 'Synthetic reviewed memory is available after explicit recall.',
              },
            ],
          });

          await dbManager.closeDB();
          const replay = await runSyntheticDogfoodHarness({
            db,
            memoryStore: createRealMamaCoreMemoryBackend({ mamaApi, mamaCore, dbManager }),
            artifactRoot,
            nowMs: () => 1_710_000_000_000,
          });

          expect(replay.commits.memory).toMatchObject({
            memoriesSaved: 0,
            commits: [{ seq: 3, status: 'changed', outcome: 'already_committed' }],
          });
          expect(replay.recall.totalRecallCalls).toBe(2);
          expect(replay.recall.explicit.memories).toEqual(result.recall.explicit.memories);
        } finally {
          db.close();
          rmSync(artifactRoot, { recursive: true, force: true });
        }
      });
    });
  });
});
