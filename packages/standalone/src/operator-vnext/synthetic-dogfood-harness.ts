import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync, type Dirent } from 'node:fs';
import { relative, resolve } from 'node:path';

import {
  createTrustedProvenanceCapability,
  type MemoryProvenanceRecord,
  type RecallBundle,
  type MemoryScopeRef,
  type MemoryStatus,
  type PublicSaveMemoryInput,
  type TrustedMemoryWriteOptions,
} from '@jungjaehoon/mama-core';
import { connectorEventIndexId } from '@jungjaehoon/mama-core/connectors/event-index';
import type { SourceRef } from '@jungjaehoon/mama-core/provenance/source-ref';

import { GatewayToolExecutor } from '../agent/gateway-tool-executor.js';
import type {
  AgentContext,
  GatewayToolExecutionContext,
  GatewayToolResult,
  MAMAApiInterface,
} from '../agent/types.js';
import { DEFAULT_ROLES } from '../cli/config/types.js';
import type { MamaApiClient } from '../gateways/context-injector.js';
import { createMockAgentLoop, MessageRouter } from '../gateways/message-router.js';
import { SessionStore } from '../gateways/session-store.js';
import type { SQLiteDatabase } from '../sqlite.js';
import { WikiArtifactStore } from '../wiki-artifacts/wiki-artifact-store.js';
import { createWikiPublishAdapter } from '../wiki-artifacts/wiki-publish-adapter.js';
import {
  buildConnectorEventIngressPreview,
  type ConnectorEventIngressPreview,
} from './connector-event-ingress.js';
import {
  commitConnectorIngressMemoryBatch,
  type ConnectorIngressManualMemoryCommitInput,
  type ConnectorIngressManualMemoryCommitResult,
} from './connector-ingress-manual-memory-commit.js';
import {
  commitConnectorIngressNoUpdateBatch,
  type ConnectorIngressManualCommitResult,
} from './connector-ingress-manual-commit.js';
import {
  commitConnectorIngressWikiBatch,
  type ConnectorIngressManualWikiCommitResult,
} from './connector-ingress-manual-wiki-commit.js';
import {
  buildConnectorIngressMigrationDryRun,
  type ConnectorIngressMigrationDryRun,
} from './connector-ingress-migration-dry-run.js';
import { buildSituationProjection } from './situation-projection.js';
import type { VNextSituationProjection } from './situation-projection-types.js';

export const SYNTHETIC_DOGFOOD_CONNECTOR = 'synthetic';
export const SYNTHETIC_DOGFOOD_CHANNEL = 'C_MAMA_VNEXT_SYNTHETIC';

const SYNTHETIC_INDEXED_AT = '2026-07-03T00:00:00.000Z';
const SYNTHETIC_MEMORY_TOPIC = 'operator/manual-memory';
const SYNTHETIC_MEMORY_SUMMARY = 'Synthetic reviewed memory is available after explicit recall.';
const SYNTHETIC_MEMORY_DETAILS =
  'Synthetic operator-approved detail derived from a reviewed fixture.';
const SYNTHETIC_PROJECT_SCOPE: MemoryScopeRef = {
  kind: 'project',
  id: 'project_public_synthetic',
};
const SYNTHETIC_CHANNEL_SCOPE: MemoryScopeRef = {
  kind: 'channel',
  id: `discord:${SYNTHETIC_DOGFOOD_CHANNEL}`,
};
const REPO_DB_ARTIFACT_SUFFIXES = [
  '.db',
  '.sqlite',
  '.sqlite3',
  '.db-wal',
  '.db-shm',
  '.db-journal',
  '.sqlite-wal',
  '.sqlite-shm',
  '.sqlite-journal',
  '.sqlite3-wal',
  '.sqlite3-shm',
  '.sqlite3-journal',
] as const;
const REPO_DB_ARTIFACT_EXCLUDED_DIRS = new Set(['.git', '.pnpm-store', 'node_modules']);
const RAW_CONTENT_CANARY = 'MAMA_SYNTHETIC_RAW_CONTENT_CANARY_DO_NOT_LEAK';
const RAW_AUTHOR_CANARY = 'MAMA_SYNTHETIC_AUTHOR_CANARY_DO_NOT_LEAK';
const RAW_LOCATOR_CANARY = 'synthetic://raw-locator-canary/do-not-leak';
const RAW_METADATA_CANARY = 'MAMA_SYNTHETIC_METADATA_CANARY_DO_NOT_LEAK';
const RAW_PATH_CANARY = '/tmp/mama-synthetic-private-path-canary';
export const SYNTHETIC_DOGFOOD_RAW_CANARIES = Object.freeze([
  RAW_CONTENT_CANARY,
  RAW_AUTHOR_CANARY,
  RAW_LOCATOR_CANARY,
  RAW_METADATA_CANARY,
  RAW_PATH_CANARY,
]);

