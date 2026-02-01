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

import { escapeHtml, debounce, showToast } from '../utils/dom.js';
import { API } from '../utils/api.js';

/**
 * Graph Module Class
 */
export class GraphModule {
  constructor() {
    // Network state
    this.network = null;
    this.graphData = { nodes: [], edges: [], meta: {} };
    this.currentNodeId = null;
    this.adjacencyList = new Map();

    // Search state
    this.searchMatches = [];
    this.currentSearchIndex = 0;
    this.debouncedSearch = debounce(() => this.search(), 300);

    // Color management
    this.topicColors = {};
    this.colorPalette = [
      '#6366f1',
      '#8b5cf6',
      '#a855f7',
      '#d946ef',
      '#ec4899',
      '#f43f5e',
      '#ef4444',
      '#f97316',
      '#f59e0b',
      '#eab308',
      '#84cc16',
      '#22c55e',
      '#10b981',
      '#14b8a6',
      '#06b6d4',
      '#0ea5e9',
    ];
    this.colorIndex = 0;

    // Edge styles
    this.edgeStyles = {
      supersedes: { color: '#848484', dashes: false },
      builds_on: { color: '#457b9d', dashes: [5, 5] },
      debates: { color: '#e63946', dashes: [5, 5] },
      synthesizes: { color: '#9b59b6', width: 3, dashes: false },
    };
  }

  // =============================================
  // Data Loading
  // =============================================

  /**
   * Fetch graph data from API
   */
  async fetchData() {
    try {
      this.graphData = await API.getGraph();
      console.log('[MAMA] Graph data loaded:', this.graphData.meta);
      return this.graphData;
    } catch (error) {
      console.error('[MAMA] Failed to fetch graph:', error);
      throw error;
    }
  }

  // =============================================
  // Graph Initialization
  // =============================================

