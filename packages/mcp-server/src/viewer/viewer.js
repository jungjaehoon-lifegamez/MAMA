/**
 * MAMA Graph Viewer JavaScript
 * @version 1.4.0
 */

/* eslint-env browser */
/* global vis */
/* exported filterByTopic, handleSearch, closeDetail, toggleLegend, saveOutcome, toggleReasoning, navigateToNode, getConnectedEdges */

// Global state
let network = null;
let graphData = { nodes: [], edges: [], meta: {} };
let currentNodeId = null; // Track selected node for outcome editing
let adjacencyList = new Map(); // Pre-built adjacency list for O(1) BFS

// Color palette for topics
const topicColors = {};
const colorPalette = [
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
let colorIndex = 0;

function getTopicColor(topic) {
  if (!topicColors[topic]) {
    topicColors[topic] = colorPalette[colorIndex % colorPalette.length];
    colorIndex++;
  }
  return topicColors[topic];
}

// Edge styles by relationship type
const EDGE_STYLES = {
  supersedes: { color: '#848484', dashes: false },
  builds_on: { color: '#457b9d', dashes: [5, 5] },
  debates: { color: '#e63946', dashes: [5, 5] },
  synthesizes: { color: '#9b59b6', width: 3, dashes: false },
};

function getEdgeStyle(relationship) {
  return EDGE_STYLES[relationship] || { color: '#4a4a6a', dashes: false };
}

// Debounce utility for search performance
function debounce(func, wait) {
  let timeout;
  return function executedFunction(...args) {
    const later = () => {
      clearTimeout(timeout);
      func(...args);
    };
    clearTimeout(timeout);
    timeout = setTimeout(later, wait);
  };
}

// Fetch graph data from API
async function fetchGraphData() {
  try {
    const response = await fetch('/graph?cluster=true');
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    graphData = await response.json();
    console.log('[MAMA] Graph data loaded:', graphData.meta);
    return graphData;
  } catch (error) {
    console.error('[MAMA] Failed to fetch graph:', error);
    throw error;
  }
}

// Build adjacency list for O(1) neighbor lookup in BFS
function buildAdjacencyList(edges) {
  adjacencyList = new Map();

  edges.forEach((edge) => {
    // Add bidirectional connections
    if (!adjacencyList.has(edge.from)) {
      adjacencyList.set(edge.from, []);
    }
    if (!adjacencyList.has(edge.to)) {
      adjacencyList.set(edge.to, []);
    }
    adjacencyList.get(edge.from).push(edge.to);
    adjacencyList.get(edge.to).push(edge.from);
  });

  console.log('[MAMA] Adjacency list built with', adjacencyList.size, 'nodes');
}

// Calculate node size based on connection count
function getNodeSize(connectionCount) {
  if (connectionCount <= 2) {
    return 12;
  } // Small: 1-2 connections
  if (connectionCount <= 5) {
    return 18;
  } // Medium: 3-5 connections
  if (connectionCount <= 10) {
    return 24;
  } // Large: 6-10 connections
  return 30; // Extra large: 11+ connections
}

// Calculate connection count for each node
function calculateConnectionCounts(nodes, edges) {
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

// Initialize vis-network
function initGraph(data) {
  const container = document.getElementById('graph-container');
  const loadingEl = document.getElementById('loading');
  if (loadingEl) {
    loadingEl.remove();
  }

  console.log('[MAMA] Initializing graph with', data.nodes.length, 'nodes');

  // Build adjacency list for efficient BFS
  buildAdjacencyList(data.edges);

  // Calculate connection counts for node sizing
  const connectionCounts = calculateConnectionCounts(data.nodes, data.edges);
  console.log('[MAMA] Connection counts calculated');

  // Transform nodes for vis-network with size based on connections
  visNodes = new vis.DataSet(
    data.nodes.map((node) => {
      const connCount = connectionCounts[node.id] || 0;
      const nodeSize = getNodeSize(connCount);
      return {
        id: node.id,
        label: node.topic,
        title: `${node.decision}\n\nConnections: ${connCount}`,
        size: nodeSize,
        color: {
          background: getTopicColor(node.topic),
          border: '#4a4a6a',
          highlight: {
            background: getTopicColor(node.topic),
            border: '#a0a0ff',
          },
        },
        font: { color: '#fff', size: Math.max(10, nodeSize * 0.7) },
        data: { ...node, connectionCount: connCount },
      };
    })
  );

  // Transform edges for vis-network with relationship styling
  const allEdges = data.edges.map((edge, idx) => {
    const style = getEdgeStyle(edge.relationship);
    return {
      id: `edge_${idx}`,
      from: edge.from,
      to: edge.to,
      label: edge.relationship,
      arrows: 'to',
      color: { color: style.color, highlight: '#a0a0ff' },
      dashes: style.dashes,
      width: style.width || 1,
      font: { color: '#888', size: 10 },
      data: edge,
    };
  });

  // Add similarity edges (hidden, for physics clustering only)
  if (data.similarityEdges && data.similarityEdges.length > 0) {
    console.log('[MAMA] Adding', data.similarityEdges.length, 'similarity edges for clustering');
    data.similarityEdges.forEach((edge, idx) => {
      allEdges.push({
        id: `sim_${idx}`,
        from: edge.from,
        to: edge.to,
        hidden: true,
        physics: true,
        length: Math.max(150, 400 * (1 - edge.similarity)),
        data: { ...edge, isSimilarity: true },
      });
    });
  }

  visEdges = new vis.DataSet(allEdges);

  const options = {
    nodes: {
      shape: 'dot',
      size: 16,
      borderWidth: 2,
    },
    edges: {
      width: 1,
      smooth: { type: 'continuous' },
    },
    layout: {
      improvedLayout: false,
    },
    physics: {
      stabilization: {
        enabled: true,
        iterations: 200,
        updateInterval: 25,
      },
      barnesHut: {
        gravitationalConstant: -5000,
        centralGravity: 0.2,
        springLength: 200,
        springConstant: 0.03,
        damping: 0.09,
      },
    },
    interaction: {
      hover: true,
      tooltipDelay: 200,
      hideEdgesOnDrag: true,
      hideEdgesOnZoom: true,
    },
  };

  network = new vis.Network(container, { nodes: visNodes, edges: visEdges }, options);

  network.once('stabilizationIterationsDone', function () {
    network.fit();
    console.log('[MAMA] Graph stabilized, fitting to view');
  });

  setTimeout(() => {
    network.fit();
    console.log('[MAMA] Network fit called, nodes:', visNodes.length);
  }, 1000);

  // Node click handler
  network.on('click', function (params) {
    if (params.nodes.length > 0) {
      const nodeId = params.nodes[0];
      const node = visNodes.get(nodeId);
      showDetail(node.data);
      highlightConnectedNodes(nodeId);
    } else {
      closeDetail();
      resetNodeHighlight();
    }
  });

  updateStats(data.meta);
  populateTopicFilter(data.meta.topics);
}

// Get all nodes connected to a given node using pre-built adjacency list (O(1) neighbor lookup)
function getConnectedNodeIds(nodeId, maxDepth = 3) {
  const connected = new Set([nodeId]);
  const depthMap = new Map([[nodeId, 0]]);
  let currentDepth = 0;
  let frontier = new Set([nodeId]);

  while (currentDepth < maxDepth && frontier.size > 0) {
    const nextFrontier = new Set();

    frontier.forEach((currentId) => {
      // O(1) lookup using adjacency list instead of O(E) edge iteration
      const neighbors = adjacencyList.get(currentId) || [];
      neighbors.forEach((neighborId) => {
        if (!connected.has(neighborId)) {
          connected.add(neighborId);
          depthMap.set(neighborId, currentDepth + 1);
          nextFrontier.add(neighborId);
        }
      });
    });

    frontier = nextFrontier;
    currentDepth++;
  }

  return { connected, depthMap };
}

// Highlight selected node and its connected nodes, dim others
function highlightConnectedNodes(nodeId) {
  if (!visNodes || !visEdges) {
    return;
  }

  const { connected, depthMap } = getConnectedNodeIds(nodeId, 3);
  const depthOpacity = [1.0, 0.9, 0.7, 0.5];

  const nodeUpdates = graphData.nodes.map((node) => {
    const isConnected = connected.has(node.id);
    const isSelected = node.id === nodeId;
    const depth = depthMap.get(node.id);
    const connCount = node.connectionCount || 0;
    const nodeSize = getNodeSize(connCount);

    const opacity = isConnected ? depthOpacity[depth] || 0.5 : 0.1;
    const textOpacity = isConnected ? Math.max(0.4, opacity) : 0.1;

    return {
      id: node.id,
      opacity: opacity,
      borderWidth: isSelected ? 4 : 2,
      color: {
        background: isConnected ? getTopicColor(node.topic) : '#555',
        border: isSelected ? '#fff' : isConnected ? '#4a4a6a' : '#333',
        highlight: {
          background: getTopicColor(node.topic),
          border: '#a0a0ff',
        },
      },
      font: {
        color: isConnected ? `rgba(255,255,255,${textOpacity})` : 'rgba(255,255,255,0.1)',
        size: Math.max(10, nodeSize * 0.7),
      },
    };
  });

  visNodes.update(nodeUpdates);

  const edgeUpdates = visEdges
    .get()
    .map((edge) => {
      if (edge.hidden) {
        return null;
      }

      const fromConnected = connected.has(edge.from);
      const toConnected = connected.has(edge.to);
      const isConnectedEdge = fromConnected && toConnected;
      const style = getEdgeStyle(edge.data?.relationship);

      return {
        id: edge.id,
        color: {
          color: isConnectedEdge ? style.color : 'rgba(80,80,80,0.15)',
          highlight: '#a0a0ff',
          opacity: isConnectedEdge ? 1 : 0.1,
        },
        width: isConnectedEdge ? style.width || 1 : 0.5,
        font: {
          color: isConnectedEdge ? 'rgba(136,136,136,1)' : 'rgba(136,136,136,0)',
          size: 10,
          strokeWidth: 0,
          background: 'transparent',
        },
      };
    })
    .filter(Boolean);

  visEdges.update(edgeUpdates);
}

// Reset all nodes and edges to normal state
function resetNodeHighlight() {
  if (!visNodes || !visEdges) {
    return;
  }

  const nodeUpdates = graphData.nodes.map((node) => {
    const connCount = node.connectionCount || 0;
    const nodeSize = getNodeSize(connCount);

    return {
      id: node.id,
      opacity: 1,
      borderWidth: 2,
      color: {
        background: getTopicColor(node.topic),
        border: '#4a4a6a',
        highlight: {
          background: getTopicColor(node.topic),
          border: '#a0a0ff',
        },
      },
      font: {
        color: '#fff',
        size: Math.max(10, nodeSize * 0.7),
      },
    };
  });

  visNodes.update(nodeUpdates);

  const edgeUpdates = visEdges
    .get()
    .map((edge) => {
      if (edge.hidden) {
        return null;
      }

      const style = getEdgeStyle(edge.data?.relationship);

      return {
        id: edge.id,
        color: {
          color: style.color,
          highlight: '#a0a0ff',
          opacity: 1,
        },
        width: style.width || 1,
        font: {
          color: '#888',
          size: 10,
          strokeWidth: 0,
          background: 'transparent',
        },
      };
    })
    .filter(Boolean);

  visEdges.update(edgeUpdates);
}

function updateStats(meta) {
  const statsEl = document.getElementById('stats');
  statsEl.textContent = `${meta.total_nodes} decisions | ${meta.total_edges} edges | ${meta.topics.length} topics`;
}

function showDetail(node) {
  const panel = document.getElementById('detail-panel');
  currentNodeId = node.id;

  document.getElementById('detail-topic').textContent = node.topic;
  document.getElementById('detail-decision').textContent = node.decision || '-';
  document.getElementById('detail-reasoning').textContent = node.reasoning || '-';

  const outcomeSelect = document.getElementById('detail-outcome-select');
  outcomeSelect.value = (node.outcome || 'PENDING').toUpperCase();
  document.getElementById('outcome-status').textContent = '';
  document.getElementById('outcome-status').className = '';

  document.getElementById('detail-confidence').textContent = node.confidence
    ? `${(node.confidence * 100).toFixed(0)}%`
    : '-';
  document.getElementById('detail-created').textContent = node.created_at
    ? new Date(node.created_at).toLocaleString()
    : '-';

  document.getElementById('reasoning-toggle').classList.remove('expanded');
  document.getElementById('detail-reasoning').classList.remove('visible');

  document.getElementById('detail-similar').innerHTML =
    '<span class="loading-similar">Searching...</span>';
  fetchSimilarDecisions(node.id);

  panel.classList.add('visible');
}

// Fetch similar decisions via API
async function fetchSimilarDecisions(nodeId) {
  try {
    const response = await fetch(`/graph/similar?id=${encodeURIComponent(nodeId)}`);
    const data = await response.json();

    if (data.error) {
      document.getElementById('detail-similar').innerHTML =
        `<span style="color:#666">${data.message || 'Search failed'}</span>`;
      return;
    }

    if (!data.similar || data.similar.length === 0) {
      document.getElementById('detail-similar').innerHTML =
        '<span style="color:#666">No similar decisions found</span>';
      return;
    }

    const html = data.similar
      .map(
        (s) => `
      <div class="similar-item" onclick="navigateToNode('${s.id}')">
        <span class="similar-score">${Math.round(s.similarity * 100)}%</span>
        <div class="similar-topic">${escapeHtml(s.topic)}</div>
        <div class="similar-decision">${escapeHtml(s.decision || '-')}</div>
      </div>
    `
      )
      .join('');

    document.getElementById('detail-similar').innerHTML = html;
  } catch (error) {
    console.error('[MAMA] Similar search error:', error);
    document.getElementById('detail-similar').innerHTML =
      '<span style="color:#f66">Error loading similar decisions</span>';
  }
}

// Navigate to a node in the graph (called from HTML onclick)
// eslint-disable-next-line no-unused-vars
function navigateToNode(nodeId) {
  if (!network || !visNodes) {
    return;
  }

  const node = visNodes.get(nodeId);
  if (!node) {
    filterByTopic('');
    document.getElementById('topic-filter').value = '';
  }

  network.focus(nodeId, { scale: 1.2, animation: true });
  network.selectNodes([nodeId]);

  const nodeData = graphData.nodes.find((n) => n.id === nodeId);
  if (nodeData) {
    showDetail(nodeData);
  }
}

// HTML escape utility
function escapeHtml(text) {
  if (!text) {
    return '';
  }
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function closeDetail() {
  document.getElementById('detail-panel').classList.remove('visible');
  currentNodeId = null;
  resetNodeHighlight();
}

// Toggle legend visibility (called from HTML onclick)
// eslint-disable-next-line no-unused-vars
function toggleLegend() {
  const legend = document.getElementById('legend-panel');
  legend.classList.toggle('collapsed');
}

// Save outcome via API (called from HTML onclick)
// eslint-disable-next-line no-unused-vars
async function saveOutcome() {
  if (!currentNodeId) {
    return;
  }

  const outcomeSelect = document.getElementById('detail-outcome-select');
  const statusEl = document.getElementById('outcome-status');
  const saveBtn = document.querySelector('.save-btn');
  const newOutcome = outcomeSelect.value;

  saveBtn.disabled = true;
  statusEl.textContent = 'Saving...';
  statusEl.className = '';

  try {
    const response = await fetch('/graph/update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: currentNodeId,
        outcome: newOutcome,
      }),
    });

    const result = await response.json();

    if (result.success) {
      statusEl.textContent = '✓ Saved';
      statusEl.className = 'success';

      const node = graphData.nodes.find((n) => n.id === currentNodeId);
      if (node) {
        node.outcome = newOutcome;
      }
    } else {
      statusEl.textContent = result.message || 'Failed';
      statusEl.className = 'error';
    }
  } catch (error) {
    console.error('[MAMA] Save outcome error:', error);
    statusEl.textContent = 'Error: ' + error.message;
    statusEl.className = 'error';
  } finally {
    saveBtn.disabled = false;
    setTimeout(() => {
      if (statusEl.textContent.startsWith('✓')) {
        statusEl.textContent = '';
        statusEl.className = '';
      }
    }, 3000);
  }
}

