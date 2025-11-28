/**
 * MAMA Graph Viewer JavaScript
 * @version 1.5.0 - Refactored with ES6 modules
 */

/* eslint-env browser */
/* global vis */

// Import utilities
import {
  escapeHtml,
  debounce,
  showToast,
  scrollToBottom,
  autoResizeTextarea,
} from './js/utils/dom.js';
import {
  formatMessageTime,
  formatCheckpointTime,
  formatRelativeTime,
  truncateText,
  extractFirstLine,
  formatAssistantMessage,
} from './js/utils/format.js';
import { API } from './js/utils/api.js';

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

// Fetch graph data from API
async function fetchGraphData() {
  try {
    graphData = await API.getGraph();
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
    const data = await API.getSimilarDecisions(nodeId);

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
    const result = await API.updateOutcome(currentNodeId, newOutcome);

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

// Sidebar Panel Functions
let checkpointsData = [];

// Toggle sidebar visibility (called from HTML onclick)
// eslint-disable-next-line no-unused-vars
function toggleSidebar() {
  const panel = document.getElementById('sidebar-panel');
  panel.classList.toggle('hidden');
}

// Legacy function name for backwards compatibility
// eslint-disable-next-line no-unused-vars
function toggleCheckpoints() {
  toggleSidebar();
}

// Switch between tabs (called from HTML onclick)
// eslint-disable-next-line no-unused-vars
function switchTab(tabName) {
  // Update tab buttons
  const tabs = document.querySelectorAll('.sidebar-tab');
  tabs.forEach((tab) => {
    if (tab.dataset.tab === tabName) {
      tab.classList.add('active');
    } else {
      tab.classList.remove('active');
    }
  });

  // Update tab content
  const contents = document.querySelectorAll('.tab-content');
  contents.forEach((content) => {
    if (content.id === `tab-${tabName}`) {
      content.classList.add('active');
    } else {
      content.classList.remove('active');
    }
  });

  // Initialize chat when chat tab is selected
  if (tabName === 'chat' && !chatWs) {
    initChatSession();
  }
}

// Initialize chat session (create session if needed, then connect WebSocket)
async function initChatSession() {
  // Check for saved session ID in localStorage
  const savedSessionId = localStorage.getItem('mama_chat_session_id');

  if (savedSessionId) {
    // Try to use existing session
    console.log('[Chat] Trying saved session:', savedSessionId);
    addSystemMessage('Connecting to session...');
    initChatWebSocket(savedSessionId);
  } else {
    // Create new session
    try {
      addSystemMessage('Creating new session...');
      // Use root directory as default project dir (server will resolve)
      const data = await API.createSession('.');
      const sessionId = data.sessionId;

      console.log('[Chat] Created new session:', sessionId);
      localStorage.setItem('mama_chat_session_id', sessionId);

      // Connect WebSocket
      initChatWebSocket(sessionId);
    } catch (error) {
      console.error('[Chat] Failed to create session:', error);
      addSystemMessage(`Failed to create session: ${error.message}`, 'error');
    }
  }
}

// =============================================
// Chat WebSocket Implementation (Story 2-3)
// =============================================

// Chat state
let chatWs = null;
let chatSessionId = null;
let chatReconnectAttempts = 0;
const CHAT_MAX_RECONNECT_DELAY = 30000; // 30 seconds max

// Initialize chat WebSocket connection
function initChatWebSocket(sessionId) {
  if (chatWs && chatWs.readyState === WebSocket.OPEN) {
    console.log('[Chat] Already connected');
    return;
  }

  chatSessionId = sessionId;

  // Try to restore history from localStorage
  restoreChatHistory(sessionId);

  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${window.location.host}/ws?sessionId=${sessionId}`;

  console.log('[Chat] Connecting to:', wsUrl);
  chatWs = new WebSocket(wsUrl);

  chatWs.onopen = () => {
    console.log('[Chat] Connected');
    chatReconnectAttempts = 0;
    updateChatStatus('connected');
    enableChatInput(true);

    // Attach to session
    chatWs.send(
      JSON.stringify({
        type: 'attach',
        sessionId: sessionId,
      })
    );
  };

  chatWs.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      handleChatMessage(data);
    } catch (e) {
      console.error('[Chat] Parse error:', e);
    }
  };

  chatWs.onclose = (event) => {
    console.log('[Chat] Disconnected:', event.code, event.reason);
    updateChatStatus('disconnected');
    enableChatInput(false);

    // Auto-reconnect with exponential backoff
    if (chatSessionId) {
      scheduleReconnect();
    }
  };

  chatWs.onerror = (error) => {
    console.error('[Chat] WebSocket error:', error);
    updateChatStatus('disconnected');
  };
}

// Handle incoming chat messages
function handleChatMessage(data) {
  switch (data.type) {
    case 'attached':
      console.log('[Chat] Attached to session:', data.sessionId);
      addSystemMessage(`Connected to session`);
      break;

    case 'output':
      // Claude's response - streaming output from daemon
      if (data.content) {
        // Re-enable send button on first output
        enableChatSend(true);
        // Use streaming for smooth rendering
        appendStreamChunk(data.content);
      }
      break;

    case 'stream':
      // Streaming response chunk - Story 2-4
      appendStreamChunk(data.content);
      break;

    case 'stream_end':
      // End of streaming - Story 2-4
      finalizeStreamMessage();
      break;

    case 'error':
      if (data.error === 'session_not_found') {
        // Session expired, clear saved session and create new one
        console.log('[Chat] Session not found, creating new one...');
        localStorage.removeItem('mama_chat_session_id');
        addSystemMessage('Session expired. Creating new session...');

        // Close current WebSocket and create new session
        if (chatWs) {
          chatWs.close();
          chatWs = null;
        }

        // Wait a bit then create new session
        setTimeout(() => initChatSession(), 500);
      } else {
        addSystemMessage(`Error: ${data.message || data.error}`, 'error');
        enableChatSend(true);
      }
      break;

    case 'pong':
      // Heartbeat response, ignore
      break;

    default:
      console.log('[Chat] Unknown message type:', data.type);
  }
}

// Schedule reconnection with exponential backoff
function scheduleReconnect() {
  const delay = Math.min(1000 * Math.pow(2, chatReconnectAttempts), CHAT_MAX_RECONNECT_DELAY);
  chatReconnectAttempts++;

  console.log(`[Chat] Reconnecting in ${delay}ms (attempt ${chatReconnectAttempts})`);
  addSystemMessage(`Connection lost. Reconnecting in ${Math.round(delay / 1000)}s...`, 'warning');

  setTimeout(() => {
    if (chatSessionId) {
      initChatWebSocket(chatSessionId);
    }
  }, delay);
}

// Update chat connection status UI
function updateChatStatus(status) {
  const statusEl = document.getElementById('chat-status');
  const indicator = statusEl.querySelector('.status-indicator');
  const text = statusEl.querySelector('span:last-child');

  indicator.className = 'status-indicator ' + status;

  switch (status) {
    case 'connected':
      text.textContent = 'Connected';
      break;
    case 'disconnected':
      text.textContent = 'Disconnected';
      break;
    case 'connecting':
      text.textContent = 'Connecting...';
      break;
    default:
      text.textContent = status;
  }
}

// Enable/disable chat input
function enableChatInput(enabled) {
  const input = document.getElementById('chat-input');
  const sendBtn = document.getElementById('chat-send');

  input.disabled = !enabled;
  sendBtn.disabled = !enabled;

  if (enabled) {
    input.placeholder = 'Type your message...';
  } else {
    input.placeholder = 'Connect to a session to chat';
  }
}

// Enable/disable send button (for loading state)
function enableChatSend(enabled) {
  const sendBtn = document.getElementById('chat-send');
  sendBtn.disabled = !enabled;
  // Note: Mic button is always enabled (voice input works without session)

  if (enabled) {
    sendBtn.textContent = 'Send';
    sendBtn.classList.remove('loading');
  } else {
    sendBtn.textContent = 'Sending...';
    sendBtn.classList.add('loading');
  }
}

// Send chat message (called from HTML onclick and Enter key)
// eslint-disable-next-line no-unused-vars
function sendChatMessage() {
  const input = document.getElementById('chat-input');
  const message = input.value.trim();

  if (!message) {
    return;
  }

  if (!chatWs || chatWs.readyState !== WebSocket.OPEN) {
    addSystemMessage('Not connected. Please connect to a session first.', 'error');
    return;
  }

  // Optimistic UI: show user message immediately
  addUserMessage(message);

  // Disable send button (loading state)
  enableChatSend(false);

  // Send via WebSocket
  chatWs.send(
    JSON.stringify({
      type: 'send',
      sessionId: chatSessionId,
      content: message,
    })
  );

  // Search for related MAMA decisions (Story 4-1)
  showRelatedDecisionsForMessage(message);

  // Clear input and reset height
  input.value = '';
  autoResizeTextarea(input);

  console.log('[Chat] Sent:', message);
}

// Add user message to chat
function addUserMessage(text) {
  const container = document.getElementById('chat-messages');
  removePlaceholder();

  const timestamp = new Date();
  const msgEl = document.createElement('div');
  msgEl.className = 'chat-message user';
  msgEl.innerHTML = `
    <div class="message-content">${escapeHtml(text)}</div>
    <div class="message-time">${formatMessageTime(timestamp)}</div>
  `;

  container.appendChild(msgEl);
  scrollToBottom(container);

  // Save to history
  saveToHistory('user', text, timestamp);
}

// Add assistant message to chat
// eslint-disable-next-line no-unused-vars
function addAssistantMessage(text) {
  const container = document.getElementById('chat-messages');
  removePlaceholder();

  // Re-enable send button when response received
  enableChatSend(true);

  const timestamp = new Date();
  const msgEl = document.createElement('div');
  msgEl.className = 'chat-message assistant';
  msgEl.innerHTML = `
    <div class="message-content">${formatAssistantMessage(text)}</div>
    <div class="message-time">${formatMessageTime(timestamp)}</div>
  `;

  container.appendChild(msgEl);
  scrollToBottom(container);

  // Save to history
  saveToHistory('assistant', text, timestamp);
}

// Stream handling variables (Story 2-4)
let currentStreamEl = null;
let currentStreamText = '';
let streamBuffer = '';
let rafPending = false;

// Append streaming chunk with requestAnimationFrame batching
function appendStreamChunk(content) {
  const container = document.getElementById('chat-messages');

  // Initialize stream element if needed
  if (!currentStreamEl) {
    removePlaceholder();
    currentStreamEl = document.createElement('div');
    currentStreamEl.className = 'chat-message assistant streaming';
    currentStreamEl.innerHTML = `
      <div class="message-content"></div>
      <div class="message-time">${formatMessageTime(new Date())}</div>
    `;
    container.appendChild(currentStreamEl);
    currentStreamText = '';
    streamBuffer = '';
  }

  // Buffer the content
  streamBuffer += content;

  // Use requestAnimationFrame to batch renders (60fps max)
  if (!rafPending) {
    rafPending = true;
    requestAnimationFrame(() => {
      if (streamBuffer) {
        currentStreamText += streamBuffer;
        streamBuffer = '';

        const contentEl = currentStreamEl.querySelector('.message-content');
        contentEl.innerHTML = formatAssistantMessage(currentStreamText);

        // Smooth scroll to bottom
        container.scrollTo({
          top: container.scrollHeight,
          behavior: 'smooth',
        });
      }
      rafPending = false;
    });
  }
}

// Finalize streaming message
function finalizeStreamMessage() {
  // Flush any remaining buffer
  if (streamBuffer && currentStreamEl) {
    currentStreamText += streamBuffer;
    const contentEl = currentStreamEl.querySelector('.message-content');
    contentEl.innerHTML = formatAssistantMessage(currentStreamText);
  }

  // Save the complete streamed message to history
  if (currentStreamText) {
    saveToHistory('assistant', currentStreamText);
  }

  if (currentStreamEl) {
    currentStreamEl.classList.remove('streaming');
    currentStreamEl = null;
    currentStreamText = '';
    streamBuffer = '';
  }
  rafPending = false;
  enableChatSend(true);
}

// Add system message (info, warning, error)
function addSystemMessage(text, type = 'info') {
  const container = document.getElementById('chat-messages');
  removePlaceholder();

  const msgEl = document.createElement('div');
  msgEl.className = `chat-message system ${type}`;
  msgEl.innerHTML = `
    <div class="message-content">${escapeHtml(text)}</div>
  `;

  container.appendChild(msgEl);
  scrollToBottom(container);
}

// Remove placeholder if present
function removePlaceholder() {
  const placeholder = document.querySelector('.chat-placeholder');
  if (placeholder) {
    placeholder.remove();
  }
}

// Handle chat input keydown (Enter/Shift+Enter)
function handleChatInputKeydown(event) {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    sendChatMessage();
  }
  // Shift+Enter will naturally create newline
}

// Initialize chat input handlers
function initChatInput() {
  const input = document.getElementById('chat-input');

  // Auto-resize on input
  input.addEventListener('input', () => {
    autoResizeTextarea(input);
  });

  // Handle Enter key
  input.addEventListener('keydown', handleChatInputKeydown);
}

// ============================================
// Voice Input (Story 3.1)
// ============================================

let speechRecognition = null;
let isRecording = false;
let silenceTimeout = null;
const SILENCE_DELAY = 1500; // 1.5 seconds of silence to auto-stop

// Initialize speech recognition
function initSpeechRecognition() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

  if (!SpeechRecognition) {
    console.warn('[Voice] SpeechRecognition not supported in this browser');
    const micBtn = document.getElementById('chat-mic');
    if (micBtn) {
      micBtn.style.display = 'none';
    }
    return;
  }

  speechRecognition = new SpeechRecognition();
  speechRecognition.lang = 'ko-KR'; // Korean
  speechRecognition.continuous = false;
  speechRecognition.interimResults = true;

  // Handle results
  speechRecognition.onresult = (event) => {
    const input = document.getElementById('chat-input');
    let interimTranscript = '';
    let finalTranscript = '';

    for (let i = event.resultIndex; i < event.results.length; i++) {
      const result = event.results[i];
      if (result.isFinal) {
        finalTranscript += result[0].transcript;
      } else {
        interimTranscript += result[0].transcript;
      }
    }

    // Update input field with combined text
    if (finalTranscript) {
      input.value = finalTranscript;
      input.classList.remove('voice-active');
    } else if (interimTranscript) {
      input.value = interimTranscript;
      input.classList.add('voice-active');
    }

    autoResizeTextarea(input);

    // Reset silence timer on any result
    clearTimeout(silenceTimeout);
    silenceTimeout = setTimeout(() => {
      if (isRecording) {
        stopVoiceRecording();
      }
    }, SILENCE_DELAY);
  };

  // Handle end event
  speechRecognition.onend = () => {
    console.log('[Voice] Recognition ended');
    stopVoiceRecording();
  };

  // Handle errors
  speechRecognition.onerror = (event) => {
    console.error('[Voice] Error:', event.error);
    stopVoiceRecording();

    let errorMessage = '';
    switch (event.error) {
      case 'not-allowed':
        errorMessage = '마이크 권한이 거부되었습니다. 브라우저 설정에서 마이크를 허용해주세요.';
        break;
      case 'no-speech':
        errorMessage = '음성이 감지되지 않았습니다. 다시 시도해주세요.';
        break;
      case 'network':
        errorMessage = '네트워크 오류가 발생했습니다.';
        break;
      default:
        errorMessage = `음성 인식 오류: ${event.error}`;
    }

    addSystemMessage(errorMessage, 'error');
  };

  console.log('[Voice] SpeechRecognition initialized (lang: ko-KR)');
}

// Toggle voice input (called from HTML onclick)
// eslint-disable-next-line no-unused-vars
function toggleVoiceInput() {
  if (isRecording) {
    stopVoiceRecording();
  } else {
    startVoiceRecording();
  }
}

// Start voice recording
function startVoiceRecording() {
  if (!speechRecognition) {
    addSystemMessage('이 브라우저에서는 음성 인식이 지원되지 않습니다.', 'error');
    return;
  }

  try {
    speechRecognition.start();
    isRecording = true;

    const micBtn = document.getElementById('chat-mic');
    const input = document.getElementById('chat-input');

    micBtn.classList.add('recording');
    input.classList.add('voice-active');
    input.placeholder = '말씀해주세요...';

    console.log('[Voice] Recording started');

    // Auto-stop after silence
    silenceTimeout = setTimeout(() => {
      if (isRecording) {
        stopVoiceRecording();
      }
    }, SILENCE_DELAY);
  } catch (err) {
    console.error('[Voice] Failed to start:', err);
    addSystemMessage('음성 인식을 시작할 수 없습니다.', 'error');
  }
}

// Stop voice recording
function stopVoiceRecording() {
  if (!isRecording) {
    return;
  }

  clearTimeout(silenceTimeout);

  try {
    speechRecognition.stop();
  } catch (e) {
    // Ignore errors when stopping
  }

  isRecording = false;

  const micBtn = document.getElementById('chat-mic');
  const input = document.getElementById('chat-input');

  micBtn.classList.remove('recording');
  input.classList.remove('voice-active');
  input.placeholder = 'Type your message...';

  console.log('[Voice] Recording stopped');
}

// Enable/disable mic button based on connection
// eslint-disable-next-line no-unused-vars
function enableMicButton(enabled) {
  const micBtn = document.getElementById('chat-mic');
  if (micBtn) {
    micBtn.disabled = !enabled;
  }
}

// Connect to session (can be called from console or UI)
// eslint-disable-next-line no-unused-vars
function connectToSession(sessionId) {
  initChatWebSocket(sessionId);
}

// Disconnect from session
// eslint-disable-next-line no-unused-vars
function disconnectChat() {
  if (chatWs) {
    chatSessionId = null; // Prevent auto-reconnect
    chatWs.close();
    chatWs = null;
  }
  updateChatStatus('disconnected');
  enableChatInput(false);
}

// =============================================
// Conversation History Management (Story 2-5)
// =============================================

const CHAT_HISTORY_PREFIX = 'mama_chat_history_';
const MAX_HISTORY_MESSAGES = 50;
const HISTORY_EXPIRY_MS = 24 * 60 * 60 * 1000; // 24 hours

// Message history for current session
let chatHistory = [];

// Save message to history
function saveToHistory(role, content, timestamp = new Date()) {
  if (!chatSessionId) {
    return;
  }

  chatHistory.push({
    role,
    content,
    timestamp: timestamp.toISOString(),
  });

  // Trim to max messages
  if (chatHistory.length > MAX_HISTORY_MESSAGES) {
    chatHistory = chatHistory.slice(-MAX_HISTORY_MESSAGES);
  }

  // Save to localStorage
  try {
    const storageKey = CHAT_HISTORY_PREFIX + chatSessionId;
    const storageData = {
      history: chatHistory,
      savedAt: Date.now(),
    };
    localStorage.setItem(storageKey, JSON.stringify(storageData));
  } catch (e) {
    console.warn('[Chat] Failed to save history:', e);
  }
}

// Load history from localStorage
function loadHistory(sessionId) {
  try {
    const storageKey = CHAT_HISTORY_PREFIX + sessionId;
    const stored = localStorage.getItem(storageKey);

    if (!stored) {
      return null;
    }

    const data = JSON.parse(stored);

    // Check expiry
    if (Date.now() - data.savedAt > HISTORY_EXPIRY_MS) {
      localStorage.removeItem(storageKey);
      return null;
    }

    return data.history || [];
  } catch (e) {
    console.warn('[Chat] Failed to load history:', e);
    return null;
  }
}

// Restore chat history from localStorage
function restoreChatHistory(sessionId) {
  const history = loadHistory(sessionId);

  if (!history || history.length === 0) {
    return false;
  }

  chatHistory = history;
  const container = document.getElementById('chat-messages');

  // Remove placeholder
  removePlaceholder();

  // Render all historical messages
  history.forEach((msg) => {
    const msgEl = document.createElement('div');
    msgEl.className = `chat-message ${msg.role}`;

    if (msg.role === 'user') {
      msgEl.innerHTML = `
        <div class="message-content">${escapeHtml(msg.content)}</div>
        <div class="message-time">${formatMessageTime(new Date(msg.timestamp))}</div>
      `;
    } else if (msg.role === 'assistant') {
      msgEl.innerHTML = `
        <div class="message-content">${formatAssistantMessage(msg.content)}</div>
        <div class="message-time">${formatMessageTime(new Date(msg.timestamp))}</div>
      `;
    } else if (msg.role === 'system') {
      msgEl.innerHTML = `
        <div class="message-content">${escapeHtml(msg.content)}</div>
      `;
    }

    container.appendChild(msgEl);
  });

  // Scroll to bottom
  scrollToBottom(container);

  // Show toast notification
  showToast('Previous conversation restored');

  return true;
}

// Show toast notification

// Clear chat history for a session
// eslint-disable-next-line no-unused-vars
function clearChatHistory(sessionId) {
  try {
    const storageKey = CHAT_HISTORY_PREFIX + (sessionId || chatSessionId);
    localStorage.removeItem(storageKey);
    chatHistory = [];
  } catch (e) {
    console.warn('[Chat] Failed to clear history:', e);
  }
}

// Clean up expired histories (call periodically)
function cleanupExpiredHistories() {
  try {
    const keys = Object.keys(localStorage);
    const now = Date.now();

    keys.forEach((key) => {
      if (key.startsWith(CHAT_HISTORY_PREFIX)) {
        try {
          const data = JSON.parse(localStorage.getItem(key));
          if (now - data.savedAt > HISTORY_EXPIRY_MS) {
            localStorage.removeItem(key);
            console.log('[Chat] Cleaned up expired history:', key);
          }
        } catch (e) {
          // Invalid data, remove it
          localStorage.removeItem(key);
        }
      }
    });
  } catch (e) {
    console.warn('[Chat] Failed to cleanup histories:', e);
  }
}

// Fetch checkpoints from API
async function fetchCheckpoints() {
  try {
    const data = await API.getCheckpoints();
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

// Extract first meaningful line from summary

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
  // Close sidebar panel
  const sidebarPanel = document.getElementById('sidebar-panel');
  if (sidebarPanel) {
    sidebarPanel.classList.remove('visible');
  }

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

// =============================================
// Memory Tab Functions (Story 4-1)
// =============================================

let memorySearchData = [];
const debouncedMemorySearch = debounce(performMemorySearch, 300);

// Handle memory search input (called from HTML onkeyup)
// eslint-disable-next-line no-unused-vars
function handleMemorySearch(event) {
  if (event.key === 'Enter') {
    searchMemoryDecisions();
  } else {
    debouncedMemorySearch();
  }
}

// Perform memory search
async function performMemorySearch() {
  const input = document.getElementById('memory-search-input');
  const query = input.value.trim();

  if (!query) {
    showMemoryPlaceholder();
    return;
  }

  await searchMemoryDecisions();
}

// Search memory decisions via API (called from HTML onclick)
// eslint-disable-next-line no-unused-vars
async function searchMemoryDecisions() {
  const input = document.getElementById('memory-search-input');
  const query = input.value.trim();

  if (!query) {
    showMemoryPlaceholder();
    return;
  }

  setMemoryStatus('Searching...', 'loading');

  try {
    const data = await API.searchMemory(query, 10);
    memorySearchData = data.results || [];
    renderMemoryResults(memorySearchData, query);
    setMemoryStatus(`Found ${memorySearchData.length} decision(s)`, '');
  } catch (error) {
    console.error('[Memory] Search error:', error);
    setMemoryStatus(`Error: ${error.message}`, 'error');
  }
}

// Search for related decisions (called automatically when user sends chat message)
async function searchRelatedDecisions(message) {
  if (!message || message.length < 3) {
    return [];
  }

  try {
    const data = await API.searchMemory(message, 5);
    return data.results || [];
  } catch (error) {
    console.error('[Memory] Related search error:', error);
    return [];
  }
}

// Render memory search results
function renderMemoryResults(results, query) {
  const container = document.getElementById('memory-results');

  if (!results || results.length === 0) {
    container.innerHTML = `
      <div class="memory-placeholder">
        <p>No decisions found for "${escapeHtml(query)}"</p>
        <p class="memory-hint">Try different keywords or check if you have saved decisions</p>
      </div>
    `;
    return;
  }

  const html = results
    .map(
      (item, idx) => `
      <div class="memory-card" onclick="toggleMemoryCard(${idx})">
        <div class="memory-card-header">
          <span class="memory-card-topic">${escapeHtml(item.topic || 'Unknown')}</span>
          ${item.similarity ? `<span class="memory-card-score">${Math.round(item.similarity * 100)}%</span>` : ''}
        </div>
        <div class="memory-card-decision">${escapeHtml(truncateText(item.decision, 150))}</div>
        <div class="memory-card-meta">
          <span class="memory-card-outcome ${(item.outcome || 'pending').toLowerCase()}">${item.outcome || 'PENDING'}</span>
          <span>${formatRelativeTime(item.created_at)}</span>
        </div>
        <div class="memory-card-reasoning">${escapeHtml(item.reasoning || 'No reasoning provided')}</div>
      </div>
    `
    )
    .join('');

  container.innerHTML = html;
}

// Toggle memory card expand/collapse (called from HTML onclick)
// eslint-disable-next-line no-unused-vars
function toggleMemoryCard(idx) {
  const cards = document.querySelectorAll('.memory-card');
  cards.forEach((card, i) => {
    if (i === idx) {
      card.classList.toggle('expanded');
    } else {
      card.classList.remove('expanded');
    }
  });
}

// Show memory placeholder
function showMemoryPlaceholder() {
  const container = document.getElementById('memory-results');
  container.innerHTML = `
    <div class="memory-placeholder">
      <p>🧠 Search your MAMA decisions</p>
      <p class="memory-hint">Type a keyword or send a chat message to see related decisions</p>
    </div>
  `;
  setMemoryStatus('', '');
}

// Set memory status message
function setMemoryStatus(message, type) {
  const status = document.getElementById('memory-status');
  status.textContent = message;
  status.className = 'memory-status ' + (type || '');
}

// Truncate text with ellipsis

// Format relative time

// Show related decisions in Memory tab when user sends a message
async function showRelatedDecisionsForMessage(message) {
  // Switch to memory tab to show related decisions
  const results = await searchRelatedDecisions(message);

  if (results.length > 0) {
    memorySearchData = results;

    // Update search input with the query
    const input = document.getElementById('memory-search-input');
    input.value = message.substring(0, 50) + (message.length > 50 ? '...' : '');

    // Render results
    renderMemoryResults(results, message);
    setMemoryStatus(`${results.length} related decision(s) found`, '');

    // Show notification that related decisions were found
    showToast(`🧠 ${results.length} related MAMA decision(s) found`);
  }
}

// =============================================
// Save Decision Form Functions (Story 4-2)
// =============================================

// Show save decision form modal (called from HTML onclick)
// eslint-disable-next-line no-unused-vars
function showSaveDecisionForm() {
  const modal = document.getElementById('save-decision-modal');
  modal.classList.add('visible');

  // Clear form
  document.getElementById('save-topic').value = '';
  document.getElementById('save-decision').value = '';
  document.getElementById('save-reasoning').value = '';
  document.getElementById('save-confidence').value = '0.8';
  document.getElementById('save-form-status').textContent = '';
  document.getElementById('save-form-status').className = 'save-form-status';

  // Focus on topic field
  setTimeout(() => {
    document.getElementById('save-topic').focus();
  }, 100);
}

// Hide save decision form modal (called from HTML onclick)
// eslint-disable-next-line no-unused-vars
function hideSaveDecisionForm() {
  const modal = document.getElementById('save-decision-modal');
  modal.classList.remove('visible');
}

// Submit save decision form (called from HTML onclick)
// eslint-disable-next-line no-unused-vars
async function submitSaveDecision() {
  const topic = document.getElementById('save-topic').value.trim();
  const decision = document.getElementById('save-decision').value.trim();
  const reasoning = document.getElementById('save-reasoning').value.trim();
  const confidence = parseFloat(document.getElementById('save-confidence').value);

  const statusEl = document.getElementById('save-form-status');
  const submitBtn = document.querySelector('.save-form-submit');

  // Validation
  if (!topic || !decision || !reasoning) {
    statusEl.textContent = 'Please fill in all required fields';
    statusEl.className = 'save-form-status error';
    return;
  }

  if (isNaN(confidence) || confidence < 0 || confidence > 1) {
    statusEl.textContent = 'Confidence must be between 0.0 and 1.0';
    statusEl.className = 'save-form-status error';
    return;
  }

  // Disable submit button
  submitBtn.disabled = true;
  statusEl.textContent = 'Saving...';
  statusEl.className = 'save-form-status';

  try {
    await API.saveDecision({ topic, decision, reasoning, confidence });

    // Success
    statusEl.textContent = '✓ Decision saved successfully!';
    statusEl.className = 'save-form-status success';

    // Show toast notification
    showToast('✓ Decision saved to MAMA memory');

    // Close modal after 1.5 seconds
    setTimeout(() => {
      hideSaveDecisionForm();

      // Refresh memory search if there's a query
      const searchInput = document.getElementById('memory-search-input');
      if (searchInput.value.trim()) {
        searchMemoryDecisions();
      }
    }, 1500);
  } catch (error) {
    console.error('[Memory] Save error:', error);
    statusEl.textContent = `Error: ${error.message}`;
    statusEl.className = 'save-form-status error';
  } finally {
    submitBtn.disabled = false;
  }
}

// Close modal when clicking outside
document.addEventListener('click', (e) => {
  const modal = document.getElementById('save-decision-modal');
  if (modal && e.target === modal) {
    hideSaveDecisionForm();
  }
});

// Close modal on Escape key
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    const modal = document.getElementById('save-decision-modal');
    if (modal && modal.classList.contains('visible')) {
      hideSaveDecisionForm();
    }
  }
});

// Initialize on page load
document.addEventListener('DOMContentLoaded', async () => {
  // Initialize draggable panel
  initDraggablePanel();

  // Initialize chat input handlers
  initChatInput();

  // Initialize speech recognition (Story 3.1)
  initSpeechRecognition();

  // Clean up expired chat histories
  cleanupExpiredHistories();

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

// =============================================
// Export functions to window for HTML onclick handlers
// =============================================
window.filterByTopic = filterByTopic;
window.handleSearch = handleSearch;
window.closeDetail = closeDetail;
window.toggleLegend = toggleLegend;
window.saveOutcome = saveOutcome;
window.toggleReasoning = toggleReasoning;
window.navigateToNode = navigateToNode;
window.getConnectedEdges = getConnectedEdges;
window.handleMemorySearch = handleMemorySearch;
window.searchMemoryDecisions = searchMemoryDecisions;
window.toggleMemoryCard = toggleMemoryCard;
window.showSaveDecisionForm = showSaveDecisionForm;
window.hideSaveDecisionForm = hideSaveDecisionForm;
window.submitSaveDecision = submitSaveDecision;
window.toggleSidebar = toggleSidebar;
window.toggleCheckpoints = toggleCheckpoints;
window.switchTab = switchTab;
window.expandCheckpoint = expandCheckpoint;
window.navigateToDecision = navigateToDecision;
window.addAssistantMessage = addAssistantMessage;
window.sendChatMessage = sendChatMessage;
window.toggleVoiceInput = toggleVoiceInput;
window.enableMicButton = enableMicButton;
window.connectToSession = connectToSession;
window.disconnectChat = disconnectChat;
window.clearChatHistory = clearChatHistory;
