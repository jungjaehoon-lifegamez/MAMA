import { describe, expect, it } from 'vitest';

import {
  DEFAULT_GRAPH_LIMIT,
  buildGraphMeta,
  filterEdgesByNodes,
  mapDecisionRowToGraphNode,
  parseGraphLimit,
} from '../../src/api/graph-api.js';

describe('graph api helpers', () => {
  it('should map decision rows to lightweight overview nodes', () => {
    const node = mapDecisionRowToGraphNode({
      id: 'decision_1',
      topic: 'topic_one',
      decision: 'A'.repeat(400),
      reasoning: 'B'.repeat(800),
      outcome: 'success',
      confidence: 0.9,
      created_at: 123,
    });

    expect(node.id).toBe('decision_1');
    expect(node.topic).toBe('topic_one');
    expect(node.outcome).toBe('success');
    expect(node.confidence).toBe(0.9);
    expect(node.created_at).toBe(123);
    expect(node.decision).toBeUndefined();
    expect(node.reasoning).toBeUndefined();
    expect(node.decision_preview?.length).toBeLessThanOrEqual(223);
  });

  it('should default graph limit for overview requests', () => {
    expect(parseGraphLimit(new URLSearchParams())).toBe(DEFAULT_GRAPH_LIMIT);
    expect(parseGraphLimit(new URLSearchParams('limit=120'))).toBe(120);
    expect(parseGraphLimit(new URLSearchParams('full=true'))).toBeNull();
  });

  it('should build compact graph metadata for overview responses', () => {
    expect(
      buildGraphMeta({
        totalNodes: 900,
        totalEdges: 1200,
        similarityEdges: 0,
        isPartial: true,
        returnedNodes: 300,
        returnedEdges: 180,
      })
    ).toEqual({
      total_nodes: 300,
      total_edges: 180,
      similarity_edges: 0,
      partial: true,
      total_available_nodes: 900,
      total_available_edges: 1200,
    });
  });

  it('should filter edges down to the nodes shown in a partial graph', () => {
    const nodes = [{ id: 'a' }, { id: 'b' }] as Array<{ id: string }>;
    const edges = [
      { from: 'a', to: 'b', relationship: 'builds_on', reason: null },
      { from: 'x', to: 'y', relationship: 'builds_on', reason: null },
    ];

    const filtered = filterEdgesByNodes(edges, nodes as never);
    expect(filtered).toEqual([{ from: 'a', to: 'b', relationship: 'builds_on', reason: null }]);
  });
});