// Toggle reasoning collapse/expand (called from HTML onclick)
// eslint-disable-next-line no-unused-vars
function toggleReasoning() {
  const toggle = document.getElementById('reasoning-toggle');
  const content = document.getElementById('detail-reasoning');
  toggle.classList.toggle('expanded');
  content.classList.toggle('visible');
}

// Get edges connected to a node (utility function)
// eslint-disable-next-line no-unused-vars
function getConnectedEdges(nodeId) {
  const connected = graphData.edges.filter((e) => e.from === nodeId || e.to === nodeId);
  if (connected.length === 0) {
    return '';
  }

  return connected
    .map((edge) => {
      const isOutgoing = edge.from === nodeId;
      const arrow = isOutgoing ? '→' : '←';
      const targetId = isOutgoing ? edge.to : edge.from;
      const targetNode = graphData.nodes.find((n) => n.id === targetId);
      const targetLabel = targetNode ? targetNode.topic : targetId.substring(0, 20);
      return `<div class="edge-item"><span class="edge-arrow">${arrow}</span><span class="edge-type">${edge.relationship}</span>: ${targetLabel}</div>`;
    })
    .join('');
}

// Topic Dropdown Filter
function populateTopicFilter(topics) {
  const select = document.getElementById('topic-filter');
  topics.forEach((topic) => {
    const option = document.createElement('option');
    option.value = topic;
    option.textContent = topic;
    select.appendChild(option);
  });

  const urlParams = new URLSearchParams(window.location.search);
  const topicParam = urlParams.get('topic');
  if (topicParam) {
    select.value = topicParam;
    filterByTopic(topicParam);
  }
}

