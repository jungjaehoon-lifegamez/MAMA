/**
 * Graph Module - the filtered memory as a graph
 * @module modules/graph
 *
 * The memory view's list and graph show the same records: whatever the period, kind and search
 * select. One dot per record, one per work item for its updates in the period, and faded dots for
 * the records they link to outside the filter. Lines are the links between records; the source
 * messages a record rests on are listed in its detail.
 */

/* eslint-env browser */
/* global vis */

import { escapeHtml, getElementByIdOrNull } from '../utils/dom.js';
import { DebugLogger } from '../utils/debug-logger.js';
import { API, type MemoryLinks, type MemoryTimelineResponse } from '../utils/api.js';
import { renderSafeMarkdown } from '../utils/markdown.js';
import { groupInfo } from './memory-timeline.js';

type EdgeStyle = {
  color: string;
  dashes: boolean | number[];
  width: number;
};

const logger = new DebugLogger('Graph');

/** What a record's stored kind is called in the detail panel. */
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

const OUTSIDE_COLOR = '#D1D5DB';
const LABEL_LENGTH = 40;

function shortLabel(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > LABEL_LENGTH ? `${flat.slice(0, LABEL_LENGTH - 1)}…` : flat;
}

export interface FilterGraphNode {
  id: string;
  /** The timeline group of a selected dot, or `outside` for a linked record the filter left out. */
  group: string;
  kind: string | null;
  label: string;
  /** The record whose detail a click opens: the record itself, or a work item's latest update. */
  detailId: string;
  /** Updates of a work item inside the period. */
  updates: number;
  outside: boolean;
}

export interface FilterGraph {
  nodes: FilterGraphNode[];
  edges: Array<{ from: string; to: string; relation: string }>;
  /** Which dot each listed record is drawn as: a work update is drawn as its item. */
  recordNode: Record<string, string>;
}

/**
 * The graph of what the filters selected. A work item is one dot for all its updates; a link
 * between two updates of one item is not drawn, and a link that touches nothing selected is left
 * out. Days arrive newest first, so an item's first update seen is its latest.
 */
export function composeFilterGraph(
  timeline: MemoryTimelineResponse,
  links: MemoryLinks
): FilterGraph {
  const nodes = new Map<string, FilterGraphNode>();
  const recordNode: Record<string, string> = {};
  for (const day of timeline.days) {
    for (const group of day.groups) {
      for (const record of group.records ?? []) {
        nodes.set(record.id, {
          id: record.id,
          group: group.group,
          kind: record.kind,
          label: record.topic,
          detailId: record.id,
          updates: 0,
          outside: false,
        });
        recordNode[record.id] = record.id;
      }
      for (const item of group.items ?? []) {
        const id = `item:${item.commitmentId}`;
        const node = nodes.get(id) ?? {
          id,
          group: 'work',
          kind: 'commitment',
          label: item.title ?? item.topic,
          detailId: item.revisions[0].id,
          updates: 0,
          outside: false,
        };
        node.updates += item.revisions.length;
        nodes.set(id, node);
        for (const revision of item.revisions) recordNode[revision.id] = id;
      }
    }
  }
  // Links name both ends with a node; a work update outside the filter is drawn as its item.
  const dotFor = (ref: string): string => {
    const listed = recordNode[ref];
    if (listed !== undefined) return listed;
    const commitmentId = links.nodes[ref].commitmentId;
    return commitmentId === null ? ref : `item:${commitmentId}`;
  };
  const edges: FilterGraph['edges'] = [];
  const seen = new Set<string>();
  const outside: FilterGraphNode[] = [];
  for (const link of links.edges) {
    const from = dotFor(link.from);
    const to = dotFor(link.to);
    const key = `${from}\0${to}\0${link.relation}`;
    if (from === to || seen.has(key) || (!nodes.has(from) && !nodes.has(to))) continue;
    seen.add(key);
    edges.push({ from, to, relation: link.relation });
    for (const [dot, ref] of [
      [from, link.from],
      [to, link.to],
    ] as const) {
      if (nodes.has(dot)) continue;
      const node: FilterGraphNode = {
        id: dot,
        group: 'outside',
        kind: links.nodes[ref].kind,
        label: links.nodes[ref].label,
        detailId: ref,
        updates: 0,
        outside: true,
      };
      nodes.set(dot, node);
      outside.push(node);
    }
  }
  return {
    nodes: [...nodes.values()].filter((node) => !node.outside).concat(outside),
    edges,
    recordNode,
  };
}

/**
 * Graph Module Class
 */
export class GraphModule {
  network: VisNetwork | null = null;
  graph: FilterGraph = { nodes: [], edges: [], recordNode: {} };
  // The links between records do not depend on the filter: read once per page load.
  private links: Promise<MemoryLinks> | null = null;
  // A slower earlier read must not draw or describe what the owner has moved away from.
  private drawRequest = 0;
  private detailRequest = 0;
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
   * Draw what the filters selected, from the same timeline answer the list shows.
   */
  async showSelection(timeline: MemoryTimelineResponse): Promise<void> {
    const request = ++this.drawRequest;
    // A failed read is not kept: the next filter change reads the links again.
    this.links ??= API.getMemoryLinks().catch((error: unknown) => {
      this.links = null;
      throw error;
    });
    const links = await this.links;
    if (request !== this.drawRequest) return;
    this.init(composeFilterGraph(timeline, links));
  }

