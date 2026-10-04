/**
 * Graph Module - one memory record and what it links to
 * @module modules/graph
 *
 * The memory view picks a record from the saved timeline. This draws that record with its direct
 * links (the source messages it rests on, what it builds on, what it replaced), names every colour
 * and line in plain words, and shows the detail of whichever dot is clicked.
 */

/* eslint-env browser */
/* global vis */

import { escapeHtml, getElementByIdOrNull } from '../utils/dom.js';
import { DebugLogger } from '../utils/debug-logger.js';
import { API, type GraphNode, type GraphEdge } from '../utils/api.js';
import { renderSafeMarkdown } from '../utils/markdown.js';

type GraphNodeRecord = GraphNode & {
  topic?: string;
  decision?: string;
  reasoning?: string;
  created_at?: string | number;
};

type GraphEdgeRecord = GraphEdge & {
  from: GraphNodeRecord['id'];
  to: GraphNodeRecord['id'];
};

type EdgeStyle = {
  color: string;
  dashes: boolean | number[];
  width: number;
};

type GraphInput = {
  nodes: GraphNodeRecord[];
  edges: GraphEdgeRecord[];
  meta?: Record<string, unknown>;
};

const logger = new DebugLogger('Graph');

/** What each dot colour stands for, in the words the legend shows. */
export const KIND_LABELS: Record<string, string> = {
  decision: 'Decision',
  preference: 'Preference',
  constraint: 'Constraint',
  lesson: 'Lesson',
  workflow: 'Workflow',
  fact: 'Fact',
  commitment: 'Work update',
  observation: 'Source message',
  memory: 'Memory without a kind',
  registry: 'Registered name',
};

/** Every relation the engine stores, read from the record that holds the link. */
export const RELATION_LABELS: Record<string, string> = {
  derived_from: 'rests on (evidence)',
  mentions: 'mentions',
  builds_on: 'builds on',
  amends: 'amends',
  refines: 'refines',
  supersedes: 'replaces',
  contradicts: 'contradicts',
  debates: 'argues with',
  synthesizes: 'combines',
  case_member: 'belongs to case',
  alias_of: 'another name for',
  next_action_for: 'next step for',
  blocks: 'blocks',
};

const LABEL_LENGTH = 40;

function shortLabel(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > LABEL_LENGTH ? `${flat.slice(0, LABEL_LENGTH - 1)}…` : flat;
}

/**
 * Graph Module Class
 */
export class GraphModule {
  network: VisNetwork | null = null;
  graphData: GraphInput = { nodes: [], edges: [], meta: {} };
  centerId: string | null = null;
  // A slower earlier read must not draw or describe a record the owner has moved away from.
  private recordRequest = 0;
  private detailRequest = 0;
  nodeColors: Record<string, string> = {
    decision: '#60A5FA',
    preference: '#C084FC',
    constraint: '#FB7185',
    lesson: '#FBBF24',
    workflow: '#F472B6',
    fact: '#2DD4BF',
    commitment: '#FB923C',
    observation: '#94A3B8',
    memory: '#CBD5E1', // Legacy memories may have no stored classification.
    registry: '#A3E635',
  };
  edgeStyles: Record<string, EdgeStyle> = {
    supersedes: { color: '#666666', dashes: false, width: 2 },
    mentions: { color: '#6B4C9A', dashes: false, width: 2 },
    derived_from: { color: '#3A9E7E', dashes: false, width: 2 },
    amends: { color: '#2563EB', dashes: [8, 4], width: 2 },
    refines: { color: '#B8860B', dashes: false, width: 2 },
    builds_on: { color: '#B8860B', dashes: [5, 5], width: 2.5 },
    contradicts: { color: '#DC143C', dashes: false, width: 2.5 },
    debates: { color: '#DC143C', dashes: [5, 5], width: 2.5 },
    synthesizes: { color: '#6B4C9A', width: 3, dashes: false },
  };

  /**
   * Draw a record and its direct links, then show its detail.
   */
  async showRecord(id: string): Promise<void> {
    const request = ++this.recordRequest;
    const empty = getElementByIdOrNull<HTMLElement>('graph-empty');
    const loading = getElementByIdOrNull<HTMLElement>('graph-loading');
    if (empty) empty.style.display = 'none';
    if (loading) loading.style.display = 'flex';
    try {
      const data = (await API.getGraphNeighbors(id)) as GraphInput;
      if (request !== this.recordRequest) return;
      this.centerId = id;
      this.init(data);
      const center = data.nodes.find((node) => String(node.id) === id);
      if (center) void this.showDetail(center);
    } finally {
      if (loading && request === this.recordRequest) loading.style.display = 'none';
    }
  }