let visNodes = null;
let visEdges = null;

function filterByTopic(topic) {
  if (!visNodes) {
    return;
  }

  const url = new URL(window.location);
  if (topic) {
    url.searchParams.set('topic', topic);
  } else {
    url.searchParams.delete('topic');
  }
  history.pushState({}, '', url);

  const updates = graphData.nodes.map((node) => ({
    id: node.id,
    hidden: topic ? node.topic !== topic : false,
    opacity: topic ? (node.topic === topic ? 1 : 0.15) : 1,
  }));
  visNodes.update(updates);

  setTimeout(() => network.fit(), 100);
}

// Keyword Search with debounce
let searchMatches = [];
let searchIndex = 0;

// Core search logic (will be debounced)
function performSearch(query) {
  if (!query) {
    clearHighlight();
    return;
  }

  searchMatches = graphData.nodes
    .filter(
      (node) =>
        (node.topic && node.topic.toLowerCase().includes(query)) ||
        (node.decision && node.decision.toLowerCase().includes(query)) ||
        (node.reasoning && node.reasoning.toLowerCase().includes(query))
    )
    .map((n) => n.id);

  searchIndex = 0;

  if (searchMatches.length > 0) {
    highlightMatches();
    focusMatch();
  } else {
    clearHighlight();
  }

  updateSearchCount();
}

