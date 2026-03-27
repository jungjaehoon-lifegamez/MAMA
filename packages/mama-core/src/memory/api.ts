import crypto from 'node:crypto';
import {
  initDB,
  getAdapter,
  insertDecisionWithEmbedding,
  ensureMemoryScope,
  vectorSearch,
} from '../db-manager.js';
import { generateEmbedding } from '../embeddings.js';
import { classifyProfileEntries } from './profile-builder.js';
import { buildMemoryAgentBootstrap } from './bootstrap-builder.js';
import { resolveMemoryEvolution } from './evolution-engine.js';
import { recordChannelAudit } from './channel-summary-state-store.js';
import { warn } from '../debug-logger.js';
import { projectMemoryTruth, queryRelevantTruth } from './truth-store.js';
import { buildExtractionPrompt, parseExtractionResponse } from './extraction-prompt.js';
import { createEmptyRecallBundle, createMemoryAuditAck } from './types.js';
import { getChannelSummary, upsertChannelSummary } from './channel-summary-store.js';
import type {
  MemoryKind,
  MemoryAgentBootstrap,
  MemoryAuditAck,
  MemoryRecord,
  MemoryScopeKind,
  MemoryScopeRef,
  MemoryStatus,
  MemoryTruthRow,
  ProfileSnapshot,
  RecallBundle,
  IngestConversationInput,
  ExtractedMemoryUnit,
  IngestConversationResult,
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
  includeHistory?: boolean;
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
  let trustContext = null;
  if (typeof row.trust_context === 'string') {
    try {
      trustContext = JSON.parse(row.trust_context);
    } catch {
      /* malformed */
    }
  }
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

function truthRowToMemoryRecord(row: MemoryTruthRow): MemoryRecord {
  return {
    id: row.memory_id,
    topic: row.topic,
    kind: row.kind ?? 'decision',
    summary: row.effective_summary,
    details: row.effective_details,
    confidence: row.trust_score,
    status: row.truth_status === 'quarantined' ? 'stale' : row.truth_status,
    scopes: row.scope_refs,
    source: {
      package: 'mama-core',
      source_type: 'truth_projection',
    },
    created_at: row.created_at ?? Date.now(),
    updated_at: row.updated_at ?? row.created_at ?? Date.now(),
  };
}

function batchLoadScopes(
  adapter: ReturnType<typeof getAdapter>,
  memoryIds: string[]
): Map<string, MemoryScopeRef[]> {
  const scopeMap = new Map<string, MemoryScopeRef[]>();
  if (memoryIds.length === 0) return scopeMap;

  const placeholders = memoryIds.map(() => '?').join(', ');
  const rows = adapter
    .prepare(
      `
        SELECT msb.memory_id, ms.kind, ms.external_id
        FROM memory_scope_bindings msb
        JOIN memory_scopes ms ON ms.id = msb.scope_id
        WHERE msb.memory_id IN (${placeholders})
        ORDER BY msb.is_primary DESC
      `
    )
    .all(...memoryIds) as Array<{ memory_id: string; kind: string; external_id: string }>;

  for (const row of rows) {
    const existing = scopeMap.get(row.memory_id) ?? [];
    existing.push({ kind: row.kind as MemoryScopeKind, id: row.external_id });
    scopeMap.set(row.memory_id, existing);
  }
  return scopeMap;
}

async function loadScopedMemories(scopes: MemoryScopeRef[]): Promise<MemoryRecord[]> {
  await initDB();
  const adapter = getAdapter();
  const fallbackSource: SaveMemoryInput['source'] = { package: 'mama-core', source_type: 'db' };

  let rows: Record<string, unknown>[];

  if (scopes.length === 0) {
    rows = adapter
      .prepare(
        `
          SELECT id, topic, decision, reasoning, confidence, created_at, updated_at, trust_context,
                 kind, status, summary
          FROM decisions
          ORDER BY created_at DESC
        `
      )
      .all() as Record<string, unknown>[];
  } else {
    const scopeIds = await Promise.all(
      scopes.map((scope) => ensureMemoryScope(scope.kind, scope.id))
    );
    const placeholders = scopeIds.map(() => '?').join(', ');
    rows = adapter
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
  }

  const memoryIds = rows.map((row) => String(row.id));
  const scopeMap = batchLoadScopes(adapter, memoryIds);

  return rows.map((row) => toMemoryRecord(row, scopeMap.get(String(row.id)) ?? [], fallbackSource));
}

export async function saveMemory(
  input: SaveMemoryInput
): Promise<{ success: boolean; id: string }> {
  await initDB();
  const adapter = getAdapter();

  const id = buildDecisionId(input.topic);
  const now = Date.now();
  // Filter evolution candidates by primary scope to prevent cross-scope superseding
  const primaryScope = input.scopes.length > 0 ? input.scopes[0] : null;
  let existingCandidates: Array<{ id: string; topic: string; summary: string }>;
  if (primaryScope) {
    const scopeId = await ensureMemoryScope(primaryScope.kind, primaryScope.id);
    existingCandidates = adapter
      .prepare(
        `
          SELECT d.id, d.topic, d.summary
          FROM decisions d
          JOIN memory_scope_bindings msb ON msb.memory_id = d.id
          WHERE d.topic = ? AND msb.scope_id = ?
            AND (d.status = 'active' OR d.status IS NULL)
            AND d.superseded_by IS NULL
          ORDER BY d.created_at DESC
          LIMIT 5
        `
      )
      .all(input.topic, scopeId) as Array<{ id: string; topic: string; summary: string }>;
  } else {
    existingCandidates = adapter
      .prepare(
        `
          SELECT id, topic, summary
          FROM decisions
          WHERE topic = ?
            AND (status = 'active' OR status IS NULL)
            AND superseded_by IS NULL
          ORDER BY created_at DESC
          LIMIT 5
        `
      )
      .all(input.topic) as Array<{ id: string; topic: string; summary: string }>;
  }
  const evolution = resolveMemoryEvolution({
    incoming: { topic: input.topic, summary: input.summary },
    existing: existingCandidates,
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

  // Pre-resolve scope IDs before the synchronous transaction
  const resolvedScopeIds: Array<{ scopeId: string; isPrimary: boolean }> = [];
  for (const [index, scope] of input.scopes.entries()) {
    const scopeId = await ensureMemoryScope(scope.kind, scope.id);
    resolvedScopeIds.push({ scopeId, isPrimary: index === 0 });
  }

  // Wrap all post-insert mutations in a transaction for atomicity
  adapter.transaction(() => {
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

    for (const { scopeId, isPrimary } of resolvedScopeIds) {
      adapter
        .prepare(
          `
            INSERT OR REPLACE INTO memory_scope_bindings (memory_id, scope_id, is_primary)
            VALUES (?, ?, ?)
          `
        )
        .run(id, scopeId, isPrimary ? 1 : 0);
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
  });

  // Project to memory_truth table (best-effort; failure should not break save)
  try {
    await projectMemoryTruth({
      memory_id: id,
      topic: input.topic,
      truth_status: (input.status ?? 'active') as MemoryTruthRow['truth_status'],
      effective_summary: input.summary,
      effective_details: input.details,
      trust_score: input.confidence ?? 0.5,
      scope_refs: input.scopes,
      supporting_event_ids: [],
      superseded_by: undefined,
    });
  } catch {
    // Truth projection is best-effort; do not fail the save
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
  const truthRows = await queryRelevantTruth({
    query,
    scopes: options.scopes ?? [],
    includeHistory: options.includeHistory === true,
  });
  let matched = truthRows.map(truthRowToMemoryRecord);

  // Fallback: embedding-based vector search (multilingual, works with Korean)
  if (matched.length === 0) {
    try {
      await initDB();
      const queryEmbedding = await generateEmbedding(query);
      const vectorResults = await vectorSearch(queryEmbedding, 10, 0.5);
      const EXCLUDED_STATUSES: Set<string> = new Set([
        'superseded',
        'quarantined',
        'contradicted',
        'stale',
      ]);

      // Filter vector results by scope if scopes are specified
      let filteredVectorResults = vectorResults;
      if (options.scopes && options.scopes.length > 0) {
        const vectorIds = vectorResults.map((r) => String(r.id));
        const scopeMap = batchLoadScopes(getAdapter(), vectorIds);
        const requestedScopes = new Set(options.scopes.map((s) => `${s.kind}:${s.id}`));
        filteredVectorResults = vectorResults.filter((r) => {
          const scopes = scopeMap.get(String(r.id)) ?? [];
          return scopes.some((s) => requestedScopes.has(`${s.kind}:${s.id}`));
        });
      }

      for (const result of filteredVectorResults as Array<
        (typeof vectorResults)[number] & { similarity?: number; status?: string }
      >) {
        const effectiveStatus = (result.status as string) || (result.outcome as string) || '';
        if (!options.includeHistory && effectiveStatus && EXCLUDED_STATUSES.has(effectiveStatus)) {
          continue;
        }
        matched.push({
          id: String(result.id),
          topic: String(result.topic || ''),
          kind: 'decision' as MemoryKind,
          summary: String(result.decision || ''),
          details: String(result.reasoning || ''),
          confidence: (result as { similarity?: number }).similarity ?? 0.5,
          status: (effectiveStatus as MemoryStatus) || 'active',
          scopes: [],
          source: { package: 'mama-core', source_type: 'vector_search' },
          created_at: result.created_at ?? Date.now(),
          updated_at: result.created_at ?? Date.now(),
        });
      }
    } catch {
      // Vector search unavailable — fall through to text search
    }
  }

  // Final fallback: text token matching
  if (matched.length === 0) {
    const records = await loadScopedMemories(options.scopes ?? []);
    const tokens = query
      .toLowerCase()
      .split(/[\s,.!?;:()[\]{}"']+/)
      .filter((token) => token.length > 1);
    const EXCLUDED_STATUSES: Set<string> = new Set([
      'superseded',
      'quarantined',
      'contradicted',
      'stale',
    ]);
    matched = records.filter((record) => {
      if (!options.includeHistory && EXCLUDED_STATUSES.has(record.status)) {
        return false;
      }
      const haystack = [record.topic, record.summary, record.details].join(' ').toLowerCase();
      return tokens.length === 0
        ? haystack.includes(query.toLowerCase())
        : tokens.some((token) => haystack.includes(token));
    });
  }

  bundle.memories = matched;
  bundle.graph_context.primary = matched;
  bundle.graph_context.expanded = [];
  bundle.graph_context.edges = [];
  bundle.search_meta.scope_order = (options.scopes ?? []).map((scope) => scope.kind);
  bundle.search_meta.retrieval_sources =
    truthRows.length > 0 ? ['truth_projection'] : matched.length > 0 ? ['vector_search'] : ['none'];

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

export async function buildMemoryBootstrap(params: {
  scopes: MemoryScopeRef[];
  channelKey?: string;
  currentGoal?: string;
  mainAgentState?: MemoryAgentBootstrap['main_agent_state'];
}): Promise<MemoryAgentBootstrap> {
  return buildMemoryAgentBootstrap(params);
}

export function createAuditAck(input: MemoryAuditAck): MemoryAuditAck {
  return createMemoryAuditAck(input);
}

export async function recordMemoryAudit(input: {
  channelKey: string;
  turnId: string;
  topic: string;
  scopeRefs: MemoryScopeRef[];
  ack: MemoryAuditAck;
  savedMemories?: Array<{ id: string; topic: string; summary: string }>;
}) {
  return recordChannelAudit(input);
}

async function callExtractionLLM(
  prompt: string,
  options: NonNullable<IngestConversationInput['extract']>
): Promise<ExtractedMemoryUnit[]> {
  const model = options.model ?? 'claude-sonnet-4-5-20250514';
  const apiKey = options.apiKey ?? process.env.ANTHROPIC_API_KEY;
  const baseUrl = options.baseUrl ?? 'https://api.anthropic.com';

  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY is required for extraction');
  }

  const res = await fetch(`${baseUrl}/v1/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: 4096,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (!res.ok) {
    const errorBody = await res.text().catch(() => 'unknown');
    throw new Error(`Anthropic API error ${res.status}: ${errorBody}`);
  }

  const data = (await res.json()) as {
    content?: Array<{ type: string; text?: string }>;
  };
  const text = data.content?.find((c) => c.type === 'text')?.text ?? '';
  return parseExtractionResponse(text);
}

let extractionFn: typeof callExtractionLLM = callExtractionLLM;
export function setExtractionFn(fn: typeof callExtractionLLM | null): void {
  extractionFn = fn ?? callExtractionLLM;
}

export async function ingestConversation(
  input: IngestConversationInput
): Promise<IngestConversationResult> {
  if (!input.messages || input.messages.length === 0) {
    throw new Error('messages array must not be empty');
  }

  const conversationText = input.messages.map((m) => `${m.role}: ${m.content}`).join('\n');

  const rawResult = await ingestMemory({
    content: conversationText,
    scopes: input.scopes,
    source: input.source,
  });

  const result: IngestConversationResult = {
    rawId: rawResult.id,
    extractedMemories: [],
  };

  if (!input.extract?.enabled) {
    return result;
  }

  let units: ExtractedMemoryUnit[];
  try {
    const prompt = buildExtractionPrompt(input.messages);
    units = await extractionFn(prompt, input.extract);
  } catch (err) {
    warn(`[memory] extraction failed: ${err instanceof Error ? err.message : String(err)}`);
    return result;
  }

  const adapter = getAdapter();
  const EXTRACTION_EDGE_RELATIONSHIP = 'builds_on';
  const EXTRACTION_EDGE_REASON = 'Extracted from conversation';

  for (const unit of units) {
    try {
      const saved = await saveMemory({
        topic: unit.topic,
        kind: unit.kind,
        summary: unit.summary,
        details: unit.details,
        confidence: unit.confidence,
        scopes: input.scopes,
        source: input.source,
      });

      const now = Date.now();
      adapter
        .prepare(
          `INSERT OR REPLACE INTO decision_edges (from_id, to_id, relationship, reason, weight, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run(
          saved.id,
          rawResult.id,
          EXTRACTION_EDGE_RELATIONSHIP,
          EXTRACTION_EDGE_REASON,
          1.0,
          now
        );

      result.extractedMemories.push({
        id: saved.id,
        kind: unit.kind,
        topic: unit.topic,
      });
    } catch (err) {
      warn(
        `[memory] failed to save extracted unit topic=${unit.topic} kind=${unit.kind}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  return result;
}

export { upsertChannelSummary, getChannelSummary };