  /**
   * Initialize vis-network over one record's neighbourhood.
   */
  init(data: GraphInput): void {
    const container = getElementByIdOrNull<HTMLDivElement>('graph-canvas');
    if (!container) {
      logger.error('graph-canvas element not found');
      return;
    }
    this.graphData = data;
    this.network?.destroy?.();

    const nodes = data.nodes.map((n) => {
      const kind = n.kind ?? 'memory';
      const center = String(n.id) === this.centerId;
      const color = this.getNodeColor(kind);
      return {
        id: n.id,
        // Source messages stay unlabelled dots: their time and text are on hover and click.
        label:
          kind === 'observation' && !center
            ? undefined
            : shortLabel(String(n.decision_preview ?? n.decision ?? n.topic ?? n.id)),
        title: this.createNodeTooltip(n),
        color: {
          background: color,
          border: center ? '#131313' : color,
          highlight: { background: color, border: '#131313' },
        },
        size: center ? 22 : kind === 'observation' ? 9 : 14,
        borderWidth: center ? 3 : 1,
        font: { color: '#131313', size: center ? 15 : 13 },
        data: n,
      };
    });

    const edges = data.edges.map((e) => {
      const style = this.getEdgeStyle(e.relationship);
      return {
        from: e.from,
        to: e.to,
        arrows: { to: { enabled: true, scaleFactor: 0.5 } },
        color: style.color,
        dashes: style.dashes,
        width: style.width,
        title: this.relationLabel(e.relationship),
      };
    });

    this.network = new vis.Network(
      container,
      { nodes: new vis.DataSet(nodes), edges: new vis.DataSet(edges) },
      {
        nodes: { shape: 'dot' },
        edges: { smooth: { type: 'continuous', roundness: 0.5 }, width: 2 },
        physics: {
          enabled: true,
          barnesHut: {
            gravitationalConstant: -6000,
            centralGravity: 0.4,
            springLength: 140,
            springConstant: 0.04,
            damping: 0.09,
            avoidOverlap: 1,
          },
          stabilization: { enabled: true, iterations: 200, updateInterval: 25 },
        },
        interaction: { hover: true, tooltipDelay: 100, zoomView: true, dragView: true },
      }
    );

    this.network.on('click', (params: { nodes: Array<string | number> }) => {
      const targetId = params.nodes[0];
      if (targetId === undefined) return;
      const node = data.nodes.find((n) => String(n.id) === String(targetId));
      if (node) void this.showDetail(node);
    });
    // Stepping to a linked record redraws the graph around it.
    this.network.on('doubleClick', (params: { nodes: Array<string | number> }) => {
      const targetId = params.nodes[0];
      if (targetId !== undefined && String(targetId) !== this.centerId) {
        void this.showRecord(String(targetId));
      }
    });
    this.network.on('stabilizationIterationsDone', () => {
      this.network?.setOptions?.({ physics: { enabled: false } });
    });

    this.renderLegend();
    const legend = getElementByIdOrNull<HTMLElement>('legend-panel');
    legend?.classList.add('visible');
    const stats = getElementByIdOrNull<HTMLElement>('graph-stats');
    if (stats) {
      stats.style.display = '';
      stats.textContent = `${data.nodes.length} records and source messages · ${data.edges.length} links · click a dot for its detail, double-click to step to it`;
    }
  }

  // =============================================
  // Styling and legend
  // =============================================

  getNodeColor(kind = 'memory'): string {
    return this.nodeColors[kind] ?? '#CBD5E1';
  }

  getEdgeStyle(relationship?: string): EdgeStyle {
    return (
      this.edgeStyles[relationship ?? 'default'] ?? { color: '#4a4a6a', dashes: false, width: 2 }
    );
  }

  kindLabel(kind: string): string {
    return KIND_LABELS[kind] ?? kind;
  }

  relationLabel(relationship?: string): string {
    return relationship === undefined ? 'link' : (RELATION_LABELS[relationship] ?? relationship);
  }

