/**
 * Knowledge graph queries: how a topic got to where it is, and what else it
 * argues with. Two surfaces live here: the decision-chain graph (supersedes /
 * decision_edges) and the twin-edge graph (neighborhood, paths, timeline over
 * `twin_edges`).
 *
 * Every function takes the adapter it reads through, so a caller cannot walk a
 * graph in a database it did not open.
 *
 * @module knowledge/graph-query
 */

import type {
  DatabaseAdapter,
  DecisionEdgeRow,
  DecisionRecord,
  SemanticEdgeItem,
  SemanticEdges,
} from '../db-manager.js';
import {
  assertTwinRefsVisible,
  listVisibleTwinEdgesForRefs,
  TwinRefNotVisibleError,
  visibleTwinRefKeysRecursive,
} from '../knowledge/access.js';
import {
  getTwinEdge,
  listTwinEdgesForRefs,
  JudgmentError,
  type JudgmentAccess,
} from './judgments.js';
import { getObservationVersion } from './observations.js';
import { expandCaseChainForAssembly, resolveCanonicalCaseChain } from './case-store.js';
import {
  currentIdentityRevision,
  listNodes,
  resolveAliasCandidates,
  resolveNodeById,
} from '../registry/store.js';
import type { RegistryNode } from '../registry/types.js';
import type {
  JsonValue,
  WorkGraphNodeData,
  WorkGraphPage,
  WorkGraphQuery,
  WorkReference,
} from '../memory/judgment-types.js';
import { TWIN_EDGE_TYPES } from '../knowledge/twin-edge-types.js';
import type {
  TwinEdgeRecord,
  TwinEdgeType,
  TwinProjectRef,
  TwinRef,
  TwinScopeRef,
  TwinVisibility,
} from '../knowledge/twin-edge-types.js';

/**
 * `refined_from` is stored as a JSON array of decision ids.
 *
 * Both branches of queryDecisionGraph used to answer a parse failure with an
 * empty array, which reads downstream as "this decision refines nothing" - the
 * same sentence a decision with no ancestry produces. Corruption is not
 * ancestry, so it is reported instead. The stored value is left alone.
 */
function parseRefinedFrom(decision: {
  id: string;
  refined_from?: string | string[] | null;
}): string | string[] | null | undefined {
  if (!decision.refined_from || typeof decision.refined_from !== 'string') {
    return decision.refined_from;
  }
  try {
    return JSON.parse(decision.refined_from);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`decision ${decision.id} has unreadable refined_from: ${message}`);
  }
}

/**
 * Walk a topic's supersedes chain with a recursive CTE.
 *
 * @param adapter - Database to read through
 * @param topic - Decision topic to query
 * @param anchorId - Start from this decision instead of the topic's current head
 * @returns Decisions ordered by recency, each carrying its approved edges
 */
export async function queryDecisionGraph(
  adapter: DatabaseAdapter,
  topic: string,
  anchorId?: string
): Promise<DecisionRecord[]> {
  try {
    if (!anchorId) {
      const decisions = adapter
        .prepare(
          `
          WITH RECURSIVE decision_chain AS (
            SELECT * FROM decisions WHERE topic = ? AND superseded_by IS NULL
            UNION
            SELECT d.* FROM decisions d
            JOIN decision_chain dc ON d.id = dc.supersedes
          )
          SELECT * FROM decision_chain ORDER BY created_at DESC, id DESC
        `
        )
        .all(topic) as DecisionRecord[];
      const edgesStmt = adapter.prepare(`
        SELECT * FROM decision_edges
        WHERE from_id = ?
          AND (approved_by_user = 1 OR approved_by_user IS NULL)
      `);
      for (const decision of decisions) {
        decision.edges = edgesStmt.all(decision.id) as DecisionEdgeRow[];
        decision.refined_from = parseRefinedFrom(decision);
      }
      return decisions;
    }
    const stmt = adapter.prepare(`
      WITH RECURSIVE decision_chain AS (
        SELECT * FROM (
          SELECT * FROM decisions
          WHERE id = ?
          ORDER BY created_at DESC, id DESC
          LIMIT 1
        )

        UNION ALL

        -- Recursive case: Get previous decisions
        SELECT d.* FROM decisions d
        JOIN decision_chain dc ON d.id = dc.supersedes
      )
      SELECT * FROM decision_chain
      ORDER BY created_at DESC
    `);
    const decisions = stmt.all(anchorId) as DecisionRecord[];

    // Join with decision_edges to include relationships
    // Prepare statement once outside loop for performance
    const edgesStmt = adapter.prepare(`
      SELECT * FROM decision_edges
      WHERE from_id = ?
        AND (approved_by_user = 1 OR approved_by_user IS NULL)
    `);
    for (const decision of decisions) {
      decision.edges = edgesStmt.all(decision.id) as DecisionEdgeRow[];

      decision.refined_from = parseRefinedFrom(decision);
    }

    return decisions;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Decision graph query failed: ${message}`);
  }
}

/**
 * Outgoing and incoming semantic edges for a set of decisions.
 *
 * @param adapter - Database to read through
 * @param decisionIds - Decision IDs to query edges for
 * @returns Edges categorized by relationship and direction
 */
export async function querySemanticEdges(
  adapter: DatabaseAdapter,
  decisionIds: string[]
): Promise<SemanticEdges> {
  if (!decisionIds || decisionIds.length === 0) {
    return {
      refines: [],
      refined_by: [],
      contradicts: [],
      contradicted_by: [],
      // Story 2.1: Extended edge types
      builds_on: [],
      built_on_by: [],
      debates: [],
      debated_by: [],
      synthesizes: [],
      synthesized_by: [],
    };
  }

  try {
    // Build placeholders for IN clause
    const placeholders = decisionIds.map(() => '?').join(',');

    // Story 2.1: Include new edge types in query
    const edgeTypes = ['refines', 'contradicts', 'builds_on', 'debates', 'synthesizes'];
    const edgeTypePlaceholders = edgeTypes.map(() => '?').join(',');

    // Query outgoing edges (from_id = decision)
    const outgoingStmt = adapter.prepare(`
      SELECT e.*, d.topic, d.decision, d.confidence, d.created_at
      FROM decision_edges e
      JOIN decisions d ON e.to_id = d.id
      WHERE e.from_id IN (${placeholders})
        AND e.relationship IN (${edgeTypePlaceholders})
        AND (e.approved_by_user = 1 OR e.approved_by_user IS NULL)
      ORDER BY e.created_at DESC
    `);
    const outgoingEdges = outgoingStmt.all(...decisionIds, ...edgeTypes) as SemanticEdgeItem[];

    // Query incoming edges (to_id = decision)
    const incomingStmt = adapter.prepare(`
      SELECT e.*, d.topic, d.decision, d.confidence, d.created_at
      FROM decision_edges e
      JOIN decisions d ON e.from_id = d.id
      WHERE e.to_id IN (${placeholders})
        AND e.relationship IN (${edgeTypePlaceholders})
        AND (e.approved_by_user = 1 OR e.approved_by_user IS NULL)
      ORDER BY e.created_at DESC
    `);
    const incomingEdges = incomingStmt.all(...decisionIds, ...edgeTypes) as SemanticEdgeItem[];

    // Categorize edges (original + v1.3 extended)
    const refines = outgoingEdges.filter((e) => e.relationship === 'refines');
    const refined_by = incomingEdges.filter((e) => e.relationship === 'refines');
    const contradicts = outgoingEdges.filter((e) => e.relationship === 'contradicts');
    const contradicted_by = incomingEdges.filter((e) => e.relationship === 'contradicts');
    // Story 2.1: New edge type categories
    const builds_on = outgoingEdges.filter((e) => e.relationship === 'builds_on');
    const built_on_by = incomingEdges.filter((e) => e.relationship === 'builds_on');
    const debates = outgoingEdges.filter((e) => e.relationship === 'debates');
    const debated_by = incomingEdges.filter((e) => e.relationship === 'debates');
    const synthesizes = outgoingEdges.filter((e) => e.relationship === 'synthesizes');
    const synthesized_by = incomingEdges.filter((e) => e.relationship === 'synthesizes');

    return {
      refines,
      refined_by,
      contradicts,
      contradicted_by,
      builds_on,
      built_on_by,
      debates,
      debated_by,
      synthesizes,
      synthesized_by,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Semantic edges query failed: ${message}`);
  }
}

// ── Twin-edge graph ────────────────────────────────────────────────────────────

export class AgentGraphValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentGraphValidationError';
  }
}

export type AgentGraphAdapter = Pick<DatabaseAdapter, 'prepare' | 'transaction'>;

export interface AgentGraphEdgeFilters {
  edge_types?: TwinEdgeType[];
}

export interface GraphNeighborhoodInput {
  ref: TwinRef;
  depth?: number;
  /**
   * Which edge orientation, seen from the expanding frontier, belongs to the walk.
   * 'out' follows edges whose subject is on the frontier, 'in' whose object is, and
   * 'both' either — the absence of a direction means the undirected neighborhood.
   */
  direction?: 'in' | 'out' | 'both';
  /**
   * 'all' reads replaced records as history; absent or 'current' reads only
   * what currently stands. Authority checks apply in both modes.
   */
  history?: 'current' | 'all';
  scopes?: TwinScopeRef[];
  connectors?: string[];
  connector_wide_read?: string[];
  project_refs?: TwinProjectRef[];
  /**
   * Which channels of each connector may be read. Carried on every graph input for the
   * same reason it is carried on the reader's boundary: a raw ref reached through an edge
   * must satisfy the same rule as a row the reader would have returned.
   */
  channels?: Record<string, readonly string[]>;
  tenant_id?: string | null;
  principal_id?: string;
  agent_id?: string;
  edge_filters?: AgentGraphEdgeFilters;
  as_of_ms?: number | null;
  limit?: number;
}