type SyntheticDogfoodEventRole = 'no_update' | 'wiki' | 'memory';

interface SyntheticDogfoodEventSpec {
  role: SyntheticDogfoodEventRole;
  sourceId: string;
  timestampMs: number;
  title: string;
  rawBody: string;
}

export interface SyntheticDogfoodSeededEvent {
  role: SyntheticDogfoodEventRole;
  eventIndexId: string;
  sourceId: string;
}

interface SyntheticDogfoodWriteCounts {
  commits: number;
  cursors: number;
  noUpdates: number;
  wikiArtifacts: number;
  memoryIntents: number;
}

interface RepoDbArtifactSnapshot {
  size: number;
  sha256: string;
}

export interface SyntheticDogfoodRecallMemory {
  topic: string;
  summary: string;
}

interface SyntheticDogfoodExplicitRecall {
  recallInvoked: true;
  memories: SyntheticDogfoodRecallMemory[];
}

interface SyntheticDogfoodOrdinaryRecall {
  recallInvoked: false;
  memories: [];
}

export interface SyntheticDogfoodHarnessInput {
  db: SQLiteDatabase;
  nowMs?: () => number;
  artifactRoot?: string;
  memoryStore?: SyntheticDogfoodMemoryBackend;
}

export interface SyntheticDogfoodHarnessResult {
  scenario: {
    synthetic: true;
    connector: typeof SYNTHETIC_DOGFOOD_CONNECTOR;
    channel: typeof SYNTHETIC_DOGFOOD_CHANNEL;
  };
  events: SyntheticDogfoodSeededEvent[];
  preview: ConnectorEventIngressPreview;
  dryRun: ConnectorIngressMigrationDryRun;
  dryRunWriteCounts: SyntheticDogfoodWriteCounts;
  commits: {
    noUpdate: ConnectorIngressManualCommitResult;
    wiki: ConnectorIngressManualWikiCommitResult;
    memory: ConnectorIngressManualMemoryCommitResult;
  };
  replay: {
    memory: ConnectorIngressManualMemoryCommitResult;
  };
  projection: VNextSituationProjection;
  recall: {
    ordinary: SyntheticDogfoodOrdinaryRecall;
    negativeExplicit: SyntheticDogfoodExplicitRecall;
    explicit: SyntheticDogfoodExplicitRecall;
    totalRecallCalls: number;
  };
  artifacts: {
    repoDbFilesCreated: string[];
  };
}

interface StoredSyntheticMemory {
  id: string;
  topic: string;
  summary: string;
  details: string;
  status: MemoryStatus;
  scopes: MemoryScopeRef[];
  gatewayCallId: string;
  sourceRefs: string[];
}

export interface SyntheticDogfoodMemoryBackend {
  saveMemory: (
    input: PublicSaveMemoryInput,
    options: TrustedMemoryWriteOptions
  ) => Promise<{ success: boolean; id: string }>;
  listMemoriesByGatewayCallId: (gatewayCallId: string) => Promise<MemoryProvenanceRecord[]>;
  setMemoryStatus: (input: { memoryId: string; status: MemoryStatus }) => Promise<void> | void;
  recallMemory: (
    query: string,
    options?: { scopes?: Array<{ kind: string; id: string }>; includeProfile?: boolean }
  ) => Promise<RecallBundle> | RecallBundle;
  getTotalRecallCalls: () => number;
  hasActiveMemory: (topic: string) => boolean | Promise<boolean>;
}

function syntheticMemoryMatchesScopes(
  memory: StoredSyntheticMemory,
  requestedScopes: ReadonlyArray<{ kind: string; id: string }>
): boolean {
  if (requestedScopes.length === 0) {
    return false;
  }
  return memory.scopes.some((scope) =>
    requestedScopes.some((requested) => requested.kind === scope.kind && requested.id === scope.id)
  );
}