// Debounced search (300ms delay)
const debouncedSearch = debounce(performSearch, 300);

// Handle search input (called from HTML onkeyup)
// eslint-disable-next-line no-unused-vars
function handleSearch(event) {
  const query = event.target.value.toLowerCase().trim();

  if (event.key === 'Escape') {
    closeSearch();
    return;
  }

  if (event.key === 'Enter' && searchMatches.length > 0) {
    searchIndex = (searchIndex + 1) % searchMatches.length;
    focusMatch();
    return;
  }

  // Use debounced search for better performance
  debouncedSearch(query);
}

function highlightMatches() {
  if (!visNodes) {
    return;
  }
  const updates = graphData.nodes.map((node) => ({
    id: node.id,
    opacity: searchMatches.includes(node.id) ? 1 : 0.2,
  }));
  visNodes.update(updates);
  network.selectNodes(searchMatches);
}

function clearHighlight() {
  if (!visNodes) {
    return;
  }
  const updates = graphData.nodes.map((node) => ({
    id: node.id,
    opacity: 1,
  }));
  visNodes.update(updates);
  network.unselectAll();
  searchMatches = [];
}

function focusMatch() {
  if (searchMatches.length === 0) {
    return;
  }
  const nodeId = searchMatches[searchIndex];
  network.focus(nodeId, { scale: 1.2, animation: true });
  network.selectNodes([nodeId]);
  updateSearchCount();
}