export interface AgentGraphResult {
  nodes: TwinRef[];
  edges: TwinEdgeRecord[];
  current_projection: AgentGraphCurrentProjection[];
}

export interface AgentGraphCurrentProjection {
  edge_id: string;
  endpoint: 'from' | 'to';
  original_ref: TwinRef;
  current_ref: TwinRef | null;
}

export interface GraphPathsInput {
  from_ref: TwinRef;
  to_ref: TwinRef;
  max_depth?: number;
  /** 'all' reads replaced records as history; 'current' is the default. */
  history?: 'current' | 'all';
  scopes?: TwinScopeRef[];
  connectors?: string[];
  connector_wide_read?: string[];
  project_refs?: TwinProjectRef[];
  /**
   * Which channels of each connector may be read. Carried on every graph input for the
   * same reason it is carried on the reader's boundary: a raw ref reached through an edge
   * must satisfy the same rule as a row the reader would have returned.
   */
  channels?: Record<string, readonly string[]>;
  tenant_id?: string | null;
  principal_id?: string;
  agent_id?: string;
  edge_filters?: AgentGraphEdgeFilters;
  as_of_ms?: number | null;
  limit?: number;
}

export interface AgentGraphPath {
  refs: TwinRef[];
  edges: TwinEdgeRecord[];
}

export interface GraphPathsResult {
  paths: AgentGraphPath[];
  limit_reached: boolean;
  current_projection: AgentGraphCurrentProjection[];
}

export interface GraphTimelineInput {
  ref: TwinRef;
  /** 'all' reads replaced records as history; 'current' is the default. */
  history?: 'current' | 'all';
  scopes?: TwinScopeRef[];
  connectors?: string[];
  connector_wide_read?: string[];
  project_refs?: TwinProjectRef[];
  /**
   * Which channels of each connector may be read. Carried on every graph input for the
   * same reason it is carried on the reader's boundary: a raw ref reached through an edge
   * must satisfy the same rule as a row the reader would have returned.
   */
  channels?: Record<string, readonly string[]>;
  tenant_id?: string | null;
  principal_id?: string;
  agent_id?: string;
  edge_filters?: AgentGraphEdgeFilters;
  from_ms?: number;
  to_ms?: number;
  recorded_from_ms?: number;
  recorded_to_ms?: number;
  as_of_ms?: number | null;
  limit?: number;
}

export interface AgentGraphTimelineMemoryEvent {
  kind: 'memory';
  at_ms: number;
  ref: Extract<TwinRef, { kind: 'memory' }>;
  memory: {
    id: string;
    topic: string | null;
    decision: string | null;
    created_at: number;
    event_datetime: number | null;
  };
}

export interface AgentGraphTimelineCaseEvent {
  kind: 'case';
  at_ms: number;
  ref: Extract<TwinRef, { kind: 'case' }>;
  case: {
    case_id: string;
    title: string;
    status: string;
    created_at: string | number;
    updated_at: string | number;
    last_activity_at: string | null;
  };
}

export interface AgentGraphTimelineRawEvent {
  kind: 'raw';
  at_ms: number;
  ref: Extract<TwinRef, { kind: 'raw' }>;
  raw: {
    event_index_id: string;
    source_connector: string;
    source_type: string;
    source_id: string;
    source_locator: string | null;
    title: string | null;
    event_datetime: number | null;
    source_timestamp_ms: number;
    observation_ref: string | null;
  };
}

export interface AgentGraphTimelineEdgeEvent {
  kind: 'edge';
  at_ms: number;
  edge: TwinEdgeRecord;
}

export type AgentGraphTimelineEvent =
  | AgentGraphTimelineMemoryEvent
  | AgentGraphTimelineCaseEvent
  | AgentGraphTimelineRawEvent
  | AgentGraphTimelineEdgeEvent;

export interface GraphTimelineResult {
  ref: TwinRef;
  events: AgentGraphTimelineEvent[];
  has_more: boolean;
  current_projection: AgentGraphCurrentProjection[];
}

const DEFAULT_GRAPH_LIMIT = 100;
const DEFAULT_PATH_LIMIT = 10;
const MAX_DEPTH = 5;
// A path count cannot bound a dense graph with an unreachable target.
const MAX_PATH_FRONTIER = 1000;
const MAX_PATH_EDGE_WORK = 10000;

function refKey(ref: TwinRef): string {
  return `${ref.kind}:${ref.id}`;
}

function edgeKey(edge: TwinEdgeRecord): string {
  return edge.edge_id;
}

function eventKey(event: AgentGraphTimelineEvent): string {
  if (event.kind === 'edge') {
    return event.edge.edge_id;
  }
  return `${event.ref.kind}:${event.ref.id}`;
}

function eventKindRank(kind: AgentGraphTimelineEvent['kind']): number {
  if (kind === 'memory') {
    return 1;
  }
  if (kind === 'raw') {
    return 2;
  }
  if (kind === 'case') {
    return 3;
  }
  return 4;
}

function normalizeDepth(value: number | undefined, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(0, Math.min(MAX_DEPTH, Math.floor(value)));
}

function normalizeLimit(value: number | undefined, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(1, Math.floor(value));
}

function addNode(nodes: TwinRef[], seen: Set<string>, ref: TwinRef): void {
  const key = refKey(ref);
  if (!seen.has(key)) {
    seen.add(key);
    nodes.push(ref);
  }
}

function addRef(refs: TwinRef[], seen: Set<string>, ref: TwinRef): void {
  if (ref.kind === 'edge' || ref.kind === 'report') {
    return;
  }
  const key = refKey(ref);
  if (!seen.has(key)) {
    seen.add(key);
    refs.push(ref);
  }
}

function oppositeRef(edge: TwinEdgeRecord, current: TwinRef): TwinRef[] {
  const currentKey = refKey(current);
  const refs: TwinRef[] = [];
  if (refKey(edge.subject_ref) !== currentKey) {
    refs.push(edge.subject_ref);
  }
  if (refKey(edge.object_ref) !== currentKey) {
    refs.push(edge.object_ref);
  }
  if (refs.length === 0) {
    refs.push(edge.object_ref);
  }
  return refs;
}

function listFilteredEdges(
  adapter: AgentGraphAdapter,
  refs: readonly TwinRef[],
  input: {
    visibility: TwinVisibility;
    edge_filters?: AgentGraphEdgeFilters;
    as_of_ms?: number | null;
    limit?: number;
  }
): TwinEdgeRecord[] {
  // Spread, not a field-by-field re-listing. Re-listing is how the channel grant was
  // silently dropped here while every other path enforced it: a new field on the
  // visibility type simply never arrived, and nothing failed to say so.
  return listVisibleTwinEdgesForRefs(adapter, refs, {
    ...input.visibility,
    edgeTypes: input.edge_filters?.edge_types,
    asOfMs: input.as_of_ms,
    limit: input.limit,
  });
}

function assertRefsVisible(
  adapter: AgentGraphAdapter,
  refs: readonly TwinRef[],
  visibility: TwinVisibility,
  asOfMs?: number | null
): void {
  try {
    assertTwinRefsVisible(adapter, refs, { ...visibility, asOfMs });
  } catch (error) {
    // A visibility refusal is a denial, not a malformed query — keep its type
    // so callers can answer denied instead of invalid.
    if (error instanceof TwinRefNotVisibleError) {
      throw error;
    }
    throw new AgentGraphValidationError(error instanceof Error ? error.message : String(error));
  }
}

function graphVisibility(input: {
  scopes?: TwinVisibility['scopes'];
  connectors?: TwinVisibility['connectors'];
  connector_wide_read?: TwinVisibility['connectorWideRead'];
  project_refs?: TwinVisibility['projectRefs'];
  tenant_id?: TwinVisibility['tenantId'];
  channels?: TwinVisibility['channels'];
  history?: 'current' | 'all';
  principal_id?: string;
  agent_id?: string;
  max_source_ms?: number | null;
}): TwinVisibility {
  return {
    scopes: input.scopes,
    connectors: input.connectors,
    connectorWideRead: input.connector_wide_read,
    projectRefs: input.project_refs,
    tenantId: input.tenant_id,
    principalId: input.principal_id,
    agentId: input.agent_id,
    maxSourceMs: input.max_source_ms,
    includeReplaced: input.history === 'all',
    ...(input.channels ? { channels: input.channels } : {}),
  };
}

