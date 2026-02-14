/* global marked */
/**
 * Graph Module - Decision Graph Visualization
 * @module modules/graph
 * @version 1.0.0
 *
 * Handles Graph visualization using vis.js:
 * - Network initialization and rendering
 * - Node/edge styling and clustering
 * - Search and filter functionality
 * - Detail panel for node information
 * - BFS traversal for connected nodes
 */

/* eslint-env browser */
/* global vis */

import {
  escapeHtml,
  debounce,
  showToast,
  getElementByIdOrNull,
  getErrorMessage,
} from '../utils/dom.js';
import { DebugLogger } from '../utils/debug-logger.js';
import { API, type GraphNode, type GraphEdge, type SimilarDecision } from '../utils/api.js';

type GraphNodeRecord = GraphNode & {
  topic?: string;
  outcome?: string;
  decision?: string;
  reasoning?: string;
  confidence?: number;
  created_at?: string;
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

type ConnectedEdges = {
  outgoing: GraphEdgeRecord[];
  incoming: GraphEdgeRecord[];
  all: GraphEdgeRecord[];
};

type GraphInput = {
  nodes: GraphNodeRecord[];
  edges: GraphEdgeRecord[];
  meta?: Record<string, unknown>;
};

const logger = new DebugLogger('Graph');

/**
 * Graph Module Class
 */
export class GraphModule {
  network: VisNetwork | null = null;
  graphData: GraphInput = { nodes: [], edges: [], meta: {} };
  currentNodeId: string | null = null;
  adjacencyList: Map<string, string[]> = new Map();
  searchMatches: GraphNodeRecord[] = [];
  currentSearchIndex = 0;
  debouncedSearch = debounce(() => this.search(), 300);
  topicColors: Record<string, string> = {};
  colorPalette = [
    '#FFCE00', // mama yellow (primary)
    '#E6B800', // mama yellow-hover
    '#FF9999', // mama blush
    '#D4C4E0', // mama lavender-dark
    '#22c55e', // success green
    '#f97316', // warning orange
    '#06b6d4', // info cyan
    '#8b5cf6', // purple accent
    '#ec4899', // pink accent
    '#f59e0b', // amber
    '#10b981', // teal
    '#0ea5e9', // sky blue
  ];
  colorIndex = 0;
  edgeStyles: Record<string, EdgeStyle> = {
    supersedes: { color: '#666666', dashes: false, width: 2 },
    builds_on: { color: '#B8860B', dashes: [5, 5], width: 2.5 }, // dark goldenrod
    debates: { color: '#DC143C', dashes: [5, 5], width: 2.5 }, // crimson
    synthesizes: { color: '#6B4C9A', width: 3, dashes: false }, // dark purple
  };

  constructor() {
    // Network state
  }

  // =============================================
  // Data Loading
  // =============================================

  /**
   * Fetch graph data from API
   */
  async fetchData(): Promise<GraphInput> {
    try {
      this.graphData = await API.getGraph();
      logger.info('Graph data loaded:', this.graphData.meta);
      return this.graphData;
    } catch (error) {
      logger.error('Failed to fetch graph:', error);
      throw error;
    }
  }

  // =============================================
  // Graph Initialization
  // =============================================

  /**
   * Initialize vis-network
   */
  init(data: GraphInput): void {
    const container = getElementByIdOrNull<HTMLDivElement>('graph-canvas');
    if (!container) {
      logger.error('graph-canvas element not found');
      return;
    }

    // Ensure container has dimensions for vis-network
    if (container.offsetHeight === 0) {
      container.style.minHeight = '400px';
    }

    logger.debug('Graph canvas dimensions:', container.offsetWidth, 'x', container.offsetHeight);

    this.graphData = data;

    // Build adjacency list for BFS
    this.buildAdjacencyList(data.edges);

    // Calculate connection counts for sizing
    const connectionCounts = this.calculateConnectionCounts(data.nodes, data.edges);

    // Map nodes to vis-network format
    const nodes = data.nodes.map((n) => ({
      id: n.id,
      label: n.topic || String(n.id).substring(0, 20),
      title: this.createNodeTooltip(n),
      color: {
        background: this.getTopicColor(n.topic),
        border: this.getOutcomeBorderColor(n.outcome),
        highlight: { background: this.getTopicColor(n.topic), border: '#fff' },
      },
      size: this.getNodeSize(connectionCounts[String(n.id)] || 0),
      font: { color: '#131313', size: 12 },
      borderWidth: 3,
      data: n,
    }));

    // Map edges to vis-network format
    const edges = data.edges.map((e) => {
      const style = this.getEdgeStyle(e.relationship);
      return {
        from: e.from,
        to: e.to,
        arrows: { to: { enabled: true, scaleFactor: 0.5 } },
        color: style.color,
        dashes: style.dashes,
        width: style.width || 2,
        title: e.relationship,
      };
    });

    const networkData = {
      nodes: new vis.DataSet(nodes),
      edges: new vis.DataSet(edges),
    };

    const options = {
      nodes: {
        shape: 'dot',
        scaling: { min: 10, max: 30 },
      },
      edges: {
        smooth: { type: 'continuous', roundness: 0.5 },
        width: 2,
      },
      physics: {
        enabled: true,
        barnesHut: {
          gravitationalConstant: -8000,
          centralGravity: 0.3,
          springLength: 150,
          springConstant: 0.04,
          damping: 0.09,
          avoidOverlap: 0.5,
        },
        stabilization: {
          enabled: true,
          iterations: 200,
          updateInterval: 50,
        },
      },
      interaction: {
        hover: true,
        tooltipDelay: 200,
        zoomView: true,
        dragView: true,
      },
    };

    this.network = new vis.Network(container, networkData, options);

    // Event handlers
    this.network.on('click', (params: { nodes: Array<string | number> }) => {
      try {
        if (params.nodes.length > 0) {
          const nodeId = params.nodes[0];
          const targetId = String(nodeId);
          const node = data.nodes.find((n) => String(n.id) === targetId);
          if (node) {
            logger.debug('Node clicked:', nodeId, node);
            this.showDetail(node);
            this.highlightConnectedNodes(targetId);
          }
        } else {
          this.closeDetail();
          this.resetNodeHighlight();
        }
      } catch (error) {
        logger.error('Error handling click:', error);
        if (error instanceof Error && error.stack) {
          logger.error('Error stack:', error.stack);
        }
      }
    });

    this.network.on('stabilized', () => {
      const loadingEl = getElementByIdOrNull<HTMLElement>('graph-loading');
      if (loadingEl) {
        loadingEl.style.display = 'none';
      }
      logger.info('Graph stabilized');
    });

    // Backup: hide loading after 3 seconds even if stabilization doesn't complete
    setTimeout(() => {
      const loadingEl = getElementByIdOrNull<HTMLElement>('graph-loading');
      if (loadingEl && loadingEl.style.display !== 'none') {
        loadingEl.style.display = 'none';
        logger.warn('Graph loading hidden by timeout');
      }
    }, 3000);

    // Populate topic filter
    const topics = [...new Set(data.nodes.map((n) => n.topic || ''))].sort();
    this.populateTopicFilter(topics);

    logger.info('Graph initialized with', nodes.length, 'nodes and', edges.length, 'edges');
  }

  // =============================================
  // Styling Utilities
  // =============================================

  /**
   * Get color for topic
   */
  getTopicColor(topic = ''): string {
    if (!this.topicColors[topic]) {
      this.topicColors[topic] = this.colorPalette[this.colorIndex % this.colorPalette.length];
      this.colorIndex++;
    }
    return this.topicColors[topic];
  }

  /**
   * Get border color based on outcome
   */
  getOutcomeBorderColor(outcome?: string): string {
    switch (outcome?.toLowerCase()) {
      case 'success':
        return '#22c55e';
      case 'failed':
        return '#ef4444';
      case 'partial':
        return '#f59e0b';
      default:
        return '#4a4a6a';
    }
  }

  /**
   * Get edge style by relationship type
   */
  getEdgeStyle(relationship?: string): EdgeStyle {
    return (
      this.edgeStyles[relationship || 'default'] || { color: '#4a4a6a', dashes: false, width: 2 }
    );
  }

  /**
   * Get node size based on connection count
   */
  getNodeSize(connectionCount: number): number {
    if (connectionCount <= 2) {
      return 12;
    }
    if (connectionCount <= 5) {
      return 18;
    }
    if (connectionCount <= 10) {
      return 24;
    }
    return 30;
  }

  /**
   * Create node tooltip
   */
  createNodeTooltip(node: GraphNodeRecord): string {
    return `
      <strong>${escapeHtml(node.topic || 'Unknown')}</strong><br>
      Decision: ${escapeHtml((node.decision || '').substring(0, 100))}...<br>
      Outcome: ${node.outcome || 'PENDING'}<br>
      Confidence: ${Math.round((node.confidence || 0) * 100)}%
    `;
  }

  // =============================================
  // Data Processing
  // =============================================

  /**
   * Build adjacency list for BFS
   */
  buildAdjacencyList(edges: GraphEdgeRecord[]): void {
    this.adjacencyList = new Map();

    edges.forEach((edge) => {
      const from = String(edge.from);
      const to = String(edge.to);

      if (!this.adjacencyList.has(from)) {
        this.adjacencyList.set(from, []);
      }
      if (!this.adjacencyList.has(to)) {
        this.adjacencyList.set(to, []);
      }
      this.adjacencyList.get(from).push(to);
      this.adjacencyList.get(to).push(from);
    });

    logger.debug('Adjacency list built with', this.adjacencyList.size, 'nodes');
  }

  /**
   * Calculate connection count for each node
   */
  calculateConnectionCounts(
    nodes: GraphNodeRecord[],
    edges: GraphEdgeRecord[]
  ): Record<string, number> {
    const counts: Record<string, number> = {};
    nodes.forEach((n) => {
      counts[String(n.id)] = 0;
    });

    edges.forEach((edge) => {
      const from = String(edge.from);
      const to = String(edge.to);
      if (counts[from] !== undefined) {
        counts[from]++;
      }
      if (counts[to] !== undefined) {
        counts[to]++;
      }
    });

    return counts;
  }

  // =============================================
  // Graph Traversal & Highlighting
  // =============================================

  /**
   * Get connected node IDs using BFS
   */
  getConnectedNodeIds(nodeId: string, maxDepth = 3): string[] {
    const visited = new Set<string>();
    const queue: { id: string; depth: number }[] = [{ id: nodeId, depth: 0 }];
    visited.add(nodeId);

    while (queue.length > 0) {
      const next = queue.shift();
      if (!next) {
        continue;
      }
      const { id, depth } = next;

      if (depth >= maxDepth) {
        continue;
      }

      const neighbors = this.adjacencyList.get(id) || [];
      neighbors.forEach((neighborId) => {
        if (!visited.has(neighborId)) {
          visited.add(neighborId);
          queue.push({ id: neighborId, depth: depth + 1 });
        }
      });
    }

    return Array.from(visited);
  }

  /**
   * Highlight connected nodes
   */
  highlightConnectedNodes(nodeId: string | number): void {
    const targetId = String(nodeId);
    if (!this.network) {
      return;
    }

    const connectedIds = this.getConnectedNodeIds(targetId, 3);
    const allNodes = this.network.body.data.nodes.get();

    allNodes.forEach((node) => {
      const isConnected = connectedIds.includes(String(node.id));
      const opacity = isConnected ? 1.0 : 0.2;

      this.network.body.data.nodes.update({
        id: node.id,
        opacity: opacity,
        font: { ...node.font, color: isConnected ? '#131313' : '#999' },
      });
    });

    const allEdges = this.network.body.data.edges.get();
    allEdges.forEach((edge) => {
      const isConnected =
        connectedIds.includes(String(edge.from)) && connectedIds.includes(String(edge.to));
      this.network.body.data.edges.update({
        id: edge.id,
        opacity: isConnected ? 1.0 : 0.1,
      });
    });
  }

  /**
   * Reset node highlight
   */
  resetNodeHighlight(): void {
    if (!this.network) {
      return;
    }

    const allNodes = this.network.body.data.nodes.get();
    allNodes.forEach((node) => {
      this.network.body.data.nodes.update({
        id: node.id,
        opacity: 1.0,
        font: { ...node.font, color: '#131313' },
      });
    });

    const allEdges = this.network.body.data.edges.get();
    allEdges.forEach((edge) => {
      this.network.body.data.edges.update({
        id: edge.id,
        opacity: 1.0,
      });
    });
  }

  // =============================================
  // Detail Panel
  // =============================================

  /**
   * Show node detail panel
   */
  async showDetail(node: GraphNodeRecord): Promise<void> {
    try {
      logger.debug('showDetail called with node:', node);
      this.currentNodeId = String(node.id);
      const panel = getElementByIdOrNull<HTMLDivElement>('decision-detail-modal');

      if (!panel) {
        logger.error('decision-detail-modal element not found');
        return;
      }

      // Update existing DOM elements with markdown rendering
      const topicEl = getElementByIdOrNull<HTMLElement>('detail-topic');
      const decisionEl = getElementByIdOrNull<HTMLElement>('detail-decision');
      const reasoningEl = getElementByIdOrNull<HTMLElement>('detail-reasoning');
      if (!decisionEl || !reasoningEl) {
        logger.error('Required detail elements missing');
        return;
      }
      if (topicEl) {
        topicEl.textContent = node.topic || 'Unknown Topic';
      }

      // Use marked for markdown if available (textContent to avoid XSS)
      if (typeof marked !== 'undefined' && marked.parse) {
        try {
          const renderedDecision = marked.parse(node.decision || '-', {
            mangle: false,
            headerIds: false,
          });
          const renderedReasoning = marked.parse(node.reasoning || '-', {
            mangle: false,
            headerIds: false,
          });
          decisionEl.innerHTML = renderedDecision;
          reasoningEl.innerHTML = renderedReasoning;
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          showToast(`Markdown render failed: ${message}`);
          logger.warn('[Graph] Markdown parse failed:', e);
          decisionEl.textContent = node.decision || '-';
          reasoningEl.textContent = node.reasoning || '-';
        }
      } else {
        decisionEl.textContent = node.decision || '-';
        reasoningEl.textContent = node.reasoning || '-';
      }

      const outcomeSelect = getElementByIdOrNull<HTMLSelectElement>('detail-outcome-select');
      if (outcomeSelect) {
        outcomeSelect.value = (node.outcome || 'PENDING').toUpperCase();
      }

      // Clear outcome status
      const outcomeStatus = getElementByIdOrNull<HTMLElement>('outcome-status');
      if (outcomeStatus) {
        outcomeStatus.textContent = '';
        outcomeStatus.className = '';
      }

      const confidenceEl = getElementByIdOrNull<HTMLElement>('detail-confidence');
      if (confidenceEl) {
        confidenceEl.textContent = node.confidence ? `${(node.confidence * 100).toFixed(0)}%` : '-';
      }

      const createdEl = getElementByIdOrNull<HTMLElement>('detail-created');
      if (createdEl) {
        createdEl.textContent = node.created_at ? new Date(node.created_at).toLocaleString() : '-';
      }

      // Reset reasoning toggle
      const reasoningArrow = getElementByIdOrNull<HTMLElement>('reasoning-arrow');
      if (reasoningArrow) {
        reasoningArrow.textContent = '▶';
      }
      reasoningEl.classList.add('hidden');

      // Show loading state for similar decisions
      const similarEl = getElementByIdOrNull<HTMLElement>('detail-similar');
      if (similarEl) {
        similarEl.innerHTML = '<span class="loading-similar">Searching...</span>';
      }

      // Show panel
      panel.classList.add('visible');

      // Fetch similar decisions
      logger.info('Fetching similar decisions...');
      await this.fetchSimilarDecisions(String(node.id));
      logger.debug('showDetail completed successfully');
    } catch (error) {
      logger.error('Error in showDetail:', error);
      if (error instanceof Error && error.stack) {
        logger.error('Error stack:', error.stack);
      }
      logger.error('Node data:', node);
    }
  }

  /**
   * Get outcome icon name
   */
  getOutcomeIcon(outcome?: string): string {
    const outcomeMap = {
      pending: 'clock',
      success: 'check-circle',
      failed: 'x-circle',
      partial: 'alert-circle',
    };
    return outcomeMap[(outcome || 'pending').toLowerCase()] || 'clock';
  }

  /**
   * Toggle reasoning full text
   */
  toggleReasoning(): void {
    const arrow = getElementByIdOrNull<HTMLElement>('reasoning-arrow');
    const content = getElementByIdOrNull<HTMLElement>('detail-reasoning');
    if (arrow && content) {
      const isHidden = content.classList.contains('hidden');
      content.classList.toggle('hidden');
      arrow.textContent = isHidden ? '▼' : '▶';
    }
  }

  /**
   * Close detail panel
   */
  closeDetail(): void {
    const panel = getElementByIdOrNull<HTMLDivElement>('decision-detail-modal');
    if (panel) {
      panel.classList.remove('visible');
    }
    this.currentNodeId = null;
    this.resetNodeHighlight();
  }

  /**
   * Fetch similar decisions
   */
  async fetchSimilarDecisions(nodeId: string): Promise<void> {
    logger.debug('fetchSimilarDecisions called for node:', nodeId);
    const container = getElementByIdOrNull<HTMLElement>('detail-similar');

    if (!container) {
      logger.warn('detail-similar element not found');
      return;
    }

    try {
      logger.info('Calling API.getSimilarDecisions...');
      const data = await API.getSimilarDecisions(nodeId);
      logger.debug('Similar decisions received:', data);

      const similar = (data.similar || []) as SimilarDecision[];

      if (similar.length === 0) {
        logger.debug('[MAMA] No similar decisions found');
        container.innerHTML = '<span style="color:#666">No similar decisions found</span>';
        return;
      }

      logger.debug('[MAMA] Building similar decisions HTML for', similar.length, 'items');
      const html = similar
        .map(
          (s) => `
          <button class="similar-decision-btn w-full text-left p-2 mb-2 bg-gray-100 dark:bg-gray-800 hover:bg-indigo-100 dark:hover:bg-indigo-900/30 border border-gray-200 dark:border-gray-700 rounded-lg transition-colors" data-node-id="${escapeHtml(String(s.id))}">
            <div class="text-xs font-semibold text-indigo-600 dark:text-indigo-400">${escapeHtml(
              String(s.topic || '')
            )}</div>
            <div class="text-xs text-gray-600 dark:text-gray-400 mt-1 line-clamp-2">${escapeHtml(
              String(s.decision || '').substring(0, 80)
            )}...</div>
            <div class="text-xs text-gray-500 mt-1">${Math.round((s.similarity || 0) * 100)}% match</div>
          </button>
        `
        )
        .join('');

      logger.debug('[MAMA] Setting similar decisions HTML');
      container.innerHTML = html;

      // Bind click handlers via event delegation (avoid inline onclick)
      container.addEventListener('click', (e: Event) => {
        const target = e.target as HTMLElement;
        const btn = target.closest('.similar-decision-btn') as HTMLElement | null;
        if (btn && btn.dataset.nodeId) {
          this.navigateToNode(btn.dataset.nodeId);
        }
      });
      logger.debug('[MAMA] fetchSimilarDecisions completed');
    } catch (error) {
      const message = getErrorMessage(error);
      logger.error('[MAMA] Failed to fetch similar decisions:', message, error);
      if (error instanceof Error && error.stack) {
        logger.error('Error stack:', error.stack);
      }
      container.innerHTML = '<span style="color:#f66">Failed to load</span>';
    }
  }

  /**
   * Save outcome for current node
   */
  async saveOutcome(): Promise<void> {
    const select = getElementByIdOrNull<HTMLSelectElement>('detail-outcome-select');
    if (!select) {
      return;
    }
    const newOutcome = select.value;

    if (!this.currentNodeId || !newOutcome) {
      return;
    }

    try {
      await API.updateOutcome(this.currentNodeId, newOutcome);

      // Update local data
      const node = this.graphData.nodes.find((n) => String(n.id) === this.currentNodeId);
      if (node) {
        node.outcome = newOutcome.toUpperCase();

        // Update visualization
        this.network.body.data.nodes.update({
          id: this.currentNodeId,
          color: {
            border: this.getOutcomeBorderColor(newOutcome),
          },
        });

        // Refresh detail panel
        this.showDetail(node);
      }

      logger.debug('[MAMA] Outcome updated:', this.currentNodeId, newOutcome);
    } catch (error) {
      const message = getErrorMessage(error);
      logger.error('[MAMA] Failed to update outcome:', message);
      alert(`Failed to update outcome: ${message}`);
    }
  }

  // =============================================
  // Navigation
  // =============================================

  /**
   * Navigate to specific node
   */
  async navigateToNode(nodeId: string | number): Promise<void> {
    if (!this.network) {
      return;
    }

    let nodeIdString = String(nodeId);

    // Try exact match first
    let node = this.graphData.nodes.find((n) => String(n.id) === nodeIdString);

    // If not found, try partial match (for short IDs from checkpoints)
    if (!node) {
      logger.debug('[MAMA] Exact match not found, trying partial match for:', nodeIdString);
      node = this.graphData.nodes.find((n) => String(n.id).startsWith(nodeIdString));

      if (node) {
        logger.debug('[MAMA] Found node via partial match:', node.id);
        nodeIdString = String(node.id); // Update to the full ID
      }
    }

    // If node not in current graph, reload without filters
    if (!node) {
      logger.warn('[MAMA] Node not in current graph, reloading all nodes...');

      // Reset topic filter
      const topicFilter = getElementByIdOrNull<HTMLSelectElement>('topic-filter');
      if (topicFilter) {
        topicFilter.value = '';
      }

      // Reload graph: fetch fresh data and reinitialize
      await this.fetchData();
      this.init(this.graphData);

      // Try exact match again
      node = this.graphData.nodes.find((n) => String(n.id) === nodeIdString);

      // If still not found, try partial match
      if (!node) {
        node = this.graphData.nodes.find((n) => String(n.id).startsWith(nodeIdString));
        if (node) {
          logger.debug('[MAMA] Found node via partial match after reload:', node.id);
          nodeIdString = String(node.id);
        }
      }

      if (!node) {
        logger.warn('[MAMA] Node not found even after reload:', nodeIdString);
        showToast('⚠️ Decision not found in graph');
        return;
      }
    }

    // Focus on node (use resolved nodeIdString, not original nodeId)
    this.network.focus(nodeIdString, {
      scale: 1.5,
      animation: { duration: 500, easingFunction: 'easeInOutQuad' },
    });

    // Select node (triggers click event)
    this.network.selectNodes([nodeIdString]);

    // Show detail
    this.showDetail(node);
    this.highlightConnectedNodes(nodeIdString);
  }

  /**
   * Get connected edge types
   */
  getConnectedEdges(nodeId: string): ConnectedEdges {
    const edges = this.graphData.edges.filter(
      (e) => String(e.from) === nodeId || String(e.to) === nodeId
    );

    const outgoing = edges.filter((e) => String(e.from) === nodeId);
    const incoming = edges.filter((e) => String(e.to) === nodeId);

    return { outgoing, incoming, all: edges };
  }

  // =============================================
  // Filtering
  // =============================================

  /**
   * Populate topic filter dropdown
   */
  populateTopicFilter(topics: string[]): void {
    const select = getElementByIdOrNull<HTMLSelectElement>('topic-filter');
    if (!select) {
      return;
    }

    select.innerHTML = '<option value="">All Topics</option>';
    topics.forEach((topic) => {
      const option = document.createElement('option');
      option.value = topic;
      option.textContent = topic;
      select.appendChild(option);
    });
  }

  /**
   * Filter by topic
   */
  filterByTopic(topic: string): void {
    if (!this.network) {
      return;
    }

    const allNodes = this.network.body.data.nodes.get();

    if (!topic) {
      // Show all
      allNodes.forEach((node) => {
        this.network.body.data.nodes.update({
          id: node.id,
          hidden: false,
        });
      });
    } else {
      // Filter
      allNodes.forEach((node) => {
        const nodeData = this.graphData.nodes.find((n) => String(n.id) === String(node.id));
        this.network.body.data.nodes.update({
          id: node.id,
          hidden: nodeData?.topic !== topic,
        });
      });
    }

    logger.debug('[MAMA] Filtered by topic:', topic || 'all');
  }

  /**
   * Filter by outcome
   */
  filterByOutcome(outcome: string): void {
    if (!this.network) {
      return;
    }

    const allNodes = this.network.body.data.nodes.get();

    if (!outcome) {
      // Show all
      allNodes.forEach((node) => {
        this.network.body.data.nodes.update({
          id: node.id,
          hidden: false,
        });
      });
    } else {
      // Filter by outcome
      allNodes.forEach((node) => {
        const nodeData = this.graphData.nodes.find((n) => String(n.id) === String(node.id));
        const nodeOutcome = (nodeData?.outcome || 'pending').toLowerCase();
        this.network.body.data.nodes.update({
          id: node.id,
          hidden: nodeOutcome !== outcome.toLowerCase(),
        });
      });
    }

    logger.debug('[MAMA] Filtered by outcome:', outcome || 'all');
  }

  /**
   * Clear all filters
   */
  clearFilters(): void {
    if (!this.network) {
      return;
    }

    // Show all nodes
    const allNodes = this.network.body.data.nodes.get();
    allNodes.forEach((node) => {
      this.network.body.data.nodes.update({
        id: node.id,
        hidden: false,
        opacity: 1.0,
        font: { ...node.font, color: '#131313' },
      });
    });

    // Show all edges
    const allEdges = this.network.body.data.edges.get();
    allEdges.forEach((edge) => {
      this.network.body.data.edges.update({
        id: edge.id,
        opacity: 1.0,
      });
    });

    // Clear search state
    this.searchMatches = [];
    this.currentSearchIndex = 0;

    const countEl = getElementByIdOrNull<HTMLElement>('search-count');
    if (countEl) {
      countEl.style.display = 'none';
    }

    logger.debug('[MAMA] All filters cleared');
  }

  // =============================================
  // Search
  // =============================================

  /**
   * Perform search
   */
  search(): void {
    const queryInput = getElementByIdOrNull<HTMLInputElement>('search-input');
    const query = queryInput ? queryInput.value.trim().toLowerCase() : '';

    if (!query) {
      this.clearSearch();
      return;
    }

    // Search in topic, decision, and reasoning
    this.searchMatches = this.graphData.nodes.filter(
      (node) =>
        (node.topic || '').toLowerCase().includes(query) ||
        (node.decision || '').toLowerCase().includes(query) ||
        (node.reasoning || '').toLowerCase().includes(query)
    );

    this.currentSearchIndex = 0;
    this.updateSearchResults();

    if (this.searchMatches.length > 0) {
      this.highlightSearchResults();
      this.navigateToNode(String(this.searchMatches[0].id));
    }

    logger.debug('[MAMA] Search:', query, '- Found', this.searchMatches.length, 'matches');
  }

  /**
   * Handle search input
   */
  handleSearchInput(event: KeyboardEvent): void {
    if (event.key === 'Enter' && this.searchMatches.length > 0) {
      this.nextSearchResult();
    } else {
      this.debouncedSearch();
    }
  }

  /**
   * Navigate to next search result
   */
  nextSearchResult(): void {
    if (this.searchMatches.length === 0) {
      return;
    }

    this.currentSearchIndex = (this.currentSearchIndex + 1) % this.searchMatches.length;
    this.navigateToNode(this.searchMatches[this.currentSearchIndex].id);
    this.updateSearchResults();
  }

  /**
   * Navigate to previous search result
   */
  prevSearchResult(): void {
    if (this.searchMatches.length === 0) {
      return;
    }

    this.currentSearchIndex =
      (this.currentSearchIndex - 1 + this.searchMatches.length) % this.searchMatches.length;
    this.navigateToNode(this.searchMatches[this.currentSearchIndex].id);
    this.updateSearchResults();
  }

  /**
   * Update search count display
   */
  updateSearchResults(): void {
    const countEl = getElementByIdOrNull<HTMLElement>('search-count');
    if (!countEl) {
      return;
    }

    if (this.searchMatches.length > 0) {
      countEl.textContent = `${this.currentSearchIndex + 1} / ${this.searchMatches.length}`;
      countEl.style.display = 'inline';
    } else {
      countEl.textContent = 'No results';
      countEl.style.display = 'inline';
    }
  }

  /**
   * Highlight search results
   */
  highlightSearchResults(): void {
    if (!this.network) {
      return;
    }

    const matchIds = this.searchMatches.map((n) => n.id);
    const allNodes = this.network.body.data.nodes.get();

    allNodes.forEach((node) => {
      const isMatch = matchIds.includes(String(node.id));
      this.network.body.data.nodes.update({
        id: node.id,
        opacity: isMatch ? 1.0 : 0.2,
        font: { ...node.font, color: isMatch ? '#131313' : '#999' },
      });
    });
  }

  /**
   * Clear search
   */
  clearSearch(): void {
    this.searchMatches = [];
    this.currentSearchIndex = 0;
    this.resetNodeHighlight();

    const countEl = getElementByIdOrNull<HTMLElement>('search-count');
    if (countEl) {
      countEl.style.display = 'none';
    }
  }

  /**
   * Open search panel
   */
  openSearch(): void {
    const searchContainer = getElementByIdOrNull<HTMLElement>('search-container');
    const searchInput = getElementByIdOrNull<HTMLInputElement>('search-input');

    if (!searchContainer || !searchInput) {
      return;
    }
    searchContainer.style.display = 'flex';
    searchInput.focus();
  }

  /**
   * Close search panel
   */
  closeSearch(): void {
    const searchContainer = getElementByIdOrNull<HTMLElement>('search-container');
    if (!searchContainer) {
      return;
    }
    searchContainer.style.display = 'none';
    this.clearSearch();
  }
}