  /**
   * Initialize vis-network
   */
  init(data) {
    const container = document.getElementById('graph-canvas');
    if (!container) {
      console.error('[MAMA] graph-canvas element not found');
      return;
    }

    // Ensure container has dimensions for vis-network
    if (container.offsetHeight === 0) {
      container.style.minHeight = '400px';
    }

    console.log(
      '[MAMA] Graph canvas dimensions:',
      container.offsetWidth,
      'x',
      container.offsetHeight
    );

    this.graphData = data;

    // Build adjacency list for BFS
    this.buildAdjacencyList(data.edges);

    // Calculate connection counts for sizing
    const connectionCounts = this.calculateConnectionCounts(data.nodes, data.edges);

    // Map nodes to vis-network format
    const nodes = data.nodes.map((n) => ({
      id: n.id,
      label: n.topic || n.id.substring(0, 20),
      title: this.createNodeTooltip(n),
      color: {
        background: this.getTopicColor(n.topic),
        border: this.getOutcomeBorderColor(n.outcome),
        highlight: { background: this.getTopicColor(n.topic), border: '#fff' },
      },
      size: this.getNodeSize(connectionCounts[n.id] || 0),
      font: { color: '#fff', size: 12 },
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
    this.network.on('click', (params) => {
      try {
        if (params.nodes.length > 0) {
          const nodeId = params.nodes[0];
          const node = data.nodes.find((n) => n.id === nodeId);
          if (node) {
            console.log('[MAMA] Node clicked:', nodeId, node);
            this.showDetail(node);
            this.highlightConnectedNodes(nodeId);
          }
        } else {
          this.closeDetail();
          this.resetNodeHighlight();
        }
      } catch (error) {
        console.error('[MAMA] Error handling click:', error);
        console.error('[MAMA] Error stack:', error.stack);
      }
    });

    this.network.on('stabilized', () => {
      const loadingEl = document.getElementById('graph-loading');
      if (loadingEl) {
        loadingEl.style.display = 'none';
      }
      console.log('[MAMA] Graph stabilized');
    });

    // Backup: hide loading after 3 seconds even if stabilization doesn't complete
    setTimeout(() => {
      const loadingEl = document.getElementById('graph-loading');
      if (loadingEl && loadingEl.style.display !== 'none') {
        loadingEl.style.display = 'none';
        console.log('[MAMA] Graph loading hidden by timeout');
      }
    }, 3000);

    // Populate topic filter
    const topics = [...new Set(data.nodes.map((n) => n.topic))].sort();
    this.populateTopicFilter(topics);

    console.log('[MAMA] Graph initialized with', nodes.length, 'nodes and', edges.length, 'edges');
  }

  // =============================================
  // Styling Utilities
  // =============================================

  /**
   * Get color for topic
   */
  getTopicColor(topic) {
    if (!this.topicColors[topic]) {
      this.topicColors[topic] = this.colorPalette[this.colorIndex % this.colorPalette.length];
      this.colorIndex++;
    }
    return this.topicColors[topic];
  }

  /**
   * Get border color based on outcome
   */
  getOutcomeBorderColor(outcome) {
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
  getEdgeStyle(relationship) {
    return this.edgeStyles[relationship] || { color: '#4a4a6a', dashes: false };
  }

  /**
   * Get node size based on connection count
   */
  getNodeSize(connectionCount) {
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
  createNodeTooltip(node) {
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
  buildAdjacencyList(edges) {
    this.adjacencyList = new Map();

    edges.forEach((edge) => {
      if (!this.adjacencyList.has(edge.from)) {
        this.adjacencyList.set(edge.from, []);
      }
      if (!this.adjacencyList.has(edge.to)) {
        this.adjacencyList.set(edge.to, []);
      }
      this.adjacencyList.get(edge.from).push(edge.to);
      this.adjacencyList.get(edge.to).push(edge.from);
    });

    console.log('[MAMA] Adjacency list built with', this.adjacencyList.size, 'nodes');
  }

  /**
   * Calculate connection count for each node
   */
  calculateConnectionCounts(nodes, edges) {
    const counts = {};
    nodes.forEach((n) => (counts[n.id] = 0));

    edges.forEach((edge) => {
      if (counts[edge.from] !== undefined) {
        counts[edge.from]++;
      }
      if (counts[edge.to] !== undefined) {
        counts[edge.to]++;
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
  getConnectedNodeIds(nodeId, maxDepth = 3) {
    const visited = new Set();
    const queue = [{ id: nodeId, depth: 0 }];
    visited.add(nodeId);

    while (queue.length > 0) {
      const { id, depth } = queue.shift();

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
  highlightConnectedNodes(nodeId) {
    if (!this.network) {
      return;
    }

    const connectedIds = this.getConnectedNodeIds(nodeId, 3);
    const allNodes = this.network.body.data.nodes.get();

    allNodes.forEach((node) => {
      const isConnected = connectedIds.includes(node.id);
      const opacity = isConnected ? 1.0 : 0.2;

      this.network.body.data.nodes.update({
        id: node.id,
        opacity: opacity,
        font: { ...node.font, color: isConnected ? '#fff' : '#666' },
      });
    });

    const allEdges = this.network.body.data.edges.get();
    allEdges.forEach((edge) => {
      const isConnected = connectedIds.includes(edge.from) && connectedIds.includes(edge.to);
      this.network.body.data.edges.update({
        id: edge.id,
        opacity: isConnected ? 1.0 : 0.1,
      });
    });
  }

  /**
   * Reset node highlight
   */
  resetNodeHighlight() {
    if (!this.network) {
      return;
    }

    const allNodes = this.network.body.data.nodes.get();
    allNodes.forEach((node) => {
      this.network.body.data.nodes.update({
        id: node.id,
        opacity: 1.0,
        font: { ...node.font, color: '#fff' },
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
  async showDetail(node) {
    try {
      console.log('[MAMA] showDetail called with node:', node);
      this.currentNodeId = node.id;
      const panel = document.getElementById('decision-detail-modal');

      if (!panel) {
        console.error('[MAMA] decision-detail-modal element not found');
        return;
      }

      // Update existing DOM elements with markdown rendering
      document.getElementById('detail-topic').textContent = node.topic || 'Unknown Topic';
      const decisionEl = document.getElementById('detail-decision');
      const reasoningEl = document.getElementById('detail-reasoning');

      // Use marked for markdown if available
      if (typeof marked !== 'undefined') {
        decisionEl.innerHTML = marked.parse(node.decision || '-');
        reasoningEl.innerHTML = marked.parse(node.reasoning || '-');
      } else {
        decisionEl.textContent = node.decision || '-';
        reasoningEl.textContent = node.reasoning || '-';
      }

      const outcomeSelect = document.getElementById('detail-outcome-select');
      if (outcomeSelect) {
        outcomeSelect.value = (node.outcome || 'PENDING').toUpperCase();
      }

      // Clear outcome status
      const outcomeStatus = document.getElementById('outcome-status');
      if (outcomeStatus) {
        outcomeStatus.textContent = '';
        outcomeStatus.className = '';
      }

      document.getElementById('detail-confidence').textContent = node.confidence
        ? `${(node.confidence * 100).toFixed(0)}%`
        : '-';

      const createdEl = document.getElementById('detail-created');
      if (createdEl) {
        createdEl.textContent = node.created_at ? new Date(node.created_at).toLocaleString() : '-';
      }

      // Reset reasoning toggle
      const reasoningArrow = document.getElementById('reasoning-arrow');
      if (reasoningArrow) {
        reasoningArrow.textContent = '▶';
      }
      document.getElementById('detail-reasoning').classList.add('hidden');

      // Show loading state for similar decisions
      const similarEl = document.getElementById('detail-similar');
      if (similarEl) {
        similarEl.innerHTML = '<span class="loading-similar">Searching...</span>';
      }

      // Show panel
      panel.classList.add('visible');

      // Fetch similar decisions
      console.log('[MAMA] Fetching similar decisions...');
      this.fetchSimilarDecisions(node.id);
      console.log('[MAMA] showDetail completed successfully');
    } catch (error) {
      console.error('[MAMA] Error in showDetail:', error);
      console.error('[MAMA] Error stack:', error.stack);
      console.error('[MAMA] Node data:', node);
    }
  }

  /**
   * Get outcome icon name
   */
  getOutcomeIcon(outcome) {
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
  toggleReasoning() {
    const arrow = document.getElementById('reasoning-arrow');
    const content = document.getElementById('detail-reasoning');
    if (arrow && content) {
      const isHidden = content.classList.contains('hidden');
      content.classList.toggle('hidden');
      arrow.textContent = isHidden ? '▼' : '▶';
    }
  }

  /**
   * Close detail panel
   */
  closeDetail() {
    const panel = document.getElementById('decision-detail-modal');
    if (panel) {
      panel.classList.remove('visible');
    }
    this.currentNodeId = null;
    this.resetNodeHighlight();
  }

  /**
   * Fetch similar decisions
   */
  async fetchSimilarDecisions(nodeId) {
    console.log('[MAMA] fetchSimilarDecisions called for node:', nodeId);
    const container = document.getElementById('detail-similar');

    if (!container) {
      console.warn('[MAMA] detail-similar element not found');
      return;
    }

    try {
      console.log('[MAMA] Calling API.getSimilarDecisions...');
      const data = await API.getSimilarDecisions(nodeId);
      console.log('[MAMA] Similar decisions received:', data);

      if (data.error) {
        container.innerHTML = `<span style="color:#666">${data.message || 'Search failed'}</span>`;
        return;
      }

      const similar = data.similar || [];

      if (similar.length === 0) {
        console.log('[MAMA] No similar decisions found');
        container.innerHTML = '<span style="color:#666">No similar decisions found</span>';
        return;
      }

      console.log('[MAMA] Building similar decisions HTML for', similar.length, 'items');
      const html = similar
        .map(
          (s) => `
          <button class="w-full text-left p-2 mb-2 bg-gray-100 dark:bg-gray-800 hover:bg-indigo-100 dark:hover:bg-indigo-900/30 border border-gray-200 dark:border-gray-700 rounded-lg transition-colors" onclick="window.graphModule.navigateToNode('${s.id}')">
            <div class="text-xs font-semibold text-indigo-600 dark:text-indigo-400">${escapeHtml(s.topic)}</div>
            <div class="text-xs text-gray-600 dark:text-gray-400 mt-1 line-clamp-2">${escapeHtml((s.decision || '').substring(0, 80))}...</div>
            <div class="text-xs text-gray-500 mt-1">${Math.round((s.similarity || 0) * 100)}% match</div>
          </button>
        `
        )
        .join('');

      console.log('[MAMA] Setting similar decisions HTML...');
      container.innerHTML = html;
      console.log('[MAMA] fetchSimilarDecisions completed');
    } catch (error) {
      console.error('[MAMA] Failed to fetch similar decisions:', error);
      console.error('[MAMA] Error stack:', error.stack);
      container.innerHTML = '<span style="color:#f66">Failed to load</span>';
    }
  }

  /**
   * Save outcome for current node
   */
  async saveOutcome() {
    const select = document.getElementById('detail-outcome-select');
    const newOutcome = select.value;

    if (!this.currentNodeId || !newOutcome) {
      return;
    }

    try {
      await API.updateOutcome(this.currentNodeId, newOutcome);

      // Update local data
      const node = this.graphData.nodes.find((n) => n.id === this.currentNodeId);
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

      console.log('[MAMA] Outcome updated:', this.currentNodeId, newOutcome);
    } catch (error) {
      console.error('[MAMA] Failed to update outcome:', error);
      alert('Failed to update outcome: ' + error.message);
    }
  }

  // =============================================
  // Navigation
  // =============================================

  /**
   * Navigate to specific node
   */
  async navigateToNode(nodeId) {
    if (!this.network) {
      return;
    }

    // Try exact match first
    let node = this.graphData.nodes.find((n) => n.id === nodeId);

    // If not found, try partial match (for short IDs from checkpoints)
    if (!node) {
      console.log('[MAMA] Exact match not found, trying partial match for:', nodeId);
      node = this.graphData.nodes.find((n) => n.id.startsWith(nodeId));

      if (node) {
        console.log('[MAMA] Found node via partial match:', node.id);
        nodeId = node.id; // Update nodeId to the full ID
      }
    }

    // If node not in current graph, reload without filters
    if (!node) {
      console.log('[MAMA] Node not in current graph, reloading all nodes...');

      // Reset topic filter
      const topicFilter = document.getElementById('topic-filter');
      if (topicFilter) {
        topicFilter.value = '';
      }

      // Reload graph: fetch fresh data and reinitialize
      await this.fetchData();
      this.init(this.graphData);

      // Try exact match again
      node = this.graphData.nodes.find((n) => n.id === nodeId);

      // If still not found, try partial match
      if (!node) {
        node = this.graphData.nodes.find((n) => n.id.startsWith(nodeId));
        if (node) {
          console.log('[MAMA] Found node via partial match after reload:', node.id);
          nodeId = node.id;
        }
      }

      if (!node) {
        console.warn('[MAMA] Node not found even after reload:', nodeId);
        showToast('⚠️ Decision not found in graph');
        return;
      }
    }

    // Focus on node
    this.network.focus(nodeId, {
      scale: 1.5,
      animation: { duration: 500, easingFunction: 'easeInOutQuad' },
    });

    // Select node (triggers click event)
    this.network.selectNodes([nodeId]);

    // Show detail
    this.showDetail(node);
    this.highlightConnectedNodes(nodeId);
  }

  /**
   * Get connected edge types
   */
  getConnectedEdges(nodeId) {
    const edges = this.graphData.edges.filter((e) => e.from === nodeId || e.to === nodeId);

    const outgoing = edges.filter((e) => e.from === nodeId);
    const incoming = edges.filter((e) => e.to === nodeId);

    return { outgoing, incoming, all: edges };
  }

  // =============================================
  // Filtering
  // =============================================

  /**
   * Populate topic filter dropdown
   */
  populateTopicFilter(topics) {
    const select = document.getElementById('topic-filter');
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
  filterByTopic(topic) {
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
        const nodeData = this.graphData.nodes.find((n) => n.id === node.id);
        this.network.body.data.nodes.update({
          id: node.id,
          hidden: nodeData?.topic !== topic,
        });
      });
    }

    console.log('[MAMA] Filtered by topic:', topic || 'all');
  }

  /**
   * Filter by outcome
   */
  filterByOutcome(outcome) {
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
        const nodeData = this.graphData.nodes.find((n) => n.id === node.id);
        const nodeOutcome = (nodeData?.outcome || 'pending').toLowerCase();
        this.network.body.data.nodes.update({
          id: node.id,
          hidden: nodeOutcome !== outcome.toLowerCase(),
        });
      });
    }

    console.log('[MAMA] Filtered by outcome:', outcome || 'all');
  }

  /**
   * Clear all filters
   */
  clearFilters() {
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
        font: { ...node.font, color: '#fff' },
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

    const countEl = document.getElementById('search-count');
    if (countEl) {
      countEl.style.display = 'none';
    }

    console.log('[MAMA] All filters cleared');
  }

  // =============================================
  // Search
  // =============================================

  /**
   * Perform search
   */
  search() {
    const query = document.getElementById('search-input').value.trim().toLowerCase();

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
      this.navigateToNode(this.searchMatches[0].id);
    }

    console.log('[MAMA] Search:', query, '- Found', this.searchMatches.length, 'matches');
  }

  /**
   * Handle search input
   */
  handleSearchInput(event) {
    if (event.key === 'Enter' && this.searchMatches.length > 0) {
      this.nextSearchResult();
    } else {
      this.debouncedSearch();
    }
  }

  /**
   * Navigate to next search result
   */
  nextSearchResult() {
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
  prevSearchResult() {
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
  updateSearchResults() {
    const countEl = document.getElementById('search-count');
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
  highlightSearchResults() {
    if (!this.network) {
      return;
    }

    const matchIds = this.searchMatches.map((n) => n.id);
    const allNodes = this.network.body.data.nodes.get();

    allNodes.forEach((node) => {
      const isMatch = matchIds.includes(node.id);
      this.network.body.data.nodes.update({
        id: node.id,
        opacity: isMatch ? 1.0 : 0.2,
        font: { ...node.font, color: isMatch ? '#fff' : '#666' },
      });
    });
  }

  /**
   * Clear search
   */
  clearSearch() {
    this.searchMatches = [];
    this.currentSearchIndex = 0;
    this.resetNodeHighlight();

    const countEl = document.getElementById('search-count');
    if (countEl) {
      countEl.style.display = 'none';
    }
  }

  /**
   * Open search panel
   */
  openSearch() {
    const searchContainer = document.getElementById('search-container');
    const searchInput = document.getElementById('search-input');

    searchContainer.style.display = 'flex';
    searchInput.focus();
  }

  /**
   * Close search panel
   */
  closeSearch() {
    document.getElementById('search-container').style.display = 'none';
    this.clearSearch();
  }
}