function projectCurrentEdges(
  adapter: AgentGraphAdapter,
  edges: readonly TwinEdgeRecord[],
  visibility: TwinVisibility
): AgentGraphCurrentProjection[] {
  if (edges.length === 0) {
    return [];
  }
  const edgeIds = [...new Set(edges.map((edge) => edge.edge_id))];
  const placeholders = edgeIds.map(() => '?').join(', ');
  const assignmentRows = adapter
    .prepare(
      `SELECT edge_id, endpoint, resolved_node_id
         FROM registry_ref_assignments assignment
        WHERE edge_id IN (${placeholders})
          AND committed_revision = (
            SELECT MAX(current_assignment.committed_revision)
              FROM registry_ref_assignments current_assignment
             WHERE current_assignment.edge_id = assignment.edge_id
               AND current_assignment.endpoint = assignment.endpoint
          )`
    )
    .all(...edgeIds) as Array<{
    edge_id: string;
    endpoint: 'from' | 'to';
    resolved_node_id: string | null;
  }>;
  const assignments = new Map(
    assignmentRows.map((row) => [
      `${row.edge_id}\0${row.endpoint}`,
      row.resolved_node_id === null
        ? null
        : ({ kind: 'registry', id: row.resolved_node_id } as TwinRef),
    ])
  );
  const projections = edges.flatMap((edge) =>
    (['from', 'to'] as const).map((endpoint) => {
      const original = endpoint === 'from' ? edge.subject_ref : edge.object_ref;
      const key = `${edge.edge_id}\0${endpoint}`;
      return {
        edge_id: edge.edge_id,
        endpoint,
        original_ref: original,
        current_ref: assignments.has(key) ? (assignments.get(key) ?? null) : original,
      };
    })
  );
  const registryIds = [
    ...new Set(
      projections
        .map((projection) => projection.current_ref)
        .filter((ref): ref is Extract<TwinRef, { kind: 'registry' }> => ref?.kind === 'registry')
        .map((ref) => ref.id)
    ),
  ];
  const resolvedRegistry = new Map<string, string | null>();
  if (registryIds.length > 0) {
    const registryPlaceholders = registryIds.map(() => '?').join(', ');
    const rows = adapter
      .prepare(
        `WITH RECURSIVE registry_chain(origin_id, id, merged_into, depth) AS (
           SELECT id, id, merged_into, 0 FROM registry_nodes WHERE id IN (${registryPlaceholders})
           UNION ALL
           SELECT chain.origin_id, node.id, node.merged_into, chain.depth + 1
             FROM registry_chain chain
             JOIN registry_nodes node ON node.id = chain.merged_into
            WHERE chain.depth < 100
         )
         SELECT origin_id, id, merged_into, depth FROM registry_chain ORDER BY origin_id, depth`
      )
      .all(...registryIds) as Array<{
      origin_id: string;
      id: string;
      merged_into: string | null;
      depth: number;
    }>;
    // The rows are ordered by origin and depth. Group their terminal row once:
    // filtering the whole result for every origin made a wide graph O(N²).
    const lastByOrigin = new Map<string, (typeof rows)[number]>();
    for (const row of rows) {
      lastByOrigin.set(row.origin_id, row);
    }
    for (const id of registryIds) {
      const last = lastByOrigin.get(id);
      resolvedRegistry.set(id, last && last.merged_into === null ? last.id : null);
    }
    const currentIds = [
      ...new Set([...resolvedRegistry.values()].filter((id): id is string => !!id)),
    ];
    const visibleIds = new Set<string>();
    if (!visibility.scopes || visibility.scopes.length === 0) {
      currentIds.forEach((id) => visibleIds.add(id));
    } else if (currentIds.length > 0) {
      const currentPlaceholders = currentIds.map(() => '?').join(', ');
      const scopeClauses = visibility.scopes
        .map(() => '(scope_kind = ? AND scope_id = ?)')
        .join(' OR ');
      const bindings = adapter
        .prepare(
          `SELECT DISTINCT node_id FROM registry_scope_bindings
           WHERE node_id IN (${currentPlaceholders}) AND (${scopeClauses})`
        )
        .all(
          ...currentIds,
          ...visibility.scopes.flatMap((scope) => [scope.kind, scope.id])
        ) as Array<{ node_id: string }>;
      bindings.forEach((row) => visibleIds.add(row.node_id));
    }
    for (const projection of projections) {
      if (projection.current_ref?.kind === 'registry') {
        const resolved = resolvedRegistry.get(projection.current_ref.id) ?? null;
        projection.current_ref =
          resolved && visibleIds.has(resolved) ? { kind: 'registry', id: resolved } : null;
      }
    }
  }
  const nonRegistryRefs = projections
    .map((projection) => projection.current_ref)
    .filter((ref): ref is TwinRef => ref !== null && ref.kind !== 'registry');
  const visibleNonRegistry = visibleTwinRefKeysRecursive(adapter, nonRegistryRefs, visibility);
  for (const projection of projections) {
    const current = projection.current_ref;
    if (!current || current.kind === 'registry') {
      continue;
    }
    if (!visibleNonRegistry.has(`${current.kind}\0${current.id}`)) {
      projection.current_ref = null;
    }
  }
  return projections;
}

function numberMs(value: unknown, field: string, refId: string): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.floor(value);
  }
  throw new Error(`Invalid ${field} timestamp for graph timeline ref ${refId}.`);
}

function nullableNumberMs(value: unknown, field: string, refId: string): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  return numberMs(value, field, refId);
}

function parseTimestampMs(value: unknown, field: string, refId: string): number {
  if (typeof value === 'number') {
    return Math.floor(value);
  }
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  throw new Error(`Invalid ${field} timestamp for graph timeline ref ${refId}.`);
}

function timelineWindow(input: GraphTimelineInput): {
  fromMs: number | undefined;
  toMs: number | undefined;
} {
  const upperBounds = [input.to_ms, input.as_of_ms].filter(
    (value): value is number => typeof value === 'number'
  );
  return {
    fromMs: input.from_ms,
    toMs: upperBounds.length > 0 ? Math.min(...upperBounds) : undefined,
  };
}

function isInTimelineWindow(
  atMs: number,
  window: { fromMs: number | undefined; toMs: number | undefined }
): boolean {
  return (
    (window.fromMs === undefined || atMs >= window.fromMs) &&
    (window.toMs === undefined || atMs <= window.toMs)
  );
}

function loadTimelineRecordEvent(
  adapter: AgentGraphAdapter,
  ref: TwinRef
): AgentGraphTimelineEvent | null {
  if (ref.kind === 'memory') {
    const row = adapter
      .prepare(
        `
          SELECT id, topic, decision, created_at, event_datetime
          FROM decisions
          WHERE id = ?
          LIMIT 1
        `
      )
      .get(ref.id) as
      | {
          id: string;
          topic: string | null;
          decision: string | null;
          created_at: number;
          event_datetime: number | null;
        }
      | undefined;
    if (!row) {
      return null;
    }
    const eventDatetime = nullableNumberMs(row.event_datetime, 'decisions.event_datetime', ref.id);
    const createdAt = numberMs(row.created_at, 'decisions.created_at', ref.id);
    return {
      kind: 'memory',
      at_ms: eventDatetime ?? createdAt,
      ref,
      memory: {
        id: row.id,
        topic: row.topic,
        decision: row.decision,
        created_at: createdAt,
        event_datetime: eventDatetime,
      },
    };
  }

  if (ref.kind === 'raw') {
    const row = adapter
      .prepare(
        // A raw ref resolves against observations: one evidence space, and the
        // connector index belongs to the package that has connectors. The aliases
        // keep the wire shape callers already read.
        `
          SELECT
            observation_id AS event_index_id, source AS source_connector, source_type,
                source_id, source_locator, title, source_at AS event_datetime,
                observed_at AS source_timestamp_ms, observation_id AS current_observation_id
          FROM observation_versions
          WHERE observation_id = ?
          LIMIT 1
        `
      )
      .get(ref.id) as
      | {
          event_index_id: string;
          source_connector: string;
          source_type: string;
          source_id: string;
          source_locator: string | null;
          title: string | null;
          event_datetime: number | null;
          source_timestamp_ms: number;
          current_observation_id: string | null;
        }
      | undefined;
    if (!row) {
      return null;
    }
    const eventDatetime = nullableNumberMs(
      row.event_datetime,
      'observation_versions.source_at',
      ref.id
    );
    const sourceTimestampMs = numberMs(
      row.source_timestamp_ms,
      'observation_versions.observed_at',
      ref.id
    );
    return {
      kind: 'raw',
      at_ms: eventDatetime ?? sourceTimestampMs,
      ref,
      raw: {
        event_index_id: row.event_index_id,
        source_connector: row.source_connector,
        source_type: row.source_type,
        source_id: row.source_id,
        source_locator: row.source_locator,
        title: row.title,
        event_datetime: eventDatetime,
        source_timestamp_ms: sourceTimestampMs,
        observation_ref: row.current_observation_id,
      },
    };
  }

  if (ref.kind === 'case') {
    const row = adapter
      .prepare(
        `
          SELECT case_id, title, status, last_activity_at, created_at, updated_at
          FROM case_truth
          WHERE case_id = ?
          LIMIT 1
        `
      )
      .get(ref.id) as
      | {
          case_id: string;
          title: string;
          status: string;
          last_activity_at: string | null;
          created_at: string | number;
          updated_at: string | number;
        }
      | undefined;
    if (!row) {
      return null;
    }
    return {
      kind: 'case',
      at_ms: parseTimestampMs(
        row.last_activity_at ?? row.updated_at,
        'case_truth.updated_at',
        ref.id
      ),
      ref,
      case: {
        case_id: row.case_id,
        title: row.title,
        status: row.status,
        created_at: row.created_at,
        updated_at: row.updated_at,
        last_activity_at: row.last_activity_at,
      },
    };
  }

  return null;
}