const SYNTHETIC_DOGFOOD_EVENTS: SyntheticDogfoodEventSpec[] = [
  {
    role: 'no_update',
    sourceId: 'synthetic-no-update-001',
    timestampMs: 1_710_000_001_000,
    title: 'Synthetic no-update event',
    rawBody: `SYNTHETIC RAW REDACTED BODY: no-update fixture must never appear in harness output. ${RAW_CONTENT_CANARY}`,
  },
  {
    role: 'wiki',
    sourceId: 'synthetic-wiki-001',
    timestampMs: 1_710_000_002_000,
    title: 'Synthetic wiki event',
    rawBody: `SYNTHETIC RAW REDACTED BODY: wiki fixture must never appear in harness output. ${RAW_CONTENT_CANARY}`,
  },
  {
    role: 'memory',
    sourceId: 'synthetic-memory-001',
    timestampMs: 1_710_000_003_000,
    title: 'Synthetic memory event',
    rawBody: `SYNTHETIC RAW REDACTED BODY: memory fixture must never appear in harness output. ${RAW_CONTENT_CANARY}`,
  },
];

function createSyntheticTrustedCapability(): TrustedMemoryWriteOptions['capability'] {
  return createTrustedProvenanceCapability();
}

function countRowsBySql(db: SQLiteDatabase, sql: string): number {
  const row = db.prepare(sql).get() as { count: number } | undefined;
  return row?.count ?? 0;
}

function readWriteCounts(db: SQLiteDatabase): SyntheticDogfoodWriteCounts {
  return {
    commits: countRowsBySql(db, 'SELECT COUNT(*) AS count FROM vnext_operator_commits'),
    cursors: countRowsBySql(db, 'SELECT COUNT(*) AS count FROM vnext_operator_cursors'),
    noUpdates: countRowsBySql(db, 'SELECT COUNT(*) AS count FROM operator_no_updates'),
    wikiArtifacts: countRowsBySql(db, 'SELECT COUNT(*) AS count FROM wiki_artifacts'),
    memoryIntents: countRowsBySql(
      db,
      'SELECT COUNT(*) AS count FROM operator_memory_commit_intents'
    ),
  };
}

function readSyntheticEventSeq(db: SQLiteDatabase, event: SyntheticDogfoodSeededEvent): number {
  const row = db
    .prepare(
      `SELECT operator_ingest_seq
       FROM connector_event_index
       WHERE event_index_id = ?
       LIMIT 1`
    )
    .get(event.eventIndexId) as { operator_ingest_seq: number } | undefined;
  if (!row) {
    throw new Error(`Synthetic dogfood event seq not found: ${event.eventIndexId}`);
  }
  return row.operator_ingest_seq;
}

function isRepoDbArtifact(filename: string): boolean {
  return REPO_DB_ARTIFACT_SUFFIXES.some((suffix) => filename.endsWith(suffix));
}

function snapshotRepoDbArtifacts(root: string): Map<string, RepoDbArtifactSnapshot> {
  const artifactRoot = resolve(root);
  const artifacts = new Map<string, RepoDbArtifactSnapshot>();

  function walk(directory: string): void {
    let entries: Dirent[];
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entry.isSymbolicLink()) {
        continue;
      }
      const entryPath = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        if (!REPO_DB_ARTIFACT_EXCLUDED_DIRS.has(entry.name)) {
          walk(entryPath);
        }
        continue;
      }
      if (entry.isFile() && isRepoDbArtifact(entry.name)) {
        const stats = statSync(entryPath);
        artifacts.set(relative(artifactRoot, entryPath), {
          size: stats.size,
          sha256: createHash('sha256').update(readFileSync(entryPath)).digest('hex'),
        });
      }
    }
  }

  walk(artifactRoot);
  return artifacts;
}

function listChangedRepoDbArtifacts(
  before: Map<string, RepoDbArtifactSnapshot>,
  after: Map<string, RepoDbArtifactSnapshot>
): string[] {
  const changed: string[] = [];
  const artifactPaths = new Set([...before.keys(), ...after.keys()]);
  for (const artifact of artifactPaths) {
    const afterSnapshot = after.get(artifact);
    const beforeSnapshot = before.get(artifact);
    if (
      !beforeSnapshot ||
      !afterSnapshot ||
      beforeSnapshot.size !== afterSnapshot.size ||
      beforeSnapshot.sha256 !== afterSnapshot.sha256
    ) {
      changed.push(artifact);
    }
  }
  return changed.sort();
}

function findGitRoot(start: string): string {
  let current = resolve(start);
  let parent = resolve(current, '..');
  while (parent !== current) {
    if (existsSync(resolve(current, '.git'))) {
      return current;
    }
    current = parent;
    parent = resolve(current, '..');
  }
  if (existsSync(resolve(current, '.git'))) {
    return current;
  }
  return resolve(start);
}