  /**
   * A listed record was picked: select its dot and open the record's own detail.
   */
  focusRecord(recordId: string): void {
    const dot = this.graph.recordNode[recordId];
    const node = this.graph.nodes.find((candidate) => candidate.id === dot);
    if (this.network && dot !== undefined) {
      this.network.selectNodes([dot]);
      this.network.focus(dot, { scale: 1.2, animation: { duration: 400 } });
    }
    void this.showDetail({
      detailId: recordId,
      label: node?.label ?? recordId,
      kind: node?.kind ?? null,
    });
  }

  init(graph: FilterGraph): void {
    const container = getElementByIdOrNull<HTMLDivElement>('graph-canvas');
    if (!container) {
      logger.error('graph-canvas element not found');
      return;
    }
    this.graph = graph;
    this.network?.destroy?.();

    const empty = getElementByIdOrNull<HTMLElement>('graph-empty');
    if (empty) {
      empty.style.display = graph.nodes.length === 0 ? '' : 'none';
      empty.textContent = 'Nothing saved for this filter.';
    }

    const nodes = graph.nodes.map((node) => {
      const color = node.outside ? OUTSIDE_COLOR : groupInfo(node.group).color;
      return {
        id: node.id,
        label: shortLabel(node.label),
        title: this.createNodeTooltip(node),
        color: {
          background: color,
          border: color,
          highlight: { background: color, border: '#131313' },
        },
        size: node.outside ? 7 : node.updates > 0 ? 10 + Math.min(node.updates, 20) / 2 : 11,
        font: { color: node.outside ? '#9CA3AF' : '#131313', size: 12 },
      };
    });
    const edges = graph.edges.map((edge) => {
      const style = this.getEdgeStyle(edge.relation);
      return {
        from: edge.from,
        to: edge.to,
        arrows: { to: { enabled: true, scaleFactor: 0.5 } },
        color: style.color,
        dashes: style.dashes,
        width: style.width,
        title: this.relationLabel(edge.relation),
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
            gravitationalConstant: -4000,
            centralGravity: 0.5,
            springLength: 120,
            springConstant: 0.04,
            damping: 0.09,
            avoidOverlap: 0.6,
          },
          stabilization: { enabled: true, iterations: 200, updateInterval: 25 },
        },
        interaction: { hover: true, tooltipDelay: 100, zoomView: true, dragView: true },
      }
    );
    this.network.on('click', (params: { nodes: Array<string | number> }) => {
      const node = graph.nodes.find((candidate) => candidate.id === String(params.nodes[0]));
      if (node) void this.showDetail(node);
    });
    this.network.on('stabilizationIterationsDone', () => {
      this.network?.setOptions?.({ physics: { enabled: false } });
    });

    this.renderLegend();
    getElementByIdOrNull<HTMLElement>('legend-panel')?.classList.add('visible');
    const stats = getElementByIdOrNull<HTMLElement>('graph-stats');
    if (stats) {
      const selected = graph.nodes.filter((node) => !node.outside).length;
      const outside = graph.nodes.length - selected;
      stats.style.display = '';
      stats.textContent = `${selected} records and work items · ${graph.edges.length} links${
        outside === 0 ? '' : ` · ${outside} linked records outside this filter, faded`
      } · click a dot for its detail`;
    }
  }

  // =============================================
  // Styling and legend
  // =============================================

  getEdgeStyle(relationship?: string): EdgeStyle {
    return (
      this.edgeStyles[relationship ?? 'default'] ?? { color: '#4a4a6a', dashes: false, width: 2 }
    );
  }

  kindLabel(kind: string | null): string {
    return kind === null ? KIND_LABELS.memory : (KIND_LABELS[kind] ?? kind);
  }

  relationLabel(relationship: string): string {
    return RELATION_LABELS[relationship] ?? relationship;
  }

  /** Count what is drawn, by group and by relationship, with the words the legend shows. */
  getLegendEntries() {
    const groups = new Map<string, number>();
    const relations = new Map<string, number>();
    for (const node of this.graph.nodes) {
      groups.set(node.group, (groups.get(node.group) ?? 0) + 1);
    }
    for (const edge of this.graph.edges) {
      relations.set(edge.relation, (relations.get(edge.relation) ?? 0) + 1);
    }
    return {
      nodes: [...groups].map(([group, count]) => ({
        group,
        label: group === 'outside' ? 'Linked, outside this filter' : groupInfo(group).label,
        count,
        color: group === 'outside' ? OUTSIDE_COLOR : groupInfo(group).color,
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
        'Dots (a work item is one dot for its updates)',
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

  createNodeTooltip(node: FilterGraphNode): string {
    const group = node.outside ? 'Linked, outside this filter' : groupInfo(node.group).label;
    const updates = node.updates > 0 ? `\n${node.updates} updates in this period` : '';
    return `${group} · ${this.kindLabel(node.kind)}\n${node.label.slice(0, 160)}${updates}`;
  }

  // =============================================
  // Detail Panel
  // =============================================

  async showDetail(target: Pick<FilterGraphNode, 'detailId' | 'label' | 'kind'>): Promise<void> {
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
    if (topicEl) topicEl.textContent = target.label;
    if (kindEl) kindEl.textContent = this.kindLabel(target.kind);
    if (createdEl) createdEl.textContent = '-';
    decisionEl.innerHTML = '<span class="loading-similar">Loading details...</span>';
    reasoningEl.innerHTML = '';
    panel.classList.add('visible');

    const request = ++this.detailRequest;
    try {
      const detail = await API.getGraphDetail(target.detailId);
      if (request !== this.detailRequest) return;
      const detailNode = detail.node;
      if (createdEl && detailNode.created_at) {
        createdEl.textContent = new Date(detailNode.created_at).toLocaleString();
      }
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