function updateSearchCount() {
  const input = document.getElementById('search-input');
  let countEl = document.querySelector('.search-count');
  if (!countEl) {
    countEl = document.createElement('span');
    countEl.className = 'search-count';
    input.parentNode.appendChild(countEl);
  }
  if (searchMatches.length > 0) {
    countEl.textContent = `${searchIndex + 1}/${searchMatches.length}`;
  } else if (input.value) {
    countEl.textContent = 'No matches';
  } else {
    countEl.textContent = '';
  }
}

function openSearch() {
  const input = document.getElementById('search-input');
  input.style.display = 'block';
  input.focus();
}

function closeSearch() {
  const input = document.getElementById('search-input');
  input.style.display = 'none';
  input.value = '';
  clearHighlight();
  updateSearchCount();
}

// Keyboard shortcuts
document.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') {
    if (e.key === 'Escape') {
      closeSearch();
    }
    return;
  }

  if (e.key === '/') {
    e.preventDefault();
    openSearch();
  } else if (e.key === 'Escape') {
    closeSearch();
    closeDetail();
  }
});

// Checkpoint Panel Functions
let checkpointsData = [];

// Toggle checkpoint panel visibility (called from HTML onclick)
// eslint-disable-next-line no-unused-vars
function toggleCheckpoints() {
  const panel = document.getElementById('checkpoint-panel');
  panel.classList.toggle('hidden');
}

