/**
 * MAMA Graph Viewer JavaScript
 * @version 1.5.4 - Fully modularized architecture (Phase 5 완료)
 */

/* eslint-env browser */

// Import modules
import { escapeHtml } from './js/utils/dom.js';
import { formatCheckpointTime, extractFirstLine } from './js/utils/format.js';
import { API } from './js/utils/api.js';
import { MemoryModule } from './js/modules/memory.js';
import { ChatModule } from './js/modules/chat.js';
import { GraphModule } from './js/modules/graph.js';

// Module instances
let memoryModule = null;
let chatModule = null;
let graphModule = null;

// Checkpoints data
let checkpointsData = [];

// =============================================
// Sidebar & Tab Management
// =============================================

function toggleSidebar() {
  const panel = document.getElementById('sidebar-panel');
  panel.classList.toggle('hidden');
}

function toggleCheckpoints() {
  toggleSidebar();
}

function switchTab(tabName) {
  const tabs = document.querySelectorAll('.sidebar-tab');
  tabs.forEach((tab) => {
    tab.classList[tab.dataset.tab === tabName ? 'add' : 'remove']('active');
  });

  const contents = document.querySelectorAll('.tab-content');
  contents.forEach((content) => {
    content.classList[content.id === `tab-${tabName}` ? 'add' : 'remove']('active');
  });

  if (tabName === 'chat' && chatModule && !chatModule.ws) {
    chatModule.initSession();
  }
}

// =============================================
// Checkpoints Management
// =============================================

async function fetchCheckpoints() {
  try {
    const data = await API.getCheckpoints();
    checkpointsData = data.checkpoints || [];
    renderCheckpoints();
  } catch (error) {
    console.error('[MAMA] Failed to fetch checkpoints:', error);
    document.getElementById('checkpoint-list').innerHTML =
      '<div class="loading-checkpoints" style="color:#f66">Failed to load</div>';
  }
}

function renderCheckpoints() {
  const container = document.getElementById('checkpoint-list');

  if (checkpointsData.length === 0) {
    container.innerHTML = '<div class="loading-checkpoints">No checkpoints found</div>';
    return;
  }

  const html = checkpointsData
    .map(
      (cp, idx) => `
    <div class="checkpoint-item" onclick="window.expandCheckpoint(${idx})">
      <div class="checkpoint-time">${formatCheckpointTime(cp.timestamp)}</div>
      <div class="checkpoint-summary">${escapeHtml(extractFirstLine(cp.summary))}</div>
      <div class="checkpoint-details">
        ${cp.summary ? `<div class="checkpoint-section"><div class="checkpoint-section-title">Summary</div><div class="checkpoint-section-content">${escapeHtml(cp.summary)}</div></div>` : ''}
        ${cp.next_steps ? `<div class="checkpoint-section"><div class="checkpoint-section-title">Next Steps</div><div class="checkpoint-section-content">${escapeHtml(cp.next_steps)}</div></div>` : ''}
        ${cp.open_files && cp.open_files.length > 0 ? `<div class="checkpoint-section"><div class="checkpoint-section-title">Open Files</div><div class="checkpoint-files">${cp.open_files.map((f) => `<span class="checkpoint-file">${escapeHtml(f.split('/').pop())}</span>`).join('')}</div></div>` : ''}
        ${renderRelatedDecisions(cp.summary)}
      </div>
    </div>
  `
    )
    .join('');

  container.innerHTML = html;
}

function renderRelatedDecisions(summary) {
  if (!summary) {
    return '';
  }
  const matches = summary.match(/decision_[a-z0-9_]+/gi);
  if (!matches || matches.length === 0) {
    return '';
  }
  const uniqueDecisions = [...new Set(matches)];
  return `<div class="checkpoint-section"><div class="checkpoint-section-title">Related Decisions</div><div class="checkpoint-related">${uniqueDecisions.map((d) => `<span class="checkpoint-related-link" onclick="event.stopPropagation(); window.graphModule.navigateToNode('${d}')">${d.substring(9, 30)}...</span>`).join('')}</div></div>`;
}