export function getGraphNeighborhood(
  adapter: AgentGraphAdapter,
  input: GraphNeighborhoodInput
): AgentGraphResult {
  const depth = normalizeDepth(input.depth, 1);
  const limit = normalizeLimit(input.limit, DEFAULT_GRAPH_LIMIT);
  const visibility = graphVisibility(input);
  assertRefsVisible(adapter, [input.ref], visibility, input.as_of_ms);

  const nodes: TwinRef[] = [];
  const edges: TwinEdgeRecord[] = [];
  const seenNodes = new Set<string>();
  const seenEdges = new Set<string>();
  addNode(nodes, seenNodes, input.ref);

  let frontier: TwinRef[] = [input.ref];
  for (let currentDepth = 0; currentDepth < depth && frontier.length > 0; currentDepth++) {
    const found = listFilteredEdges(adapter, frontier, {
      visibility,
      edge_filters: input.edge_filters,
      as_of_ms: input.as_of_ms,
      limit,
    });
    const direction = input.direction ?? 'both';
    const frontierKeys = new Set(frontier.map(refKey));
    const nextFrontier: TwinRef[] = [];
    const nextKeys = new Set<string>();
    for (const edge of found) {
      if (seenEdges.size >= limit) {
        break;
      }
      const fromHere = frontierKeys.has(refKey(edge.subject_ref));
      const toHere = frontierKeys.has(refKey(edge.object_ref));
      if (direction === 'out' ? !fromHere : direction === 'in' ? !toHere : !fromHere && !toHere) {
        continue;
      }
      if (!seenEdges.has(edgeKey(edge))) {
        seenEdges.add(edgeKey(edge));
        edges.push(edge);
      }
      const expand =
        direction === 'out'
          ? [edge.object_ref]
          : direction === 'in'
            ? [edge.subject_ref]
            : [edge.subject_ref, edge.object_ref];
      for (const endpoint of expand) {
        const before = seenNodes.size;
        addNode(nodes, seenNodes, endpoint);
        if (seenNodes.size > before && !nextKeys.has(refKey(endpoint))) {
          nextKeys.add(refKey(endpoint));
          nextFrontier.push(endpoint);
        }
      }
    }
    frontier = nextFrontier;
  }

  return { nodes, edges, current_projection: projectCurrentEdges(adapter, edges, visibility) };
}

export function getGraphPaths(
  adapter: AgentGraphAdapter,
  input: GraphPathsInput
): GraphPathsResult {
  const maxDepth = normalizeDepth(input.max_depth, 3);
  const limit = normalizeLimit(input.limit, DEFAULT_PATH_LIMIT);
  const visibility = { ...graphVisibility(input), asOfMs: input.as_of_ms };
  assertRefsVisible(adapter, [input.from_ref, input.to_ref], visibility, input.as_of_ms);

  const targetKey = refKey(input.to_ref);
  const queue: AgentGraphPath[] = [{ refs: [input.from_ref], edges: [] }];
  const paths: AgentGraphPath[] = [];
  let edgeWork = 0;
  let limitReached = false;

  while (queue.length > 0 && paths.length < limit) {
    const path = queue.shift();
    if (!path) {
      break;
    }
    const current = path.refs[path.refs.length - 1];
    if (!current || path.edges.length >= maxDepth) {
      continue;
    }
    const remaining = MAX_PATH_EDGE_WORK - edgeWork;
    if (remaining === 0) {
      limitReached = true;
      break;
    }
    // Bound raw candidates before visibility filtering: hidden edges also cost work.
    const candidates = listTwinEdgesForRefs(adapter, [current], {
      newest: true,
      limit: remaining + 1,
      edgeTypes: input.edge_filters?.edge_types,
      asOfMs: input.as_of_ms,
    });
    if (candidates.length > remaining) limitReached = true;
    const bounded = candidates.slice(0, remaining);
    edgeWork += bounded.length;
    const visible = visibleTwinRefKeysRecursive(
      adapter,
      bounded.flatMap((edge) => [edge.subject_ref, edge.object_ref]),
      visibility
    );
    const edges = bounded.filter(
      (edge) =>
        visible.has(`${edge.subject_ref.kind}\0${edge.subject_ref.id}`) &&
        visible.has(`${edge.object_ref.kind}\0${edge.object_ref.id}`)
    );
    for (const edge of edges) {
      for (const next of oppositeRef(edge, current)) {
        if (path.refs.some((ref) => refKey(ref) === refKey(next))) {
          continue;
        }
        const nextPath = { refs: [...path.refs, next], edges: [...path.edges, edge] };
        if (refKey(next) === targetKey) {
          paths.push(nextPath);
          if (paths.length >= limit) {
            break;
          }
        } else if (nextPath.edges.length < maxDepth) {
          if (queue.length < MAX_PATH_FRONTIER) queue.push(nextPath);
          else limitReached = true;
        }
      }
      if (paths.length >= limit) {
        break;
      }
    }
  }

  const pathEdges = [
    ...new Map(paths.flatMap((path) => path.edges).map((edge) => [edge.edge_id, edge])).values(),
  ];
  return {
    paths,
    limit_reached: limitReached || paths.length >= limit,
    current_projection: projectCurrentEdges(adapter, pathEdges, visibility),
  };
}

/**
 * A case seed's timeline is its canonical merge cluster's timeline: cases
 * that merged into the terminal still own their edges, and the members
 * themselves appear as case events. Members the caller cannot see do not
 * expand — a merge is never a scope bypass.
 */
function timelineSeeds(
  adapter: AgentGraphAdapter,
  ref: TwinRef,
  visibility: TwinVisibility
): TwinRef[] {
  if (ref.kind !== 'case') {
    return [ref];
  }
  const resolution = resolveCanonicalCaseChain(adapter, ref.id);
  const cluster = expandCaseChainForAssembly(
    adapter,
    resolution.terminal_case_id,
    resolution.chain
  );
  const members = cluster
    .filter((id) => id !== ref.id)
    .map((id): TwinRef => ({ kind: 'case', id }));
  if (members.length === 0) {
    return [ref];
  }
  const visible = visibleTwinRefKeysRecursive(adapter, members, visibility);
  return [ref, ...members.filter((member) => visible.has(`${member.kind}\0${member.id}`))];
}

export function getGraphTimeline(
  adapter: AgentGraphAdapter,
  input: GraphTimelineInput
): GraphTimelineResult {
  const visibility = graphVisibility(input);
  assertRefsVisible(adapter, [input.ref], visibility, input.as_of_ms);
  const limit = normalizeLimit(input.limit, DEFAULT_GRAPH_LIMIT);
  const window = timelineWindow(input);
  const seeds = timelineSeeds(adapter, input.ref, visibility);
  const edges = listFilteredEdges(adapter, seeds, {
    visibility,
    edge_filters: input.edge_filters,
    as_of_ms: input.as_of_ms,
  }).filter((edge) => isInTimelineWindow(edge.created_at, window));

  const refs: TwinRef[] = [];
  const seenRefs = new Set<string>();
  for (const seed of seeds) {
    addRef(refs, seenRefs, seed);
  }
  for (const edge of edges) {
    addRef(refs, seenRefs, edge.subject_ref);
    addRef(refs, seenRefs, edge.object_ref);
  }

  const events: AgentGraphTimelineEvent[] = [];
  for (const ref of refs) {
    const event = loadTimelineRecordEvent(adapter, ref);
    if (event && isInTimelineWindow(event.at_ms, window)) {
      events.push(event);
    }
  }
  events.push(
    ...edges.map(
      (edge): AgentGraphTimelineEvent => ({ kind: 'edge', at_ms: edge.created_at, edge })
    )
  );

  const ordered = events
    .filter((event) => {
      const recorded = eventRecordedAt(event);
      return (
        (input.recorded_from_ms === undefined || recorded >= input.recorded_from_ms) &&
        (input.recorded_to_ms === undefined || recorded <= input.recorded_to_ms)
      );
    })
    .sort(
      (left, right) =>
        left.at_ms - right.at_ms ||
        eventKindRank(left.kind) - eventKindRank(right.kind) ||
        eventKey(left).localeCompare(eventKey(right))
    );
  return {
    ref: input.ref,
    events: ordered.slice(0, limit),
    has_more: ordered.length > limit,
    current_projection: projectCurrentEdges(adapter, edges, visibility),
  };
}

/* --------------------------------------------------------------------------
 * queryGraph — the §4.1 knowledge read surface over the twin-edge graph.
 *
 * All five views share one boundary: seeds resolve through explicit refs or the
 * three search paths the design names (registry alias, decisions FTS,
 * observation metadata); every ref is checked against the caller's visibility
 * before it is read; and `history` decides whether the page shows refs as
 * written ('all') or folded through merges and supersession to what is current
 * ('current'). Node resolution follows identity chains (registry merges,
 * decision supersession); edge endpoints resolve through T4 slot assignments —
 * the same original ref can point at different current nodes on different
 * edges, which is what a split means.
 * --------------------------------------------------------------------------
 */

const SEARCH_SEED_LIMIT = 25;
const MEMORY_HISTORY_FOLLOW_LIMIT = 100;

interface GraphReadContext {
  visibility: TwinVisibility;
  history: 'current' | 'all';
  query: WorkGraphQuery;
  asOfMs: number;
}

function graphAccessInput(access: JudgmentAccess): {
  scopes: TwinScopeRef[];
  connectors?: string[];
  connector_wide_read?: string[];
  project_refs?: TwinProjectRef[];
  tenant_id?: string | null;
  channels?: Record<string, readonly string[]>;
  principal_id: string;
  agent_id: string;
  max_source_ms?: number | null;
} {
  return {
    scopes: access.scopes.map((scope) => ({ kind: scope.kind, id: scope.id })),
    connectors: access.connectors ? [...access.connectors] : undefined,
    connector_wide_read: access.connectorWideRead ? [...access.connectorWideRead] : undefined,
    project_refs: access.projectRefs ? [...access.projectRefs] : undefined,
    tenant_id: access.tenantId ?? null,
    channels: access.channels ? { ...access.channels } : undefined,
    principal_id: access.principalId,
    agent_id: access.agentId,
    max_source_ms: access.maxSourceMs,
  };
}

