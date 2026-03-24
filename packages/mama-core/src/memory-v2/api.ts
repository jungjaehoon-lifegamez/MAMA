import crypto from 'node:crypto';
import {
  initDB,
  getAdapter,
  insertDecisionWithEmbedding,
  ensureMemoryScope,
  bindMemoryToScope,
  listScopesForMemory,
} from '../db-manager.js';
import { classifyProfileEntries } from './profile-builder.js';
import { resolveMemoryEvolution } from './evolution-engine.js';
import { createEmptyRecallBundle } from './types.js';
import type {
  MemoryKind,
  MemoryRecord,
  MemoryScopeKind,
  MemoryScopeRef,
  MemoryStatus,
  ProfileSnapshot,
  RecallBundle,
} from './types.js';

interface SaveMemoryInput {
  topic: string;
  kind: MemoryKind;
  summary: string;
  details: string;
  confidence?: number;
  status?: MemoryStatus;
  scopes: MemoryScopeRef[];
  source: {
    package: 'mama-core' | 'mcp-server' | 'standalone' | 'claude-code-plugin';
    source_type: string;
    user_id?: string;
    channel_id?: string;
    project_id?: string;
  };
}

interface RecallMemoryOptions {
  scopes?: MemoryScopeRef[];
  includeProfile?: boolean;
}

interface IngestMemoryInput {
  content: string;
  scopes?: MemoryScopeRef[];
  source: SaveMemoryInput['source'];
}

function buildDecisionId(topic: string): string {
  const safeTopic = topic.replace(/[^a-z0-9_]+/gi, '_').toLowerCase();
  return `decision_${safeTopic}_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`;
}

function toMemoryRecord(
  row: Record<string, unknown>,
  scopes: MemoryScopeRef[],
  fallbackSource: SaveMemoryInput['source']
): MemoryRecord {
  const trustContext = typeof row.trust_context === 'string' ? JSON.parse(row.trust_context) : null;
  const savedSource = trustContext?.source;

  return {
    id: String(row.id),
    topic: String(row.topic),
    kind: (row.kind as MemoryKind) ?? 'decision',
    summary: String(row.summary ?? row.decision ?? ''),
    details: String(row.reasoning ?? row.decision ?? ''),
    confidence: Number(row.confidence ?? 0.5),
    status: (row.status as MemoryStatus) ?? 'active',
    scopes,
    source: savedSource ?? fallbackSource,
    created_at: row.created_at as number | string,
    updated_at: (row.updated_at as number | string) ?? (row.created_at as number | string),
  };
}

function toScopeRefs(scopes: Array<{ kind: string; id: string }>): MemoryScopeRef[] {
  return scopes.map((scope) => ({
    kind: scope.kind as MemoryScopeKind,
    id: scope.id,
  }));
}

async function loadScopedMemories(scopes: MemoryScopeRef[]): Promise<MemoryRecord[]> {
  await initDB();
  const adapter = getAdapter();

  if (scopes.length === 0) {
    const rows = adapter
      .prepare(
        `
          SELECT id, topic, decision, reasoning, confidence, created_at, updated_at, trust_context,
                 kind, status, summary
          FROM decisions
          ORDER BY created_at DESC
        `
      )
      .all() as Record<string, unknown>[];

    return Promise.all(
      rows.map(async (row) =>
        toMemoryRecord(row, toScopeRefs(await listScopesForMemory(String(row.id))), {
          package: 'mama-core',
          source_type: 'db',
        })
      )
    );
  }

  const scopeIds = await Promise.all(
    scopes.map((scope) => ensureMemoryScope(scope.kind, scope.id))
  );
  const placeholders = scopeIds.map(() => '?').join(', ');
  const rows = adapter
    .prepare(
      `
        SELECT DISTINCT d.id, d.topic, d.decision, d.reasoning, d.confidence, d.created_at,
               d.updated_at, d.trust_context, d.kind, d.status, d.summary
        FROM decisions d
        JOIN memory_scope_bindings msb ON msb.memory_id = d.id
        WHERE msb.scope_id IN (${placeholders})
        ORDER BY d.created_at DESC
      `
    )
    .all(...scopeIds) as Record<string, unknown>[];

  return Promise.all(
    rows.map(async (row) =>
      toMemoryRecord(row, toScopeRefs(await listScopesForMemory(String(row.id))), {
        package: 'mama-core',
        source_type: 'db',
      })
    )
  );
}