function resolveArtifactRoot(artifactRoot: string | undefined): string {
  return artifactRoot ? resolve(artifactRoot) : findGitRoot(process.cwd());
}

function sourceRefFor(event: SyntheticDogfoodSeededEvent): SourceRef {
  return {
    kind: 'raw',
    connector: SYNTHETIC_DOGFOOD_CONNECTOR,
    id: event.eventIndexId,
    source_id: event.sourceId,
    channel_id: SYNTHETIC_DOGFOOD_CHANNEL,
  };
}

function seedSyntheticDogfoodEvent(
  db: SQLiteDatabase,
  spec: SyntheticDogfoodEventSpec,
  index: number
): SyntheticDogfoodSeededEvent {
  const eventIndexId = connectorEventIndexId(SYNTHETIC_DOGFOOD_CONNECTOR, spec.sourceId);
  const existing = db
    .prepare(
      `SELECT event_index_id
       FROM connector_event_index
       WHERE source_connector = ?
         AND source_id = ?
       LIMIT 1`
    )
    .get(SYNTHETIC_DOGFOOD_CONNECTOR, spec.sourceId) as { event_index_id: string } | undefined;

  if (!existing) {
    db.prepare(
      `INSERT INTO connector_event_index (
        event_index_id, source_connector, source_type, source_id, source_locator,
        channel, author, title, content, event_datetime, event_date, source_timestamp_ms,
        metadata_json, content_hash, indexed_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      eventIndexId,
      SYNTHETIC_DOGFOOD_CONNECTOR,
      'synthetic_message',
      spec.sourceId,
      `${RAW_LOCATOR_CANARY}/${spec.sourceId}`,
      SYNTHETIC_DOGFOOD_CHANNEL,
      RAW_AUTHOR_CANARY,
      spec.title,
      spec.rawBody,
      spec.timestampMs,
      new Date(spec.timestampMs).toISOString().slice(0, 10),
      spec.timestampMs,
      JSON.stringify({
        synthetic: true,
        fixture: 'vnext-dogfood',
        raw_locator: `synthetic://redacted/raw/${spec.sourceId}`,
        raw_metadata_canary: RAW_METADATA_CANARY,
        raw_path_canary: RAW_PATH_CANARY,
      }),
      Buffer.alloc(32, index + 1),
      SYNTHETIC_INDEXED_AT,
      SYNTHETIC_INDEXED_AT
    );
  }

  return {
    role: spec.role,
    eventIndexId,
    sourceId: spec.sourceId,
  };
}

function seedSyntheticDogfoodEvents(db: SQLiteDatabase): SyntheticDogfoodSeededEvent[] {
  return SYNTHETIC_DOGFOOD_EVENTS.map((spec, index) => seedSyntheticDogfoodEvent(db, spec, index));
}

export class SyntheticDogfoodMemoryStore {
  private readonly memories = new Map<string, StoredSyntheticMemory>();
  private readonly memoryIdByGatewayCallId = new Map<string, string>();
  private saveSequence = 0;
  private recallCalls = 0;

  saveMemory = async (
    input: PublicSaveMemoryInput,
    options: TrustedMemoryWriteOptions
  ): Promise<{ success: boolean; id: string }> => {
    const gatewayCallId = options.provenance.gateway_call_id;
    if (!gatewayCallId) {
      throw new Error('Synthetic dogfood memory save requires gateway_call_id');
    }

    const existingId = this.memoryIdByGatewayCallId.get(gatewayCallId);
    if (existingId) {
      return { success: true, id: existingId };
    }

    this.saveSequence += 1;
    const id = `memory_synthetic_${this.saveSequence}`;
    const sourceRefs = options.provenance.source_refs ?? [];
    this.memories.set(id, {
      id,
      topic: input.topic,
      summary: input.summary,
      details: input.details,
      status: input.status ?? 'stale',
      scopes: input.scopes,
      gatewayCallId,
      sourceRefs,
    });
    this.memoryIdByGatewayCallId.set(gatewayCallId, id);

    return { success: true, id };
  };

  listMemoriesByGatewayCallId = async (
    gatewayCallId: string
  ): Promise<MemoryProvenanceRecord[]> => {
    const memoryId = this.memoryIdByGatewayCallId.get(gatewayCallId);
    if (!memoryId) {
      return [];
    }
    const memory = this.memories.get(memoryId);
    if (!memory) {
      return [];
    }
    return [
      {
        memory_id: memory.id,
        agent_id: 'operator:manual-admin',
        model_run_id: null,
        envelope_hash: null,
        gateway_call_id: memory.gatewayCallId,
        source_refs: memory.sourceRefs,
        provenance: { synthetic: true },
      },
    ];
  };