interface EdgeCorrection {
  edgeId: string;
  reason: string | null;
  at: number;
  /** A correction can itself be corrected; the chain reads down to the latest word. */
  correctedBy?: EdgeCorrection[];
}

/**
 * Later links that contradict an edge, each with its reason, and the links that contradict those:
 * the edge row is never edited, so a correction is read from the edges that point at it.
 */
function edgeCorrections(
  adapter: AgentGraphAdapter,
  edgeIds: readonly string[],
  visibility: TwinVisibility,
  asOfMs: number
): Map<string, EdgeCorrection[]> {
  const byTarget = new Map<string, Array<{ edgeId: string; reason: string | null; at: number }>>();
  const seen = new Set(edgeIds);
  let frontier = [...edgeIds];
  while (frontier.length > 0) {
    const placeholders = frontier.map(() => '?').join(', ');
    const rows = adapter
      .prepare(
        `SELECT edge_id, subject_kind, subject_id, object_id, reason_text, created_at
           FROM twin_edges
          WHERE object_kind = 'edge' AND edge_type = 'contradicts'
            AND object_id IN (${placeholders}) AND created_at <= ?
          ORDER BY created_at, edge_id`
      )
      .all(...frontier, asOfMs) as Array<{
      edge_id: string;
      subject_kind: TwinRef['kind'];
      subject_id: string;
      object_id: string;
      reason_text: string | null;
      created_at: number;
    }>;
    const subjects = rows.map((row) => ({ kind: row.subject_kind, id: row.subject_id }) as TwinRef);
    const visible = visibleTwinRefKeysRecursive(adapter as never, subjects, visibility);
    frontier = [];
    for (const row of rows) {
      if (!visible.has(`${row.subject_kind}\0${row.subject_id}`)) continue;
      const list = byTarget.get(row.object_id) ?? [];
      list.push({ edgeId: row.edge_id, reason: row.reason_text, at: row.created_at });
      byTarget.set(row.object_id, list);
      if (!seen.has(row.edge_id)) {
        seen.add(row.edge_id);
        frontier.push(row.edge_id);
      }
    }
  }
  const nest = (edgeId: string): EdgeCorrection[] | undefined =>
    byTarget.get(edgeId)?.map((correction) => {
      const further = nest(correction.edgeId);
      return further ? { ...correction, correctedBy: further } : correction;
    });
  const corrections = new Map<string, EdgeCorrection[]>();
  for (const edgeId of edgeIds) {
    const list = nest(edgeId);
    if (list) corrections.set(edgeId, list);
  }
  return corrections;
}

/**
 * Name-free entry: registry alias, decisions FTS, observation metadata. Search
 * seeds are candidates, not citations — refs the caller cannot see are dropped
 * here rather than asserted, because a search must not fail on a hit the
 * caller was never allowed to read.
 */
function resolveSearchSeeds(
  adapter: AgentGraphAdapter,
  search: { text: string; kinds?: WorkReference['kind'][] },
  access: JudgmentAccess,
  visibility: TwinVisibility
): TwinRef[] {
  const text = search.text.trim();
  if (!text) {
    return [];
  }
  const wants = (kind: WorkReference['kind']) => !search.kinds || search.kinds.includes(kind);
  const seeds: TwinRef[] = [];
  if (wants('registry')) {
    for (const node of resolveAliasCandidates(adapter, text, { scopes: access.scopes })) {
      seeds.push({ kind: 'registry', id: node.id });
    }
  }
  if (wants('memory')) {
    // An absent FTS table is a real empty answer, matching knowledge/search.ts.
    const ftsTable = adapter
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'decisions_fts'")
      .get() as { name: string } | undefined;
    const terms = text.match(/[\p{L}\p{N}_]+/gu) ?? [];
    if (ftsTable && terms.length > 0) {
      // Preserve FTS's AND-of-terms recall without accepting user text as
      // operators. A hyphenated name otherwise becomes subtraction and raises
      // "no such column"; quoting the whole input would lose nonadjacent hits.
      const literalTerms = terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(' AND ');
      const rows = adapter
        .prepare(
          `SELECT d.id AS id
             FROM decisions_fts JOIN decisions d ON decisions_fts.rowid = d.rowid
            WHERE decisions_fts MATCH ?
            ORDER BY rank
            LIMIT ?`
        )
        .all(literalTerms, SEARCH_SEED_LIMIT) as Array<{ id: string }>;
      for (const row of rows) {
        seeds.push({ kind: 'memory', id: row.id });
      }
    }
  }
  if (wants('observation')) {
    const like = `%${text.replace(/[%_\\]/g, '\\$&')}%`;
    const rows = adapter
      .prepare(
        `SELECT observation_id
           FROM observation_versions
          WHERE source_id LIKE ? ESCAPE '\\' OR author LIKE ? ESCAPE '\\' OR metadata_json LIKE ? ESCAPE '\\'
          LIMIT ?`
      )
      .all(like, like, like, SEARCH_SEED_LIMIT) as Array<{ observation_id: string }>;
    for (const row of rows) {
      seeds.push({ kind: 'observation', id: row.observation_id });
    }
  }
  const visible = visibleTwinRefKeysRecursive(adapter, seeds, visibility);
  return seeds.filter((ref) => visible.has(`${ref.kind}\0${ref.id}`));
}

function resolveSeeds(
  adapter: AgentGraphAdapter,
  query: WorkGraphQuery,
  access: JudgmentAccess,
  visibility: TwinVisibility
): { explicit: TwinRef[]; resolved: TwinRef[] } {
  const explicit = query.seeds ?? [];
  const resolved = query.search
    ? resolveSearchSeeds(adapter, query.search, access, visibility)
    : [];
  return { explicit, resolved };
}

/** Follow `superseded_by` to the record that currently speaks for this one. */
function currentMemoryRef(adapter: AgentGraphAdapter, ref: TwinRef): TwinRef {
  let current = ref;
  for (let hops = 0; hops < MEMORY_HISTORY_FOLLOW_LIMIT; hops += 1) {
    const row = adapter
      .prepare('SELECT superseded_by FROM decisions WHERE id = ?')
      .get(current.id) as { superseded_by: string | null } | undefined;
    if (!row?.superseded_by) {
      return current;
    }
    current = { kind: 'memory', id: row.superseded_by };
  }
  throw new AgentGraphValidationError(
    `Supersession chain from ${ref.id} does not settle within ${MEMORY_HISTORY_FOLLOW_LIMIT} hops.`
  );
}

/**
 * The node a ref resolves to under identity corrections — registry merges for
 * nodes, supersession heads for records. Returns null when the identity has no
 * current node (a merge chain that settled on nothing).
 */
function resolveNodeIdentity(adapter: AgentGraphAdapter, ref: TwinRef): TwinRef | null {
  if (ref.kind === 'registry') {
    const node = resolveNodeById(adapter, ref.id);
    return node ? { kind: 'registry', id: node.id } : null;
  }
  if (ref.kind === 'memory') {
    return currentMemoryRef(adapter, ref);
  }
  if (ref.kind === 'case') {
    // A merged case folds to its canonical terminal — the same identity
    // contract registry merges and memory supersession already honor. A
    // missing row resolves away like any other absent record.
    const exists = adapter
      .prepare('SELECT 1 FROM case_truth WHERE case_id = ? LIMIT 1')
      .get(ref.id);
    if (!exists) {
      return null;
    }
    const resolution = resolveCanonicalCaseChain(adapter, ref.id);
    return { kind: 'case', id: resolution.terminal_case_id };
  }
  return ref;
}

interface RegistryNodeRowShape {
  id: string;
  kind: string;
  name: string;
  parent_id: string | null;
  merged_into: string | null;
  note: string | null;
  created_at: number;
  updated_at: number;
}