export async function saveMemory(
  input: SaveMemoryInput
): Promise<{ success: boolean; id: string }> {
  await initDB();
  const adapter = getAdapter();

  const id = buildDecisionId(input.topic);
  const now = Date.now();
  const evolution = resolveMemoryEvolution({
    incoming: { topic: input.topic, summary: input.summary },
    existing: adapter
      .prepare(
        `
          SELECT id, topic, summary
          FROM decisions
          WHERE topic = ?
          ORDER BY created_at DESC
          LIMIT 5
        `
      )
      .all(input.topic) as Array<{ id: string; topic: string; summary: string }>,
  });
  const supersedesTarget =
    evolution.edges.find((edge) => edge.type === 'supersedes')?.to_id ?? null;

  await insertDecisionWithEmbedding({
    id,
    topic: input.topic,
    decision: input.summary,
    reasoning: input.details,
    confidence: input.confidence ?? 0.5,
    supersedes: supersedesTarget,
    created_at: now,
    updated_at: now,
    trust_context: JSON.stringify({ source: input.source }),
  });

  adapter
    .prepare(
      `
        UPDATE decisions
        SET kind = ?, status = ?, summary = ?, is_static = ?, trust_context = ?, updated_at = ?
        WHERE id = ?
      `
    )
    .run(
      input.kind,
      input.status ?? 'active',
      input.summary,
      input.kind === 'preference' || input.kind === 'constraint' ? 1 : 0,
      JSON.stringify({ source: input.source }),
      now,
      id
    );

  for (const [index, scope] of input.scopes.entries()) {
    const scopeId = await ensureMemoryScope(scope.kind, scope.id);
    await bindMemoryToScope(id, scopeId, index === 0);
  }

  for (const edge of evolution.edges) {
    if (edge.type === 'supersedes') {
      adapter
        .prepare(
          `UPDATE decisions SET superseded_by = ?, status = 'superseded', updated_at = ? WHERE id = ?`
        )
        .run(id, now, edge.to_id);
    }

    adapter
      .prepare(
        `
          INSERT OR REPLACE INTO decision_edges (from_id, to_id, relationship, reason, weight, created_at)
          VALUES (?, ?, ?, ?, ?, ?)
        `
      )
      .run(id, edge.to_id, edge.type, edge.reason ?? null, 1.0, now);
  }

  return { success: true, id };
}

export async function buildProfile(scopes: MemoryScopeRef[]): Promise<ProfileSnapshot> {
  const records = await loadScopedMemories(scopes);
  return classifyProfileEntries(records);
}

export async function recallMemory(
  query: string,
  options: RecallMemoryOptions = {}
): Promise<RecallBundle> {
  const bundle = createEmptyRecallBundle(query);
  const records = await loadScopedMemories(options.scopes ?? []);
  const tokens = query
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter((token) => token.length > 2);
  const matched = records.filter((record) => {
    const haystack = [record.topic, record.summary, record.details].join(' ').toLowerCase();
    return tokens.length === 0
      ? haystack.includes(query.toLowerCase())
      : tokens.some((token) => haystack.includes(token));
  });

  bundle.memories = matched;
  bundle.graph_context.primary = matched;
  bundle.graph_context.expanded = [];
  bundle.graph_context.edges = [];
  bundle.search_meta.scope_order = (options.scopes ?? []).map((scope) => scope.kind);
  bundle.search_meta.retrieval_sources = ['sql_like'];

  if (options.includeProfile) {
    bundle.profile = await buildProfile(options.scopes ?? []);
  }

  return bundle;
}

export async function ingestMemory(
  input: IngestMemoryInput
): Promise<{ success: boolean; id: string }> {
  const normalized = input.content.trim();
  return saveMemory({
    topic:
      normalized
        .slice(0, 40)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '') || 'ingested_memory',
    kind: 'fact',
    summary: normalized.slice(0, 200),
    details: normalized,
    scopes: input.scopes ?? [],
    source: input.source,
  });
}

export async function evolveMemory(input: Parameters<typeof resolveMemoryEvolution>[0]) {
  return resolveMemoryEvolution(input);
}
