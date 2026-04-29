import { assertTwinRefsVisible, listVisibleTwinEdgesForRefs } from '../edges/ref-validation.js';
import type { TwinEdgeRecord, TwinRef, TwinVisibility } from '../edges/types.js';
import type {
  AgentGraphAdapter,
  AgentGraphEdgeFilters,
  AgentGraphPath,
  AgentGraphResult,
  GraphNeighborhoodInput,
  GraphPathsInput,
  GraphPathsResult,
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
  visibility: TwinVisibility
): void {
  try {
    assertTwinRefsVisible(adapter, refs, visibility);
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

export function getGraphNeighborhood(
  adapter: AgentGraphAdapter,
  input: GraphNeighborhoodInput
): AgentGraphResult {
  const depth = normalizeDepth(input.depth, 1);
  const limit = normalizeLimit(input.limit, DEFAULT_GRAPH_LIMIT);
  const visibility = graphVisibility(input);
  assertRefsVisible(adapter, [input.ref], visibility);

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
  assertRefsVisible(adapter, [input.from_ref, input.to_ref], visibility);

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
  assertRefsVisible(adapter, [input.ref], visibility);
  const limit = normalizeLimit(input.limit, DEFAULT_GRAPH_LIMIT);
  const edges = listFilteredEdges(adapter, [input.ref], {
    visibility,
    edge_filters: input.edge_filters,
    as_of_ms: input.as_of_ms,
  })
    .filter((edge) => input.from_ms === undefined || edge.created_at >= input.from_ms)
    .filter((edge) => input.to_ms === undefined || edge.created_at <= input.to_ms)
    .sort(
      (left, right) =>
        left.created_at - right.created_at || left.edge_id.localeCompare(right.edge_id)
    )
    .slice(0, limit);

  return {
    ref: input.ref,
    events: edges.map((edge) => ({ kind: 'edge', at_ms: edge.created_at, edge })),
  };
}