function readRegistryRow(adapter: AgentGraphAdapter, id: string): RegistryNode | null {
  const row = adapter.prepare('SELECT * FROM registry_nodes WHERE id = ?').get(id) as
    | RegistryNodeRowShape
    | undefined;
  if (!row) {
    return null;
  }
  return {
    id: row.id,
    kind: row.kind as RegistryNode['kind'],
    name: row.name,
    parentId: row.parent_id,
    mergedInto: row.merged_into,
    note: row.note,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function windowSectionText(
  ctx: GraphReadContext,
  ref: TwinRef,
  sections: Record<'summary' | 'reasoning' | 'payload', string>
): { text: string; content: { complete: boolean; nextRead: WorkGraphQuery | null } } {
  const section = ctx.query.section ?? 'summary';
  const full = sections[section];
  const offset = ctx.query.textOffset ?? 0;
  const limit = ctx.query.textLimit;
  const text = limit === undefined ? full.slice(offset) : full.slice(offset, offset + limit);
  const complete = offset + text.length >= full.length;
  return {
    text,
    content: {
      complete,
      nextRead: complete
        ? null
        : {
            seeds: [ref],
            view: 'detail',
            section,
            textOffset: offset + text.length,
            textLimit: limit,
          },
    },
  };
}

function hydrateMemoryNode(
  adapter: AgentGraphAdapter,
  ref: TwinRef,
  ctx: GraphReadContext
): { label: string; data: WorkGraphNodeData } | null {
  const row = adapter
    .prepare(
      `SELECT id, topic, decision, reasoning, outcome, failure_reason, limitation, confidence,
              event_date, event_datetime, created_at, updated_at, status, superseded_by,
              refined_from, record_kind, kind
         FROM decisions
        WHERE id = ?
        LIMIT 1`
    )
    .get(ref.id) as
    | {
        id: string;
        topic: string | null;
        decision: string | null;
        reasoning: string | null;
        outcome: string | null;
        failure_reason: string | null;
        limitation: string | null;
        confidence: number | null;
        event_date: string | null;
        event_datetime: number | null;
        created_at: number;
        updated_at: number | null;
        status: string | null;
        superseded_by: string | null;
        refined_from: string | string[] | null;
        record_kind: string | null;
        kind: string | null;
      }
    | undefined;
  if (!row) {
    return null;
  }
  const recordedAt = numberMs(row.created_at, 'decisions.created_at', ref.id);
  const appliesFrom = nullableNumberMs(row.event_datetime, 'decisions.event_datetime', ref.id);
  let appliesUntil: number | null = null;
  if (row.superseded_by) {
    const superseder = adapter
      .prepare('SELECT created_at FROM decisions WHERE id = ?')
      .get(row.superseded_by) as { created_at: number } | undefined;
    if (superseder) {
      appliesUntil = numberMs(superseder.created_at, 'decisions.created_at', row.superseded_by);
    }
  }
  const workLink = adapter
    .prepare(
      `SELECT a.commitment_id, a.revision, c.row_id, c.head_record_id, c.withdrawn
         FROM commitment_assignments a
         JOIN commitments c ON c.commitment_id = a.commitment_id
        WHERE a.record_id = ?
        ORDER BY a.revision DESC
        LIMIT 1`
    )
    .get(ref.id) as
    | {
        commitment_id: string;
        revision: number;
        row_id: number;
        head_record_id: string;
        withdrawn: number;
      }
    | undefined;
  const work = workLink
    ? {
        commitmentId: workLink.commitment_id,
        rowId: workLink.row_id,
        revision: workLink.revision,
        latestJudgmentRef: { kind: 'memory', id: workLink.head_record_id } as WorkReference,
      }
    : null;
  const stateAtSnapshot: Extract<WorkGraphNodeData, { kind: 'memory' }>['stateAtSnapshot'] =
    workLink?.withdrawn === 1
      ? 'withdrawn'
      : row.status === 'superseded' || row.superseded_by
        ? 'replaced'
        : appliesFrom !== null && appliesFrom > ctx.asOfMs
          ? 'not_yet_effective'
          : 'current';
  const refined = parseRefinedFrom({ id: ref.id, refined_from: row.refined_from });
  const replaces = (Array.isArray(refined) ? refined : refined ? [refined] : []).map(String);
  const payload: Record<string, JsonValue> = {};
  if (row.reasoning !== null) payload.reasoning = row.reasoning;
  if (row.outcome !== null) payload.outcome = row.outcome;
  if (row.failure_reason !== null) payload.failure_reason = row.failure_reason;
  if (row.limitation !== null) payload.limitation = row.limitation;
  if (row.confidence !== null) payload.confidence = row.confidence;
  if (row.event_date !== null) payload.event_date = row.event_date;
  if (row.updated_at !== null) payload.updated_at = row.updated_at;
  const { text, content } = windowSectionText(ctx, ref, {
    summary: row.decision ?? '',
    reasoning: row.reasoning ?? '',
    payload: JSON.stringify(payload),
  });
  const recordKind =
    row.record_kind === 'judgment' || row.record_kind === 'commitment'
      ? row.record_kind
      : ('legacy' as const);
  return {
    label: row.topic ?? ((row.decision ?? '').slice(0, 80) || ref.id),
    data: {
      kind: 'memory',
      recordKind,
      memoryKind: row.kind,
      topic: row.topic ?? '',
      summary: text,
      recordedAt,
      appliesFrom,
      appliesUntil,
      stateAtSnapshot,
      replaces,
      payload,
      work,
      content,
    },
  };
}

function hydrateRegistryNode(
  adapter: AgentGraphAdapter,
  ref: TwinRef,
  ctx: GraphReadContext,
  access: JudgmentAccess
): { label: string; data: WorkGraphNodeData } | null {
  const resolved = resolveNodeById(adapter, ref.id);
  const node = ctx.history === 'all' ? (readRegistryRow(adapter, ref.id) ?? resolved) : resolved;
  if (!node) {
    return null;
  }
  const admitted =
    access.scopes.length > 0 ? access.scopes : [{ kind: 'global' as const, id: '*' }];
  const aliasRows = adapter
    .prepare(
      `SELECT DISTINCT alias_display FROM registry_aliases
        WHERE node_id = ?
          AND ((scope_kind = 'global' AND scope_id = '*')
            OR (scope_kind || ':' || scope_id) IN (${admitted.map(() => '?').join(', ')}))
        ORDER BY created_at, rowid`
    )
    .all(node.id, ...admitted.map((scope) => `${scope.kind}:${scope.id}`)) as Array<{
    alias_display: string;
  }>;
  const children = listNodes(adapter, { parentId: node.id, scopes: access.scopes });
  const touching = listFilteredEdges(adapter, [ref], { visibility: ctx.visibility });
  const unresolved: Array<{ edgeId: string; endpoint: 'from' | 'to' }> = [];
  for (const projection of projectCurrentEdges(adapter, touching, ctx.visibility)) {
    if (projection.current_ref === null && refKey(projection.original_ref) === refKey(ref)) {
      unresolved.push({ edgeId: projection.edge_id, endpoint: projection.endpoint });
    }
  }
  return {
    label: node.name,
    data: {
      kind: 'registry',
      nodeKind: node.kind,
      name: node.name,
      parentId: node.parentId,
      visibleAliases: aliasRows.map((row) => row.alias_display),
      identityRevision: currentIdentityRevision(adapter),
      visibleChildren: children.map((child) => ({
        kind: 'registry' as const,
        id: child.id,
        name: child.name,
      })),
      unresolvedSlots: unresolved,
    },
  };
}

function hydrateObservationNode(
  adapter: AgentGraphAdapter,
  ref: TwinRef
): { label: string; data: WorkGraphNodeData } | null {
  const record = getObservationVersion(adapter, ref.id);
  if (!record) {
    return null;
  }
  return {
    label: `${record.source}:${record.sourceId}`,
    data: {
      kind: 'observation',
      connector: record.source,
      sourceId: record.sourceId,
      sourceAt: record.sourceAt,
      observedAt: record.observedAt,
      contentHash: record.contentHash,
    },
  };
}

function hydrateRecordNode(
  adapter: AgentGraphAdapter,
  ref: TwinRef
): { label: string; data: WorkGraphNodeData } | null {
  if (ref.kind === 'case') {
    const row = adapter
      .prepare(
        `SELECT case_id, title, status, last_activity_at, created_at, updated_at
           FROM case_truth WHERE case_id = ? LIMIT 1`
      )
      .get(ref.id) as Record<string, unknown> | undefined;
    if (!row) {
      return null;
    }
    return {
      label: String(row.title ?? ref.id),
      data: { kind: 'case', data: row as Record<string, JsonValue> },
    };
  }
  if (ref.kind === 'raw') {
    const row = adapter
      .prepare(
        `SELECT observation_id AS event_index_id, source AS source_connector, source_type,
                source_id, source_locator, title, source_at AS event_datetime,
                observed_at AS source_timestamp_ms, observation_id AS current_observation_id
           FROM observation_versions WHERE observation_id = ? LIMIT 1`
      )
      .get(ref.id) as Record<string, unknown> | undefined;
    if (!row) {
      return null;
    }
    return {
      label: String(row.title ?? `${row.source_connector}:${row.source_id}`),
      data: { kind: 'raw', data: row as Record<string, JsonValue> },
    };
  }
  if (ref.kind === 'edge') {
    const edge = getTwinEdge(adapter, ref.id);
    if (!edge) {
      return null;
    }
    return {
      label: `${edge.edge_type}:${edge.edge_id}`,
      data: {
        kind: 'edge',
        data: {
          edge_id: edge.edge_id,
          edge_type: edge.edge_type,
          subject_ref: edge.subject_ref as JsonValue,
          object_ref: edge.object_ref as JsonValue,
          relation_attrs: (edge.relation_attrs ?? null) as JsonValue,
          confidence: edge.confidence,
          source: edge.source,
          agent_id: edge.agent_id,
          model_run_id: edge.model_run_id,
          reason_classification: edge.reason_classification,
          reason_text: edge.reason_text,
          created_at: edge.created_at,
        },
      },
    };
  }
  // 'report' has no backing store; the ref id is the whole honest answer.
  return { label: ref.id, data: { kind: 'report', data: { id: ref.id } } };
}

function hydrateNode(
  adapter: AgentGraphAdapter,
  ref: TwinRef,
  ctx: GraphReadContext,
  access: JudgmentAccess
): { label: string; data: WorkGraphNodeData } | null {
  if (ref.kind === 'memory') {
    return hydrateMemoryNode(adapter, ref, ctx);
  }
  if (ref.kind === 'registry') {
    const hydrated = hydrateRegistryNode(adapter, ref, ctx, access);
    return hydrated ? { label: hydrated.label, data: hydrated.data } : null;
  }
  if (ref.kind === 'observation') {
    return hydrateObservationNode(adapter, ref);
  }
  return hydrateRecordNode(adapter, ref);
}

function pageEdgeAttrs(edge: TwinEdgeRecord, correctedBy?: readonly EdgeCorrection[]): JsonValue {
  return {
    ...(correctedBy?.length ? { corrected_by: correctedBy as unknown as JsonValue } : {}),
    edge_type: edge.edge_type,
    relation_attrs: (edge.relation_attrs ?? null) as JsonValue,
    confidence: edge.confidence,
    source: edge.source,
    agent_id: edge.agent_id,
    model_run_id: edge.model_run_id,
    reason_classification: edge.reason_classification,
    reason_text: edge.reason_text,
    evidence_refs: (edge.evidence_refs ?? null) as JsonValue,
    created_at: edge.created_at,
    content_hash: edge.content_hash.toString('hex'),
  } as JsonValue;
}

function projectionKey(edgeId: string, endpoint: 'from' | 'to'): string {
  return `${edgeId}${endpoint}`;
}

function mergeProjections(
  target: Map<string, AgentGraphCurrentProjection>,
  projections: readonly AgentGraphCurrentProjection[]
): void {
  for (const projection of projections) {
    target.set(projectionKey(projection.edge_id, projection.endpoint), projection);
  }
}

function eventRecordedAt(event: AgentGraphTimelineEvent): number {
  if (event.kind === 'edge') {
    return event.edge.created_at;
  }
  if (event.kind === 'memory') {
    return event.memory.created_at;
  }
  if (event.kind === 'case') {
    return parseTimestampMs(event.case.created_at, 'case_truth.created_at', event.ref.id);
  }
  return event.raw.source_timestamp_ms;
}

function validateRelations(relations: readonly string[] | undefined): TwinEdgeType[] | undefined {
  if (!relations) {
    return undefined;
  }
  const known = new Set<string>(TWIN_EDGE_TYPES);
  const unknown = relations.filter((relation) => !known.has(relation));
  if (unknown.length > 0) {
    throw new JudgmentError(
      'INVALID_QUERY',
      `Unsupported graph relation(s): ${unknown.join(', ')}. Known: ${TWIN_EDGE_TYPES.join(', ')}`
    );
  }
  return [...new Set(relations)] as TwinEdgeType[];
}

function requireSeeds(view: string, seeds: readonly TwinRef[], searchProvided: boolean): void {
  // A search that resolves to nothing is a legitimate answer — the lookup's
  // found:false — not a malformed query. Only a query with no anchor at all
  // (no explicit seeds, no search) is an error.
  if (seeds.length === 0 && !searchProvided) {
    throw new JudgmentError(
      'INVALID_QUERY',
      `graph ${view} requires at least one seed (seeds or search).`
    );
  }
}

function graphSnapshot(adapter: AgentGraphAdapter, asOf: number): WorkGraphPage['snapshot'] {
  const commandsTable = adapter
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'judgment_commands'")
    .get() as { name: string } | undefined;
  const judgmentWatermark = commandsTable
    ? ((
        adapter
          .prepare('SELECT COALESCE(MAX(committed_watermark), 0) AS w FROM judgment_commands')
          .get() as { w: number }
      ).w ?? 0)
    : 0;
  return { judgmentWatermark, identityRevision: currentIdentityRevision(adapter), asOf };
}

interface BrowseCursor {
  v: 1;
  asOf: number;
  afterAt: number;
  afterId: string;
  history: 'current' | 'all';
  relations: string;
}

function decodeBrowseCursor(
  value: string,
  history: 'current' | 'all',
  relations: string
): BrowseCursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
  } catch {
    throw new JudgmentError('INVALID_QUERY', 'graph browse cursor is malformed');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new JudgmentError('INVALID_QUERY', 'graph browse cursor is malformed');
  }
  const cursor = parsed as Partial<BrowseCursor>;
  if (
    cursor.v !== 1 ||
    typeof cursor.asOf !== 'number' ||
    !Number.isFinite(cursor.asOf) ||
    typeof cursor.afterAt !== 'number' ||
    !Number.isFinite(cursor.afterAt) ||
    typeof cursor.afterId !== 'string' ||
    cursor.afterId.length === 0 ||
    cursor.history !== history ||
    cursor.relations !== relations
  ) {
    throw new JudgmentError('INVALID_QUERY', 'graph browse cursor does not match this read');
  }
  return cursor as BrowseCursor;
}