// Fetch checkpoints from API
async function fetchCheckpoints() {
  try {
    const response = await fetch('/checkpoints');
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const data = await response.json();
    checkpointsData = data.checkpoints || [];
    renderCheckpoints();
  } catch (error) {
    console.error('[MAMA] Failed to fetch checkpoints:', error);
    document.getElementById('checkpoint-list').innerHTML =
      `<div class="loading-checkpoints" style="color:#f66">Failed to load: ${error.message}</div>`;
  }
}

// Render checkpoints list
function renderCheckpoints() {
  const container = document.getElementById('checkpoint-list');

  if (checkpointsData.length === 0) {
    container.innerHTML = '<div class="loading-checkpoints">No checkpoints found</div>';
    return;
  }

  const html = checkpointsData
    .map(
      (cp, idx) => `
    <div class="checkpoint-item" onclick="expandCheckpoint(${idx})">
      <div class="checkpoint-time">${formatCheckpointTime(cp.timestamp)}</div>
      <div class="checkpoint-summary">${escapeHtml(extractFirstLine(cp.summary))}</div>
      <div class="checkpoint-details">
        ${
          cp.summary
            ? `
          <div class="checkpoint-section">
            <div class="checkpoint-section-title">Summary</div>
            <div class="checkpoint-section-content">${escapeHtml(cp.summary)}</div>
          </div>
        `
            : ''
        }
        ${
          cp.next_steps
            ? `
          <div class="checkpoint-section">
            <div class="checkpoint-section-title">Next Steps</div>
            <div class="checkpoint-section-content">${escapeHtml(cp.next_steps)}</div>
          </div>
        `
            : ''
        }
        ${
          cp.open_files && cp.open_files.length > 0
            ? `
          <div class="checkpoint-section">
            <div class="checkpoint-section-title">Open Files</div>
            <div class="checkpoint-files">
              ${cp.open_files.map((f) => `<span class="checkpoint-file">${escapeHtml(f.split('/').pop())}</span>`).join('')}
            </div>
          </div>
        `
            : ''
        }
        ${renderRelatedDecisions(cp.summary)}
      </div>
    </div>
  `
    )
    .join('');

  container.innerHTML = html;
}