  setMemoryStatus = async (input: { memoryId: string; status: MemoryStatus }): Promise<void> => {
    const memory = this.memories.get(input.memoryId);
    if (!memory) {
      throw new Error('Synthetic dogfood memory status target not found');
    }
    this.memories.set(input.memoryId, {
      ...memory,
      status: input.status,
    });
  };

  recallMemory(
    query: string,
    options?: { scopes?: Array<{ kind: string; id: string }>; includeProfile?: boolean }
  ): RecallBundle {
    this.recallCalls += 1;
    const requestedScopes = options?.scopes ?? [];
    const normalizedQuery = query.trim().toLowerCase();
    const scopeOrder = requestedScopes
      .map((scope) => scope.kind)
      .filter((kind): kind is MemoryScopeRef['kind'] =>
        ['global', 'user', 'channel', 'project'].includes(kind)
      );
    const activeMemories = [...this.memories.values()]
      .filter((memory) => memory.status === 'active')
      .filter((memory) => syntheticMemoryMatchesScopes(memory, requestedScopes))
      .filter(
        (memory) =>
          normalizedQuery.length === 0 ||
          memory.topic.toLowerCase().includes(normalizedQuery) ||
          memory.summary.toLowerCase().includes(normalizedQuery) ||
          memory.details.toLowerCase().includes(normalizedQuery)
      )
      .map((memory) => ({
        id: memory.id,
        topic: memory.topic,
        kind: 'decision' as const,
        summary: memory.summary,
        details: memory.details,
        confidence: 0.88,
        status: memory.status,
        scopes: memory.scopes,
        source: {
          package: 'standalone' as const,
          source_type: 'synthetic-dogfood',
          channel_id: SYNTHETIC_DOGFOOD_CHANNEL,
          project_id: SYNTHETIC_PROJECT_SCOPE.id,
        },
        created_at: SYNTHETIC_INDEXED_AT,
        updated_at: SYNTHETIC_INDEXED_AT,
      }));
    return {
      profile: {
        static: [],
        dynamic: [],
        evidence: activeMemories.map((memory, index) => ({
          memory_id: `synthetic_recall_${index + 1}`,
          topic: memory.topic,
          why_included: 'Synthetic explicit recall matched the requested project scope.',
        })),
      },
      memories: activeMemories,
      graph_context: {
        primary: activeMemories,
        expanded: [],
        edges: [],
      },
      search_meta: {
        query,
        scope_order: scopeOrder,
        retrieval_sources: ['synthetic'],
      },
    };
  }

  getTotalRecallCalls(): number {
    return this.recallCalls;
  }

  hasActiveMemory(topic: string): boolean {
    return [...this.memories.values()].some(
      (memory) => memory.topic === topic && memory.status === 'active'
    );
  }
}

export function createSyntheticDogfoodMemoryStore(): SyntheticDogfoodMemoryStore {
  return new SyntheticDogfoodMemoryStore();
}

function createSyntheticMamaApi(memoryStore: SyntheticDogfoodMemoryBackend): MAMAApiInterface {
  return {
    save: async () => ({
      success: false,
      code: 'synthetic_unused',
      message: 'Synthetic dogfood harness only enables explicit recall.',
    }),
    saveCheckpoint: async () => ({
      success: false,
      message: 'Synthetic dogfood harness does not save checkpoints.',
    }),
    listDecisions: async () => [],
    suggest: async () => ({
      success: true,
      results: [],
      count: 0,
    }),
    recallMemory: async (query, options) => memoryStore.recallMemory(query, options),
    ingestMemory: async () => ({
      success: false,
      code: 'synthetic_unused',
    }),
    updateOutcome: async () => ({
      success: false,
      message: 'Synthetic dogfood harness does not update outcomes.',
    }),
    loadCheckpoint: async () => ({
      success: false,
      message: 'Synthetic dogfood harness does not load checkpoints.',
    }),
    appendToolTrace: async (trace) => ({
      trace_id: trace.trace_id ?? 'trace_synthetic_dogfood_recall',
      model_run_id: trace.model_run_id,
      gateway_call_id: trace.gateway_call_id ?? null,
      tool_name: trace.tool_name,
      input_summary: trace.input_summary ?? null,
      output_summary: trace.output_summary ?? null,
      execution_status: trace.execution_status ?? null,
      duration_ms: trace.duration_ms ?? 0,
      envelope_hash: trace.envelope_hash ?? null,
      created_at: trace.created_at ?? Date.parse(SYNTHETIC_INDEXED_AT),
    }),
  };
}