  /** Count what is drawn, by kind and by relationship, with the words the legend shows. */
  getLegendEntries() {
    const kinds = new Map<string, number>();
    const relations = new Map<string, number>();
    for (const node of this.graphData.nodes) {
      const kind = node.kind ?? 'memory';
      kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
    }
    for (const edge of this.graphData.edges) {
      const relation = edge.relationship ?? 'default';
      relations.set(relation, (relations.get(relation) ?? 0) + 1);
    }
    return {
      nodes: [...kinds]
        .sort(([, a], [, b]) => b - a)
        .map(([kind, count]) => ({
          kind,
          label: this.kindLabel(kind),
          count,
          color: this.getNodeColor(kind),
        })),
      edges: [...relations]
        .sort(([, a], [, b]) => b - a)
        .map(([relationship, count]) => ({
          relationship,
          label: this.relationLabel(relationship),
          count,
          ...this.getEdgeStyle(relationship),
        })),
    };
  }

  renderLegend(): void {
    const container = getElementByIdOrNull<HTMLElement>('graph-legend-content');
    if (!container) return;
    const entries = this.getLegendEntries();
    const section = (title: string, rows: string[]) =>
      rows.length === 0
        ? ''
        : `<div><div class="legend-heading">${title}</div>${rows.join('')}</div>`;
    const row = (sample: string, label: string, count: number) =>
      `<div class="legend-row">${sample}<span class="legend-label">${escapeHtml(label)}</span><span class="legend-count">${count}</span></div>`;
    container.innerHTML =
      section(
        'Dots',
        entries.nodes.map(({ label, count, color }) =>
          row(`<span class="legend-dot" style="background:${color}"></span>`, label, count)
        )
      ) +
      section(
        'Lines (arrow points at what the record links to)',
        entries.edges.map(({ label, count, color, dashes, width }) => {
          const dash = Array.isArray(dashes) ? dashes.join(' ') : dashes ? '5 5' : 'none';
          return row(
            `<svg width="28" height="10" class="shrink-0" aria-hidden="true"><line x1="0" y1="5" x2="28" y2="5" stroke="${color}" stroke-width="${width}" stroke-dasharray="${dash}" /></svg>`,
            label,
            count
          );
        })
      );
    if (entries.nodes.length === 0) container.textContent = 'Nothing drawn';
  }

  createNodeTooltip(node: GraphNodeRecord): string {
    const kind = this.kindLabel(node.kind ?? 'memory');
    const text = String(node.decision_preview ?? node.decision ?? '');
    return `${kind}${node.topic ? ` · ${node.topic}` : ''}\n${text.slice(0, 160)}`;
  }

  // =============================================
  // Detail Panel
  // =============================================

  async showDetail(node: GraphNodeRecord): Promise<void> {
    const panel = getElementByIdOrNull<HTMLDivElement>('decision-detail-modal');
    const topicEl = getElementByIdOrNull<HTMLElement>('detail-topic');
    const kindEl = getElementByIdOrNull<HTMLElement>('detail-kind');
    const decisionEl = getElementByIdOrNull<HTMLElement>('detail-decision');
    const reasoningEl = getElementByIdOrNull<HTMLElement>('detail-reasoning');
    const createdEl = getElementByIdOrNull<HTMLElement>('detail-created');
    if (!panel || !decisionEl || !reasoningEl) {
      logger.error('Detail panel elements missing');
      return;
    }
    if (topicEl) topicEl.textContent = node.topic || this.kindLabel(node.kind ?? 'memory');
    if (kindEl) kindEl.textContent = this.kindLabel(node.kind ?? 'memory');
    if (createdEl) {
      createdEl.textContent = node.created_at ? new Date(node.created_at).toLocaleString() : '-';
    }
    decisionEl.innerHTML = '<span class="loading-similar">Loading details...</span>';
    reasoningEl.innerHTML = '';
    panel.classList.add('visible');

    const request = ++this.detailRequest;
    try {
      const detail = await API.getGraphDetail(String(node.id));
      if (request !== this.detailRequest) return;
      const detailNode = detail.node;
      decisionEl.innerHTML = renderSafeMarkdown(
        String(detailNode.decision || detailNode.decision_preview || '-')
      );
      reasoningEl.innerHTML = renderSafeMarkdown(String(detailNode.reasoning || '-'));
    } catch (error) {
      if (request !== this.detailRequest) return;
      logger.error('Failed to read record detail:', error);
      decisionEl.textContent = `Could not read this record: ${
        error instanceof Error ? error.message : String(error)
      }`;
    }
  }
}