function browseVisibleEdges(
  adapter: AgentGraphAdapter,
  options: {
    asOf: number;
    limit: number;
    cursor: BrowseCursor | null;
    visibility: TwinVisibility;
    relations: readonly TwinEdgeType[] | undefined;
    history: 'current' | 'all';
  }
): { edges: TwinEdgeRecord[]; nextCursor: string | null } {
  const batchSize = 250;
  const maxScan = Math.max(batchSize, options.limit * 4);
  const admitted: TwinEdgeRecord[] = [];
  let afterAt = options.cursor?.afterAt;
  let afterId = options.cursor?.afterId;
  let scanned = 0;
  let lastProcessed: { created_at: number; edge_id: string } | null = null;
  let exhausted = false;
  const relations = options.relations ? new Set(options.relations) : null;

  while (scanned < maxScan && admitted.length < options.limit) {
    const rowLimit = Math.min(batchSize, maxScan - scanned);
    const rows = (
      afterAt === undefined
        ? adapter
            .prepare(
              'SELECT edge_id, created_at FROM twin_edges WHERE created_at <= ? ORDER BY created_at DESC, edge_id ASC LIMIT ?'
            )
            .all(options.asOf, rowLimit)
        : adapter
            .prepare(
              'SELECT edge_id, created_at FROM twin_edges WHERE created_at <= ? AND (created_at < ? OR (created_at = ? AND edge_id > ?)) ORDER BY created_at DESC, edge_id ASC LIMIT ?'
            )
            .all(options.asOf, afterAt, afterAt, afterId, rowLimit)
    ) as Array<{
      edge_id: string;
      created_at: number;
    }>;
    if (rows.length === 0) {
      exhausted = true;
      break;
    }
    const candidates = rows.map((row) => getTwinEdge(adapter, row.edge_id));
    const visible = visibleTwinRefKeysRecursive(
      adapter,
      candidates.flatMap((edge) => (edge ? [edge.subject_ref, edge.object_ref] : [])),
      { ...options.visibility, asOfMs: options.asOf }
    );
    for (let i = 0; i < rows.length; i += 1) {
      const row = rows[i]!;
      const edge = candidates[i];
      lastProcessed = row;
      scanned += 1;
      if (
        edge &&
        (!relations || relations.has(edge.edge_type)) &&
        visible.has(`${edge.subject_ref.kind}\0${edge.subject_ref.id}`) &&
        visible.has(`${edge.object_ref.kind}\0${edge.object_ref.id}`)
      ) {
        admitted.push(edge);
      }
      if (admitted.length >= options.limit) break;
    }
    if (lastProcessed) {
      afterAt = lastProcessed.created_at;
      afterId = lastProcessed.edge_id;
    }
    if (rows.length < rowLimit && admitted.length < options.limit) {
      exhausted = true;
      break;
    }
  }

  if (!lastProcessed || exhausted) return { edges: admitted, nextCursor: null };
  const more = adapter
    .prepare(
      'SELECT 1 FROM twin_edges WHERE created_at <= ? AND (created_at < ? OR (created_at = ? AND edge_id > ?)) LIMIT 1'
    )
    .get(options.asOf, lastProcessed.created_at, lastProcessed.created_at, lastProcessed.edge_id);
  const nextCursor = more
    ? Buffer.from(
        JSON.stringify({
          v: 1,
          asOf: options.asOf,
          afterAt: lastProcessed.created_at,
          afterId: lastProcessed.edge_id,
          history: options.history,
          relations: [...(options.relations ?? [])].sort().join(','),
        } satisfies BrowseCursor)
      ).toString('base64url')
    : null;
  return { edges: admitted, nextCursor };
}