function createSyntheticRouterApi(memoryStore: SyntheticDogfoodMemoryBackend): MamaApiClient {
  return {
    search: async () => [],
    listDecisions: async () => [],
    save: async () => ({
      success: false,
      code: 'synthetic_unused',
    }),
    recallMemory: async (query, options) => memoryStore.recallMemory(query, options),
    ingestMemory: async () => ({
      success: false,
      code: 'synthetic_unused',
    }),
  };
}

async function executeSyntheticOrdinaryRouterTurn(input: {
  db: SQLiteDatabase;
  memoryStore: SyntheticDogfoodMemoryBackend;
}): Promise<SyntheticDogfoodOrdinaryRecall> {
  const callsBefore = input.memoryStore.getTotalRecallCalls();
  let prompt = '';
  const router = new MessageRouter(
    new SessionStore(input.db),
    createMockAgentLoop((nextPrompt) => {
      prompt = nextPrompt;
      return 'Synthetic ordinary response';
    }),
    createSyntheticRouterApi(input.memoryStore)
  );

  await router.process({
    source: 'discord',
    channelId: SYNTHETIC_DOGFOOD_CHANNEL,
    userId: 'synthetic-ordinary-user',
    text: 'Synthetic ordinary turn should not recall memory without the explicit tool.',
  });

  if (input.memoryStore.getTotalRecallCalls() !== callsBefore) {
    throw new Error('Synthetic ordinary router turn unexpectedly invoked recallMemory');
  }
  if (prompt.includes('[MAMA Profile]') || prompt.includes('[MAMA Memories]')) {
    throw new Error('Synthetic ordinary router turn injected recalled memory');
  }

  return {
    recallInvoked: false,
    memories: [],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function parseRecallMemory(value: unknown): SyntheticDogfoodRecallMemory {
  if (!isRecord(value) || typeof value.topic !== 'string' || typeof value.summary !== 'string') {
    throw new Error('Synthetic recall result did not contain a valid memory');
  }
  return {
    topic: value.topic,
    summary: value.summary,
  };
}

function recallMemoriesFromGatewayResult(
  result: GatewayToolResult
): SyntheticDogfoodRecallMemory[] {
  if (!result.success) {
    const error =
      isRecord(result) && typeof result.error === 'string' ? result.error : 'unknown error';
    throw new Error(`Synthetic explicit recall failed: ${error}`);
  }
  const bundle = isRecord(result) ? result.bundle : undefined;
  if (!isRecord(bundle)) {
    throw new Error('Synthetic explicit recall did not return a recall bundle');
  }
  if (!Array.isArray(bundle.memories)) {
    return [];
  }
  return bundle.memories.map(parseRecallMemory);
}

async function executeSyntheticExplicitRecall(input: {
  executor: GatewayToolExecutor;
  query: string;
  scopes: MemoryScopeRef[];
  executionContext: GatewayToolExecutionContext;
}): Promise<SyntheticDogfoodExplicitRecall> {
  const result = await input.executor.execute(
    'mama_recall',
    {
      query: input.query,
      scopes: input.scopes,
    },
    input.executionContext
  );
  return {
    recallInvoked: true,
    memories: recallMemoriesFromGatewayResult(result),
  };
}

function createSyntheticRecallAgentContext(): AgentContext {
  const role = DEFAULT_ROLES.definitions.chat_bot;
  return {
    source: 'discord',
    platform: 'discord',
    roleName: 'chat_bot',
    role,
    session: {
      sessionId: 'synthetic-dogfood-explicit-recall',
      channelId: SYNTHETIC_DOGFOOD_CHANNEL,
      userId: 'synthetic-dogfood-user',
      startedAt: new Date(SYNTHETIC_INDEXED_AT),
    },
    capabilities: role.allowedTools,
    limitations: ['Synthetic dogfood execution context'],
    tier: 1,
  };
}

function createSyntheticRecallExecutionContext(): GatewayToolExecutionContext {
  const agentContext = createSyntheticRecallAgentContext();
  return {
    agentContext,
    agentId: 'chat_bot',
    source: 'discord',
    channelId: SYNTHETIC_DOGFOOD_CHANNEL,
    executionSurface: 'model_tool',
    sourceTurnId: 'synthetic-dogfood-explicit-recall',
    sourceMessageRef: 'synthetic-dogfood-explicit-recall',
    modelRunId: 'mr_synthetic_dogfood_recall',
  };
}

function buildMemoryCommitInput(
  db: SQLiteDatabase,
  event: SyntheticDogfoodSeededEvent,
  expectedAdvancedThroughSeq: number,
  memoryStore: SyntheticDogfoodMemoryBackend,
  nowMs: () => number
): ConnectorIngressManualMemoryCommitInput {
  return {
    rawAdapter: db,
    operatorDb: db,
    connector: SYNTHETIC_DOGFOOD_CONNECTOR,
    channel: SYNTHETIC_DOGFOOD_CHANNEL,
    expectedAdvancedThroughSeq,
    eventMemories: [
      {
        eventIndexId: event.eventIndexId,
        memories: [
          {
            topic: SYNTHETIC_MEMORY_TOPIC,
            kind: 'decision',
            summary: SYNTHETIC_MEMORY_SUMMARY,
            details: SYNTHETIC_MEMORY_DETAILS,
            confidence: 0.88,
            scopes: [SYNTHETIC_PROJECT_SCOPE, SYNTHETIC_CHANNEL_SCOPE],
          },
        ],
      },
    ],
    saveMemory: memoryStore.saveMemory,
    createTrustedProvenanceCapability: createSyntheticTrustedCapability,
    listMemoriesByGatewayCallId: memoryStore.listMemoriesByGatewayCallId,
    setMemoryStatus: memoryStore.setMemoryStatus,
    nowMs,
  };
}

function requireEvent(
  events: readonly SyntheticDogfoodSeededEvent[],
  role: SyntheticDogfoodEventRole
): SyntheticDogfoodSeededEvent {
  const event = events.find((candidate) => candidate.role === role);
  if (!event) {
    throw new Error(`Synthetic dogfood fixture missing ${role} event`);
  }
  return event;
}

async function ensureReplayHasRetrievableMemory(input: {
  memoryStore: SyntheticDogfoodMemoryBackend;
}): Promise<void> {
  if (await input.memoryStore.hasActiveMemory(SYNTHETIC_MEMORY_TOPIC)) {
    return;
  }
  throw new Error(
    'Synthetic dogfood replay found committed memory intent without retrievable memory state'
  );
}

export async function runSyntheticDogfoodHarness(
  input: SyntheticDogfoodHarnessInput
): Promise<SyntheticDogfoodHarnessResult> {
  const nowMs = input.nowMs ?? Date.now;
  const artifactRoot = resolveArtifactRoot(input.artifactRoot);
  const repoDbArtifactsBefore = snapshotRepoDbArtifacts(artifactRoot);
  const events = seedSyntheticDogfoodEvents(input.db);
  const noUpdateEvent = requireEvent(events, 'no_update');
  const wikiEvent = requireEvent(events, 'wiki');
  const memoryEvent = requireEvent(events, 'memory');
  const noUpdateSeq = readSyntheticEventSeq(input.db, noUpdateEvent);
  const wikiSeq = readSyntheticEventSeq(input.db, wikiEvent);
  const wikiStore = new WikiArtifactStore(input.db);
  wikiStore.ensureSchema();

  const preview = buildConnectorEventIngressPreview({
    rawAdapter: input.db,
    operatorDb: input.db,
    connector: SYNTHETIC_DOGFOOD_CONNECTOR,
    channel: SYNTHETIC_DOGFOOD_CHANNEL,
    limit: 10,
  });
  const dryRun = buildConnectorIngressMigrationDryRun({
    rawAdapter: input.db,
    operatorDb: input.db,
    connector: SYNTHETIC_DOGFOOD_CONNECTOR,
    channel: SYNTHETIC_DOGFOOD_CHANNEL,
    limit: 10,
  });
  const dryRunWriteCounts = readWriteCounts(input.db);

  const noUpdate = await commitConnectorIngressNoUpdateBatch({
    rawAdapter: input.db,
    operatorDb: input.db,
    connector: SYNTHETIC_DOGFOOD_CONNECTOR,
    channel: SYNTHETIC_DOGFOOD_CHANNEL,
    expectedAdvancedThroughSeq: 0,
    eventIndexIds: [noUpdateEvent.eventIndexId],
    nowMs,
  });

  const wikiPublishAdapter = createWikiPublishAdapter({
    mode: 'vnext',
    store: wikiStore,
    now: () => new Date(nowMs()),
    nowMs,
  });
  const wiki = await commitConnectorIngressWikiBatch({
    rawAdapter: input.db,
    operatorDb: input.db,
    wikiPublishAdapter,
    connector: SYNTHETIC_DOGFOOD_CONNECTOR,
    channel: SYNTHETIC_DOGFOOD_CHANNEL,
    expectedAdvancedThroughSeq: noUpdateSeq,
    eventPages: [
      {
        eventIndexId: wikiEvent.eventIndexId,
        pages: [
          {
            path: 'synthetic/vnext-dogfood.md',
            title: 'Synthetic vNext Dogfood',
            type: 'entity',
            content: 'Operator-authored synthetic wiki projection summary.',
            confidence: 'high',
          },
        ],
      },
    ],
    nowMs,
  });

  const memoryStore = input.memoryStore ?? createSyntheticDogfoodMemoryStore();
  const memoryInput = buildMemoryCommitInput(input.db, memoryEvent, wikiSeq, memoryStore, nowMs);
  const memory = await commitConnectorIngressMemoryBatch(memoryInput);
  const memoryReplay = await commitConnectorIngressMemoryBatch(memoryInput);
  const memoryWasReplayOnly =
    memory.memoriesSaved === 0 &&
    memory.commits.some((commit) => commit.outcome === 'already_committed');
  if (memoryWasReplayOnly) {
    await ensureReplayHasRetrievableMemory({
      memoryStore,
    });
  }

  const projection = buildSituationProjection(
    [
      {
        situationId: 'synthetic_dogfood_memory_follow_up',
        situationVersion: 1,
        awarenessRunId: 'synthetic_dogfood_run',
        title: 'Synthetic memory follow-up is committed',
        status: 'done',
        summary: 'The synthetic reviewed memory event reached an operator-approved projection.',
        nextAction: 'Use explicit recall when the next synthetic turn asks for this memory.',
        freshness: 'live',
        verificationState: 'verified',
        confidence: 0.92,
        evidenceRefs: [sourceRefFor(memoryEvent)],
        updatedAtMs: nowMs(),
        viewModelHash: `synthetic-dogfood-${memoryEvent.eventIndexId}`,
        priority: 1,
        tags: ['synthetic', 'dogfood'],
        ownerHint: 'operator',
      },
    ],
    nowMs()
  );

  const recallExecutor = new GatewayToolExecutor({
    mamaApi: createSyntheticMamaApi(memoryStore),
    envelopeIssuanceMode: 'off',
  });
  const recallExecutionContext = createSyntheticRecallExecutionContext();
  const ordinary = await executeSyntheticOrdinaryRouterTurn({
    db: input.db,
    memoryStore,
  });
  const negativeExplicit = await executeSyntheticExplicitRecall({
    executor: recallExecutor,
    query: 'unrelated synthetic topic',
    scopes: [SYNTHETIC_CHANNEL_SCOPE],
    executionContext: recallExecutionContext,
  });
  const explicit = await executeSyntheticExplicitRecall({
    executor: recallExecutor,
    query: SYNTHETIC_MEMORY_TOPIC,
    scopes: [SYNTHETIC_CHANNEL_SCOPE],
    executionContext: recallExecutionContext,
  });
  const repoDbArtifactsAfter = snapshotRepoDbArtifacts(artifactRoot);
  const repoDbArtifactsChanged = listChangedRepoDbArtifacts(
    repoDbArtifactsBefore,
    repoDbArtifactsAfter
  );
  if (repoDbArtifactsChanged.length > 0) {
    throw new Error(
      `Synthetic dogfood created or modified repository DB artifacts: ${repoDbArtifactsChanged.join(', ')}`
    );
  }

  return {
    scenario: {
      synthetic: true,
      connector: SYNTHETIC_DOGFOOD_CONNECTOR,
      channel: SYNTHETIC_DOGFOOD_CHANNEL,
    },
    events,
    preview,
    dryRun,
    dryRunWriteCounts,
    commits: {
      noUpdate,
      wiki,
      memory,
    },
    replay: {
      memory: memoryReplay,
    },
    projection,
    recall: {
      ordinary,
      negativeExplicit,
      explicit,
      totalRecallCalls: memoryStore.getTotalRecallCalls(),
    },
    artifacts: {
      repoDbFilesCreated: repoDbArtifactsChanged,
    },
  };
}
