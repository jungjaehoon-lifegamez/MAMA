import { assertTwinRefsVisible, listVisibleTwinEdgesForRefs } from '../edges/ref-validation.js';
import type { TwinEdgeRecord, TwinRef, TwinVisibility } from '../edges/types.js';
import { getEntityNode } from '../entities/store.js';
import type {
  AgentGraphAdapter,
  AgentGraphEdgeFilters,
  AgentGraphPath,
  AgentGraphResult,
  GraphNeighborhoodInput,
  GraphPathsInput,
  GraphPathsResult,
  AgentGraphTimelineEvent,
  GraphTimelineInput,
  GraphTimelineResult,
} from './types.js';
import { AgentGraphValidationError } from './errors.js';

const DEFAULT_GRAPH_LIMIT = 100;
const DEFAULT_PATH_LIMIT = 10;
const MAX_DEPTH = 5;

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
  if (kind === 'entity') {
    return 0;
  }
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
  return listVisibleTwinEdgesForRefs(adapter, refs, {
    scopes: input.visibility.scopes,
    connectors: input.visibility.connectors,
    projectRefs: input.visibility.projectRefs,
    tenantId: input.visibility.tenantId,
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
    throw new AgentGraphValidationError(error instanceof Error ? error.message : String(error));
  }
}

function graphVisibility(input: {
  scopes?: TwinVisibility['scopes'];
  connectors?: TwinVisibility['connectors'];
  project_refs?: TwinVisibility['projectRefs'];
  tenant_id?: TwinVisibility['tenantId'];
}): TwinVisibility {
  return {
    scopes: input.scopes,
    connectors: input.connectors,
    projectRefs: input.project_refs,
    tenantId: input.tenant_id,
  };
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
  if (typeof value === 'number' && Number.isFinite(value)) {
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
  if (ref.kind === 'entity') {
    const entity = getEntityNode(ref.id, adapter);
    if (!entity || entity.status !== 'active') {
      return null;
    }
    return { kind: 'entity', at_ms: entity.created_at, ref, entity };
  }

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
        `
          SELECT
            event_index_id, source_connector, source_type, source_id, source_locator,
            title, event_datetime, source_timestamp_ms
          FROM connector_event_index
          WHERE event_index_id = ?
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
        }
      | undefined;
    if (!row) {
      return null;
    }
    const eventDatetime = nullableNumberMs(
      row.event_datetime,
      'connector_event_index.event_datetime',
      ref.id
    );
    const sourceTimestampMs = numberMs(
      row.source_timestamp_ms,
      'connector_event_index.source_timestamp_ms',
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
    const nextFrontier: TwinRef[] = [];
    const nextKeys = new Set<string>();
    for (const edge of found) {
      if (seenEdges.size >= limit) {
        break;
      }
      if (!seenEdges.has(edgeKey(edge))) {
        seenEdges.add(edgeKey(edge));
        edges.push(edge);
      }
      for (const endpoint of [edge.subject_ref, edge.object_ref]) {
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

  return { nodes, edges };
}

export function getGraphPaths(
  adapter: AgentGraphAdapter,
  input: GraphPathsInput
): GraphPathsResult {
  const maxDepth = normalizeDepth(input.max_depth, 3);
  const limit = normalizeLimit(input.limit, DEFAULT_PATH_LIMIT);
  const visibility = graphVisibility(input);
  assertRefsVisible(adapter, [input.from_ref, input.to_ref], visibility, input.as_of_ms);

  const targetKey = refKey(input.to_ref);
  const queue: AgentGraphPath[] = [{ refs: [input.from_ref], edges: [] }];
  const paths: AgentGraphPath[] = [];

  while (queue.length > 0 && paths.length < limit) {
    const path = queue.shift();
    if (!path) {
      break;
    }
    const current = path.refs[path.refs.length - 1];
    if (!current || path.edges.length >= maxDepth) {
      continue;
    }
    const edges = listFilteredEdges(adapter, [current], {
      visibility,
      edge_filters: input.edge_filters,
      as_of_ms: input.as_of_ms,
    });
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
        } else {
          queue.push(nextPath);
        }
      }
      if (paths.length >= limit) {
        break;
      }
    }
  }

  return { paths };
}

export function getGraphTimeline(
  adapter: AgentGraphAdapter,
  input: GraphTimelineInput
): GraphTimelineResult {
  const visibility = graphVisibility(input);
  assertRefsVisible(adapter, [input.ref], visibility, input.as_of_ms);
  const limit = normalizeLimit(input.limit, DEFAULT_GRAPH_LIMIT);
  const window = timelineWindow(input);
  const edges = listFilteredEdges(adapter, [input.ref], {
    visibility,
    edge_filters: input.edge_filters,
    as_of_ms: input.as_of_ms,
  }).filter((edge) => isInTimelineWindow(edge.created_at, window));

  const refs: TwinRef[] = [];
  const seenRefs = new Set<string>();
  addRef(refs, seenRefs, input.ref);
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

  return {
    ref: input.ref,
    events: events
      .sort(
        (left, right) =>
          left.at_ms - right.at_ms ||
          eventKindRank(left.kind) - eventKindRank(right.kind) ||
          eventKey(left).localeCompare(eventKey(right))
      )
      .slice(0, limit),
  };
}