export function queryGraph(
  adapter: AgentGraphAdapter,
  query: WorkGraphQuery,
  access: JudgmentAccess
): WorkGraphPage {
  if (query.cursor !== undefined && query.view !== 'browse') {
    throw new JudgmentError(
      'CURSOR_UNSUPPORTED',
      'graph cursors are not issued yet; restart the query without cursor.'
    );
  }
  const history = query.history ?? 'current';
  if (history !== 'current' && history !== 'all') {
    throw new JudgmentError('INVALID_QUERY', "history must be 'current' or 'all'");
  }
  const direction = query.direction ?? 'both';
  if (direction !== 'in' && direction !== 'out' && direction !== 'both') {
    throw new JudgmentError('INVALID_QUERY', "direction must be 'in', 'out', or 'both'");
  }
  const relationTypes = validateRelations(query.relations);
  const relationKey = [...(relationTypes ?? [])].sort().join(',');
  const browseCursor =
    query.view === 'browse' && query.cursor
      ? decodeBrowseCursor(query.cursor, history, relationKey)
      : null;
  if (browseCursor && query.asOf !== undefined && query.asOf !== browseCursor.asOf) {
    throw new JudgmentError('INVALID_QUERY', 'graph browse cursor snapshot changed');
  }
  const accessInput = graphAccessInput(access);
  const visibility = graphVisibility({ ...accessInput, history });
  const asOf = browseCursor?.asOf ?? query.asOf ?? Date.now();
  const limit = normalizeLimit(query.limit, DEFAULT_GRAPH_LIMIT);
  const edgeFilters = relationTypes ? { edge_types: relationTypes } : undefined;
  const ctx: GraphReadContext = { visibility, history, query, asOfMs: asOf };

  const { explicit, resolved } = resolveSeeds(adapter, query, access, visibility);
  const seedRefs: TwinRef[] = [];
  const seenSeeds = new Set<string>();
  for (const ref of [...explicit, ...resolved]) {
    if (!seenSeeds.has(refKey(ref))) {
      seenSeeds.add(refKey(ref));
      seedRefs.push(ref);
    }
  }

  const nodeRefs: TwinRef[] = [];
  const seenNodes = new Set<string>();
  const collectedEdges: TwinEdgeRecord[] = [];
  const seenEdges = new Set<string>();
  const projections = new Map<string, AgentGraphCurrentProjection>();
  const reasons = new Set<string>();
  const nodeOrder = new Map<string, number>();
  let nextCursor: string | null = null;
  let sequence = 0;
  const addRefNode = (ref: TwinRef, order?: number): void => {
    if (!seenNodes.has(refKey(ref))) {
      seenNodes.add(refKey(ref));
      nodeRefs.push(ref);
    }
    if (order !== undefined && !nodeOrder.has(refKey(ref))) {
      nodeOrder.set(refKey(ref), order);
    }
  };
  const addEdge = (edge: TwinEdgeRecord): void => {
    if (!seenEdges.has(edgeKey(edge))) {
      seenEdges.add(edgeKey(edge));
      collectedEdges.push(edge);
    }
  };

  switch (query.view) {
    case 'browse': {
      if (
        query.seeds ||
        query.search ||
        query.from ||
        query.to ||
        query.maxDepth !== undefined ||
        query.direction !== undefined ||
        query.section !== undefined ||
        query.textOffset !== undefined ||
        query.textLimit !== undefined ||
        query.eventRange !== undefined ||
        query.recordedRange !== undefined
      ) {
        throw new JudgmentError(
          'INVALID_QUERY',
          'graph browse accepts only history, relations, asOf, limit and cursor'
        );
      }
      const page = browseVisibleEdges(adapter, {
        asOf,
        limit: Math.min(limit, 2000),
        cursor: browseCursor,
        visibility,
        relations: relationTypes,
        history,
      });
      for (const edge of page.edges) {
        addRefNode(edge.subject_ref, sequence++);
        addRefNode(edge.object_ref, sequence++);
        addEdge(edge);
      }
      mergeProjections(projections, projectCurrentEdges(adapter, page.edges, visibility));
      nextCursor = page.nextCursor;
      if (nextCursor) reasons.add('limit_reached');
      break;
    }
    case 'neighbors': {
      requireSeeds(query.view, seedRefs, query.search !== undefined);
      if (seedRefs.length === 0) {
        reasons.add('search_no_match');
        break;
      }
      for (const seed of seedRefs) {
        const result = getGraphNeighborhood(adapter, {
          ref: seed,
          depth: query.maxDepth,
          direction,
          ...accessInput,
          history,
          edge_filters: edgeFilters,
          as_of_ms: query.asOf ?? null,
          limit,
        });
        for (const ref of result.nodes) addRefNode(ref, sequence++);
        for (const edge of result.edges) addEdge(edge);
        mergeProjections(projections, result.current_projection);
        if (result.edges.length >= limit) reasons.add('limit_reached');
      }
      break;
    }
    case 'paths': {
      if (!query.from || !query.to) {
        throw new JudgmentError('INVALID_QUERY', 'graph paths requires from and to refs.');
      }
      const result = getGraphPaths(adapter, {
        from_ref: query.from,
        to_ref: query.to,
        max_depth: query.maxDepth,
        ...accessInput,
        history,
        edge_filters: edgeFilters,
        as_of_ms: query.asOf ?? null,
        limit,
      });
      if (result.limit_reached) reasons.add('limit_reached');
      for (const path of result.paths) {
        for (const ref of path.refs) addRefNode(ref, sequence++);
        for (const edge of path.edges) addEdge(edge);
      }
      mergeProjections(projections, result.current_projection);
      break;
    }
    case 'timeline': {
      requireSeeds(query.view, seedRefs, query.search !== undefined);
      if (seedRefs.length === 0) {
        reasons.add('search_no_match');
        break;
      }
      const merged = new Map<string, AgentGraphTimelineEvent>();
      for (const seed of seedRefs) {
        const result = getGraphTimeline(adapter, {
          ref: seed,
          ...accessInput,
          history,
          edge_filters: edgeFilters,
          from_ms: query.eventRange?.start,
          to_ms: query.eventRange?.end,
          recorded_from_ms: query.recordedRange?.start,
          recorded_to_ms: query.recordedRange?.end,
          as_of_ms: query.asOf ?? null,
          limit,
        });
        if (result.has_more) reasons.add('limit_reached');
        for (const event of result.events) {
          merged.set(`${event.kind}${eventKey(event)}`, event);
        }
        mergeProjections(projections, result.current_projection);
      }
      let events = [...merged.values()];
      events.sort(
        (left, right) =>
          left.at_ms - right.at_ms ||
          eventKindRank(left.kind) - eventKindRank(right.kind) ||
          eventKey(left).localeCompare(eventKey(right))
      );
      if (events.length > limit) reasons.add('limit_reached');
      events = events.slice(0, limit);
      for (const seed of seedRefs) addRefNode(seed, -1);
      for (const event of events) {
        if (event.kind === 'edge') {
          addEdge(event.edge);
        } else {
          addRefNode(event.ref, event.at_ms);
        }
      }
      break;
    }
    case 'detail': {
      requireSeeds(query.view, seedRefs, query.search !== undefined);
      if (seedRefs.length > 0) {
        assertRefsVisible(adapter, seedRefs, visibility, query.asOf ?? null);
        for (const seed of seedRefs) addRefNode(seed, sequence++);
      } else {
        reasons.add('search_no_match');
      }
      break;
    }
    case 'overview': {
      // The name-free entry point: the registry's visible roots are the named
      // anchors a caller picks before narrowing into neighbors/detail.
      const roots = listNodes(adapter, { parentId: null, scopes: access.scopes });
      if (roots.length > limit) reasons.add('limit_reached');
      for (const node of roots.slice(0, limit)) {
        addRefNode({ kind: 'registry', id: node.id }, sequence++);
      }
      break;
    }
    default: {
      throw new JudgmentError(
        'INVALID_QUERY',
        `graph view must be one of overview, browse, neighbors, timeline, paths, detail; got ${String(
          (query as { view: unknown }).view
        )}.`
      );
    }
  }

  const nodes: WorkGraphPage['nodes'] = [];
  const emitted = new Set<string>();
  for (const original of nodeRefs) {
    const resolved = resolveNodeIdentity(adapter, original);
    if (history === 'current') {
      if (resolved === null) {
        reasons.add('resolved_away');
        continue;
      }
      const visible = visibleTwinRefKeysRecursive(adapter, [resolved], {
        ...visibility,
        asOfMs: query.asOf ?? null,
      });
      if (!visible.has(`${resolved.kind}\0${resolved.id}`)) {
        reasons.add('resolved_not_visible');
        continue;
      }
      if (emitted.has(refKey(resolved))) {
        continue;
      }
      emitted.add(refKey(resolved));
      const hydrated = hydrateNode(adapter, resolved, ctx, access);
      if (!hydrated) {
        reasons.add('records_missing');
        continue;
      }
      if (
        hydrated.data.kind === 'memory' &&
        (hydrated.data.stateAtSnapshot === 'replaced' ||
          hydrated.data.stateAtSnapshot === 'withdrawn')
      ) {
        reasons.add('non_current_omitted');
        continue;
      }
      nodes.push({
        ref: resolved,
        resolvedRef: resolved,
        label: hydrated.label,
        data: hydrated.data,
      });
    } else {
      const hydrated = hydrateNode(adapter, original, ctx, access);
      if (!hydrated) {
        reasons.add('records_missing');
        continue;
      }
      nodes.push({
        ref: original,
        resolvedRef: resolved ?? original,
        label: hydrated.label,
        data: hydrated.data,
      });
    }
  }
  if (query.view === 'timeline' || nodeOrder.size > 0) {
    nodes.sort(
      (left, right) =>
        (nodeOrder.get(`${left.ref.kind}:${left.ref.id}`) ?? Number.MAX_SAFE_INTEGER) -
        (nodeOrder.get(`${right.ref.kind}:${right.ref.id}`) ?? Number.MAX_SAFE_INTEGER)
    );
  }

  const corrections = edgeCorrections(
    adapter,
    collectedEdges.map((edge) => edge.edge_id),
    ctx.visibility,
    asOf
  );
  const pageEdges: WorkGraphPage['edges'] = collectedEdges.map((edge) => {
    const fromProjection = projections.get(projectionKey(edge.edge_id, 'from'));
    const toProjection = projections.get(projectionKey(edge.edge_id, 'to'));
    return {
      id: edge.edge_id,
      relation: edge.edge_type,
      from: edge.subject_ref,
      to: edge.object_ref,
      resolvedFrom: fromProjection?.current_ref ?? edge.subject_ref,
      resolvedTo: toProjection?.current_ref ?? edge.object_ref,
      attrs: pageEdgeAttrs(edge, corrections.get(edge.edge_id)),
    };
  });

  return {
    nodes,
    edges: pageEdges,
    coverage: {
      returned: nodes.length,
      total: null,
      complete: reasons.size === 0,
      reasons: [...reasons],
    },
    snapshot: graphSnapshot(adapter, asOf),
    nextCursor,
  };
}