// Format checkpoint timestamp
function formatCheckpointTime(timestamp) {
  const date = new Date(timestamp);
  const now = new Date();
  const diff = now - date;

  if (diff < 3600000) {
    const mins = Math.floor(diff / 60000);
    return `${mins}m ago`;
  }
  if (diff < 86400000) {
    const hours = Math.floor(diff / 3600000);
    return `${hours}h ago`;
  }

  return (
    date.toLocaleDateString() +
    ' ' +
    date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  );
}

// Extract first meaningful line from summary
function extractFirstLine(summary) {
  if (!summary) {
    return 'No summary';
  }
  const lines = summary.split('\n').filter((l) => l.trim() && !l.startsWith('**'));
  return lines[0] || summary.substring(0, 100);
}

// Extract and render related decisions from summary
function renderRelatedDecisions(summary) {
  if (!summary) {
    return '';
  }

  // Match patterns like "decision_xxx" or "Related decisions: xxx, yyy"
  const decisionPattern = /decision_[a-z0-9_]+/gi;
  const matches = summary.match(decisionPattern);

  if (!matches || matches.length === 0) {
    return '';
  }

  const uniqueDecisions = [...new Set(matches)];

  return `
    <div class="checkpoint-section">
      <div class="checkpoint-section-title">Related Decisions</div>
      <div class="checkpoint-related">
        ${uniqueDecisions.map((d) => `<span class="checkpoint-related-link" onclick="event.stopPropagation(); navigateToDecision('${d}')">${d.substring(9, 30)}...</span>`).join('')}
      </div>
    </div>
  `;
}

// Expand/collapse checkpoint item
// eslint-disable-next-line no-unused-vars
function expandCheckpoint(idx) {
  const items = document.querySelectorAll('.checkpoint-item');
  items.forEach((item, i) => {
    if (i === idx) {
      item.classList.toggle('expanded');
    } else {
      item.classList.remove('expanded');
    }
  });
}

// Navigate to a decision in the graph (from checkpoint related link)
// eslint-disable-next-line no-unused-vars
function navigateToDecision(decisionId) {
  // Close checkpoint panel
  document.getElementById('checkpoint-panel').classList.remove('visible');

  // Use existing navigateToNode function
  navigateToNode(decisionId);
}

// Make detail panel draggable
function initDraggablePanel() {
  const panel = document.getElementById('detail-panel');
  const header = panel.querySelector('h3');
  let isDragging = false;
  let offsetX, offsetY;

  header.addEventListener('mousedown', (e) => {
    isDragging = true;
    offsetX = e.clientX - panel.offsetLeft;
    offsetY = e.clientY - panel.offsetTop;
    panel.style.transition = 'none';
  });

  document.addEventListener('mousemove', (e) => {
    if (!isDragging) {
      return;
    }
    const x = Math.max(0, Math.min(e.clientX - offsetX, window.innerWidth - panel.offsetWidth));
    const y = Math.max(50, Math.min(e.clientY - offsetY, window.innerHeight - panel.offsetHeight));
    panel.style.left = x + 'px';
    panel.style.top = y + 'px';
    panel.style.right = 'auto';
  });

  document.addEventListener('mouseup', () => {
    isDragging = false;
    panel.style.transition = '';
  });
}

// Initialize on page load
document.addEventListener('DOMContentLoaded', async () => {
  // Initialize draggable panel
  initDraggablePanel();

  // Load checkpoints (panel is visible by default)
  fetchCheckpoints();

  try {
    const data = await fetchGraphData();
    if (data.nodes.length === 0) {
      document.getElementById('loading').innerHTML =
        '<div class="error">No decisions found. Start making decisions with MAMA!</div>';
      return;
    }
    initGraph(data);
  } catch (error) {
    document.getElementById('loading').innerHTML =
      `<div class="error">Failed to load graph: ${error.message}<br><br><button onclick="location.reload()" style="padding:8px 16px;cursor:pointer;">Retry</button></div>`;
  }
});
