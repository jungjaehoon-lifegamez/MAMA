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
/* global vis, lucide */

import { escapeHtml, debounce } from '../utils/dom.js';
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
    const container = document.getElementById('graph-container');
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
      if (params.nodes.length > 0) {
        const nodeId = params.nodes[0];
        const node = data.nodes.find((n) => n.id === nodeId);
        if (node) {
          this.showDetail(node);
          this.highlightConnectedNodes(nodeId);
        }
      } else {
        this.closeDetail();
        this.resetNodeHighlight();
      }
    });

    this.network.on('stabilized', () => {
      const loadingEl = document.getElementById('loading');
      if (loadingEl) {
        loadingEl.style.display = 'none';
      }
      console.log('[MAMA] Graph stabilized');
    });

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
    this.currentNodeId = node.id;
    const panel = document.getElementById('detail-panel');

    panel.innerHTML = `
      <h3>${escapeHtml(node.topic || 'Unknown Topic')}</h3>
      <button onclick="window.graphModule.closeDetail()" class="close-detail">
        <i data-lucide="x" class="icon"></i>
      </button>

      <div class="detail-section">
        <strong>Decision:</strong>
        <p>${escapeHtml(node.decision)}</p>
      </div>

      <div class="detail-section">
        <strong>Reasoning:</strong>
        <div class="reasoning-text" id="reasoning-text">
          ${escapeHtml((node.reasoning || '').substring(0, 200))}...
          ${(node.reasoning || '').length > 200 ? '<button onclick="window.graphModule.toggleReasoning()" class="toggle-reasoning"><i data-lucide="chevron-down" class="icon"></i> Show More</button>' : ''}
          <div class="reasoning-full" style="display:none">${escapeHtml(node.reasoning || '')}</div>
        </div>
      </div>

      <div class="detail-meta">
        <span class="outcome ${(node.outcome || 'pending').toLowerCase()}">
          <i data-lucide="${this.getOutcomeIcon(node.outcome)}" class="icon"></i>
          ${node.outcome || 'PENDING'}
        </span>
        <span>
          <i data-lucide="gauge" class="icon"></i>
          ${Math.round((node.confidence || 0) * 100)}%
        </span>
      </div>

      ${
        node.outcome?.toLowerCase() !== 'success'
          ? `
        <div class="detail-section">
          <strong>Update Outcome:</strong>
          <select id="outcome-select" class="outcome-select">
            <option value="pending" ${!node.outcome || node.outcome.toLowerCase() === 'pending' ? 'selected' : ''}>Pending</option>
            <option value="success" ${node.outcome?.toLowerCase() === 'success' ? 'selected' : ''}>Success</option>
            <option value="failed" ${node.outcome?.toLowerCase() === 'failed' ? 'selected' : ''}>Failed</option>
            <option value="partial" ${node.outcome?.toLowerCase() === 'partial' ? 'selected' : ''}>Partial</option>
          </select>
          <button onclick="window.graphModule.saveOutcome()" class="save-outcome">
            <i data-lucide="save" class="icon"></i> Save
          </button>
        </div>
      `
          : ''
      }

      <div class="detail-section">
        <strong>
          <i data-lucide="lightbulb" class="icon"></i>
          Similar Decisions:
        </strong>
        <div id="similar-decisions">Loading...</div>
      </div>
    `;

    panel.style.display = 'block';

    // Reinitialize Lucide icons for dynamic content
    if (typeof lucide !== 'undefined') {
      lucide.createIcons();
    }

    // Fetch similar decisions
    this.fetchSimilarDecisions(node.id);
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
    const shortText = document.querySelector('.reasoning-text');
    const fullText = document.querySelector('.reasoning-full');
    const btn = document.querySelector('.toggle-reasoning');

    if (fullText.style.display === 'none') {
      shortText.childNodes[0].textContent = '';
      fullText.style.display = 'block';
      btn.innerHTML = '<i data-lucide="chevron-up" class="icon"></i> Show Less';
      lucide.createIcons(); // Re-initialize icons
    } else {
      fullText.style.display = 'none';
      btn.innerHTML = '<i data-lucide="chevron-down" class="icon"></i> Show More';
      lucide.createIcons(); // Re-initialize icons
    }
  }

  /**
   * Close detail panel
   */
  closeDetail() {
    document.getElementById('detail-panel').style.display = 'none';
    this.currentNodeId = null;
    this.resetNodeHighlight();
  }

  /**
   * Fetch similar decisions
   */
  async fetchSimilarDecisions(nodeId) {
    const container = document.getElementById('similar-decisions');

    try {
      const data = await API.getSimilarDecisions(nodeId);
      const similar = data.similar || [];

      if (similar.length === 0) {
        container.innerHTML = '<p class="no-similar">No similar decisions found</p>';
        return;
      }

      const html = similar
        .map(
          (s) => `
          <div class="similar-item" onclick="window.graphModule.navigateToNode('${s.id}')">
            <div class="similar-topic">${escapeHtml(s.topic)}</div>
            <div class="similar-decision">${escapeHtml((s.decision || '').substring(0, 100))}...</div>
            <div class="similar-score">${Math.round((s.similarity || 0) * 100)}% similar</div>
          </div>
        `
        )
        .join('');

      container.innerHTML = html;
    } catch (error) {
      console.error('[MAMA] Failed to fetch similar decisions:', error);
      container.innerHTML = '<p class="error">Failed to load similar decisions</p>';
    }
  }

  /**
   * Save outcome for current node
   */
  async saveOutcome() {
    const select = document.getElementById('outcome-select');
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
  navigateToNode(nodeId) {
    if (!this.network) {
      return;
    }

    const node = this.graphData.nodes.find((n) => n.id === nodeId);
    if (!node) {
      console.warn('[MAMA] Node not found:', nodeId);
      return;
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