function expandCheckpoint(idx) {
  const items = document.querySelectorAll('.checkpoint-item');
  items.forEach((item, i) => {
    item.classList[i === idx ? 'toggle' : 'remove']('expanded');
  });
}

// =============================================
// Panel Management
// =============================================

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
    panel.style.left =
      Math.max(0, Math.min(e.clientX - offsetX, window.innerWidth - panel.offsetWidth)) + 'px';
    panel.style.top =
      Math.max(50, Math.min(e.clientY - offsetY, window.innerHeight - panel.offsetHeight)) + 'px';
    panel.style.right = 'auto';
  });

  document.addEventListener('mouseup', () => {
    isDragging = false;
    panel.style.transition = '';
  });
}

// =============================================
// Initialization
// =============================================

document.addEventListener('DOMContentLoaded', async () => {
  // Initialize modules
  memoryModule = new MemoryModule();
  window.memoryModule = memoryModule;

  chatModule = new ChatModule(memoryModule);
  window.chatModule = chatModule;

  graphModule = new GraphModule();
  window.graphModule = graphModule;

  // Clean up expired chat histories
  chatModule.cleanupExpiredHistories();

  // Initialize draggable panel
  initDraggablePanel();

  // Load checkpoints
  fetchCheckpoints();

  // Load and initialize graph
  try {
    const data = await graphModule.fetchData();
    if (data.nodes.length === 0) {
      document.getElementById('loading').innerHTML =
        '<div class="error">No decisions found. Start making decisions with MAMA!</div>';
      return;
    }
    graphModule.init(data);
  } catch (error) {
    document.getElementById('loading').innerHTML =
      `<div class="error">Failed to load graph: ${error.message}<br><br><button onclick="location.reload()" style="padding:8px 16px;cursor:pointer;">Retry</button></div>`;
  }
});

// =============================================
// Window Exports (HTML onclick compatibility)
// =============================================

// Graph module
window.filterByTopic = (topic) => graphModule?.filterByTopic(topic);
window.handleSearch = (event) => graphModule?.handleSearchInput(event);
window.closeDetail = () => graphModule?.closeDetail();
window.toggleLegend = () => document.getElementById('legend-panel')?.classList.toggle('collapsed');
window.saveOutcome = () => graphModule?.saveOutcome();
window.toggleReasoning = () => graphModule?.toggleReasoning();
window.navigateToNode = (nodeId) => graphModule?.navigateToNode(nodeId);
window.getConnectedEdges = (nodeId) => graphModule?.getConnectedEdges(nodeId);

// Memory module
window.handleMemorySearch = (event) => memoryModule?.handleSearchInput(event);
window.searchMemoryDecisions = () => memoryModule?.search();
window.toggleMemoryCard = (idx) => memoryModule?.toggleCard(idx);
window.showSaveDecisionForm = () => memoryModule?.showSaveForm();
window.hideSaveDecisionForm = () => memoryModule?.hideSaveForm();
window.submitSaveDecision = () => memoryModule?.submitSaveForm();

// Chat module
window.addAssistantMessage = (text) => chatModule?.addAssistantMessage(text);
window.sendChatMessage = () => chatModule?.send();
window.toggleVoiceInput = () => chatModule?.toggleVoice();
window.toggleTTS = () => chatModule?.toggleTTS();
window.toggleHandsFree = () => chatModule?.toggleHandsFree();
window.enableMicButton = (enabled) => chatModule?.enableMic(enabled);
window.connectToSession = (sessionId) => chatModule?.connectToSession(sessionId);
window.disconnectChat = () => chatModule?.disconnect();
window.clearChatHistory = (sessionId) => chatModule?.clearHistory(sessionId);

// Sidebar
window.toggleSidebar = toggleSidebar;
window.toggleCheckpoints = toggleCheckpoints;
window.switchTab = switchTab;
window.expandCheckpoint = expandCheckpoint;
