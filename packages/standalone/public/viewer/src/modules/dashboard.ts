/**
 * Dashboard Module - MAMA OS Dashboard
 * @module modules/dashboard
 * @version 1.0.0
 *
 * Handles Dashboard tab functionality including:
 * - Gateway status display (Discord, Slack, Telegram, Chatwork)
 * - Memory statistics
 * - Agent configuration display
 * - Top topics
 */

/* eslint-env browser */

import {
  escapeAttr,
  escapeHtml,
  getElementByIdOrNull,
  getErrorMessage,
  showToast,
} from '../utils/dom.js';
import { formatModelName } from '../utils/format.js';
import {
  API,
  type HealthCheckItem,
  type HealthReportResponse,
  type McpServer,
  type McpServersResponse,
  type MultiAgentAgent,
  type MultiAgentDashboardStatus,
  type TokenSummaryResponse,
  type TokensByAgentResponse,
} from '../utils/api.js';
import { DebugLogger } from '../utils/debug-logger.js';

const logger = new DebugLogger('Dashboard');

type DashboardGateway = {
  enabled?: boolean;
  configured?: boolean;
  channel?: string;
  chats?: string[];
  rooms?: string[];
};

type DashboardSessionChannel = {
  source: string;
  channelId: string;
  channelName?: string;
  messageCount?: number;
  lastActive?: number | string;
};

type DashboardSessions = {
  total: number;
  bySource: Record<string, number>;
  channels: DashboardSessionChannel[];
};

type DashboardMemoryStats = {
  total?: number;
  thisWeek?: number;
  thisMonth?: number;
  checkpoints?: number;
  topTopics?: Array<{ topic: string; count: number }>;
};

type DashboardAgentConfig = {
  model?: string;
  maxTurns?: number;
  timeout?: number;
};

type DashboardData = {
  gateways?: Record<string, DashboardGateway>;
  sessions?: DashboardSessions;
  memory?: DashboardMemoryStats;
  agent?: DashboardAgentConfig;
  heartbeat?: {
    enabled?: boolean;
    interval?: number;
    quiet_start?: number;
    quiet_end?: number;
    quietStart?: number;
    quietEnd?: number;
  };
};

type MultiAgentDashboardData = {
  enabled: boolean;
  agents: MultiAgentAgent[];
  activeChains?: number;
};

type DashboardDelegation = {
  status: string;
  claimedBy?: string;
  description?: string;
  wave?: number;
  completedAt?: number | string;
  claimedAt?: number | string;
};

type DashboardDelegationsData = {
  delegations: DashboardDelegation[];
  count?: number;
};

type DashboardTokenData = {
  summary?: TokenSummaryResponse;
  byAgent?: TokensByAgentResponse;
};

/**
 * Dashboard Module Class
 */
export class DashboardModule {
  data: DashboardData | null = null;
  updateInterval: ReturnType<typeof setInterval> | null = null;
  initialized = false;
  onCronClick: ((event: MouseEvent) => void) | null = null;
  mcpServers: McpServer[] = [];
  multiAgentData: MultiAgentDashboardData = { enabled: false, agents: [] };
  delegationsData: DashboardDelegationsData = { delegations: [], count: 0 };
  cronData: {
    jobs?: Array<{
      id: string;
      name: string;
      schedule?: string;
      cron?: string;
      nextRun?: string;
      enabled?: boolean;
    }>;
  } | null = null;
  tokenData: DashboardTokenData | null = null;
  healthData: HealthReportResponse | null = null;

  constructor() {
    this.data = null;
    this.updateInterval = null;
    this.initialized = false;
    this.onCronClick = null;
    this.mcpServers = [];
  }

  /**
   * Initialize dashboard
   */
  async init(): Promise<void> {
    if (this.initialized) {
      return;
    }
    this.initialized = true;

    // Event delegation for dashboard actions
    this.onCronClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (!target) {
        return;
      }

      const cronButton = target.closest<HTMLElement>('[data-action="run-cron"]');
      if (cronButton) {
        const jobId = cronButton.getAttribute('data-cron-id');
        if (jobId) {
          this.runCronJob(jobId);
        }
        return;
      }

      const settingsLink = target.closest<HTMLElement>('[data-action="open-settings"]');
      if (settingsLink) {
        const settingsTab = document.querySelector<HTMLElement>('[data-tab="settings"]');
        if (settingsTab) {
          settingsTab.click();
        }
        return;
      }

      const restartBtn = target.closest<HTMLElement>('[data-action="restart-agent"]');
      if (restartBtn) {
        const agentId = restartBtn.getAttribute('data-agent-id');
        if (agentId) {
          this.restartAgent(agentId);
        }
        return;
      }

      const stopBtn = target.closest<HTMLElement>('[data-action="stop-agent"]');
      if (stopBtn) {
        const agentId = stopBtn.getAttribute('data-agent-id');
        if (agentId) {
          this.stopAgent(agentId);
        }
      }
    };
    document.addEventListener('click', this.onCronClick);

    await this.loadStatus();

    // Auto-refresh every 30 seconds
    this.updateInterval = setInterval(() => this.loadStatus(), 30000);
  }

  /**
   * Load dashboard status from API
   */
  async loadStatus(): Promise<void> {
    try {
      this.data = await API.get<DashboardData>('/api/dashboard/status');

      // Load multi-agent status (Sprint 3 F2)
      try {
        this.multiAgentData = await API.get<MultiAgentDashboardStatus>('/api/multi-agent/status');
      } catch (e) {
        logger.warn('[Dashboard] Multi-agent status unavailable:', e);
        this.multiAgentData = { enabled: false, agents: [] };
      }

      // Load delegations (F4 endpoint)
      try {
        this.delegationsData = await API.get<DashboardDelegationsData>(
          '/api/multi-agent/delegations?limit=10'
        );
      } catch (e) {
        logger.warn('[Dashboard] Delegations unavailable:', e);
        this.delegationsData = { delegations: [], count: 0 };
      }

      // Load cron jobs
      try {
        this.cronData = await API.getCronJobs();
      } catch (e) {
        logger.warn('[Dashboard] Cron data unavailable:', e);
        this.cronData = null;
      }

      // Load token summary
      try {
        const [summary, byAgent] = await Promise.all([
          API.getTokenSummary(),
          API.getTokensByAgent(),
        ]);
        this.tokenData = { summary, byAgent };
      } catch (e) {
        logger.warn('[Dashboard] Token data unavailable:', e);
        this.tokenData = null;
      }

      // Load health report
      try {
        this.healthData = await API.getHealthReport();
      } catch (e) {
        logger.warn('[Dashboard] Health report unavailable:', e);
        this.healthData = null;
      }

      // Load MCP servers
      await this.loadMCPServers();

      this.render();
      this.setStatus(`Last updated: ${new Date().toLocaleTimeString()}`);
    } catch (error) {
      logger.error('[Dashboard] Load error:', error);
      this.setStatus(`Error: ${getErrorMessage(error)}`, 'error');
    }
  }

  /**
   * Load MCP servers from API
   */
  async loadMCPServers(): Promise<void> {
    try {
      const data = await API.get<McpServersResponse>('/api/mcp-servers');
      if (data && 'servers' in data) {
        this.mcpServers = data.servers || [];
        this.renderMCPServers();
      }
    } catch (error) {
      logger.error('Failed to load MCP servers:', error);
    }
  }

  /**
   * Render all dashboard sections
   */
  render(): void {
    if (!this.data) {
      return;
    }

    this.renderSystemHealth();
    this.renderGateways();
    this.renderMCPServers();
    this.renderSessions();
    this.renderAgentSwarm();
    this.renderMemoryStats();
    this.renderAgentConfig();
    this.renderCronJobs();
    this.renderTokenSummary();
    this.renderTopTopics();
  }

  /**
   * Render gateway status cards
   */
  renderGateways(): void {
    const container = getElementByIdOrNull<HTMLElement>('dashboard-gateways');
    if (!container || !this.data.gateways) {
      return;
    }

    const gateways = [
      { key: 'discord', name: 'Discord', icon: '💬', color: 'indigo' },
      { key: 'slack', name: 'Slack', icon: '📱', color: 'green' },
      { key: 'telegram', name: 'Telegram', icon: '✈️', color: 'blue' },
      { key: 'chatwork', name: 'Chatwork', icon: '💼', color: 'orange' },
    ];

    // Count active bots
    const enabledCount = gateways.filter((gw) => this.data.gateways[gw.key]?.enabled).length;
    const configuredCount = gateways.filter((gw) => this.data.gateways[gw.key]?.configured).length;

    // Update header with bot count
    const header = container.previousElementSibling;
    if (header && header.tagName === 'H2') {
      header.innerHTML = `Gateway Status <span class="text-sm font-normal text-gray-500">(${enabledCount}/${configuredCount} active)</span>`;
    }

    const html = gateways
      .map((gw) => {
        const status = this.data.gateways[gw.key] || {};
        const isConfigured = status.configured;
        const isEnabled = status.enabled;

        const statusBadge = isConfigured
          ? isEnabled
            ? `<span class="text-[10px] px-2 py-0.5 rounded-full bg-green-100 text-green-600 font-medium">Enabled</span>`
            : `<span class="text-[10px] px-2 py-0.5 rounded-full bg-yellow-100 text-yellow-600 font-medium">Disabled</span>`
          : `<span class="text-[10px] px-2 py-0.5 rounded-full bg-gray-100 text-gray-500 font-medium">Not Configured</span>`;

        // Get channel info based on gateway type
        let channelInfo = '';
        if (isConfigured) {
          if (gw.key === 'discord' && status.channel) {
            channelInfo = `<span class="text-[10px] bg-mama-lavender-light text-gray-600 px-1.5 py-0.5 rounded">#${escapeHtml(status.channel)}</span>`;
          } else if (gw.key === 'telegram' && status.chats?.length > 0) {
            channelInfo = `<span class="text-[10px] bg-mama-lavender-light text-gray-600 px-1.5 py-0.5 rounded">${status.chats.length} chat(s)</span>`;
          } else if (gw.key === 'slack' && status.channel) {
            channelInfo = `<span class="text-[10px] bg-mama-lavender-light text-gray-600 px-1.5 py-0.5 rounded">#${escapeHtml(status.channel)}</span>`;
          } else if (gw.key === 'chatwork' && status.rooms?.length > 0) {
            channelInfo = `<span class="text-[10px] bg-mama-lavender-light text-gray-600 px-1.5 py-0.5 rounded">${status.rooms.length} room(s)</span>`;
          }
        }

        return `
          <div class="bg-white border border-gray-200 rounded-lg p-3 hover:shadow-md transition-shadow">
            <div class="flex items-center justify-between mb-1.5">
              <span class="text-lg">${gw.icon}</span>
              ${statusBadge}
            </div>
            <h3 class="font-semibold text-sm text-gray-900">${gw.name}</h3>
            <div class="flex items-center gap-2 mt-1">
              <p class="text-[10px] text-gray-500">
                ${isConfigured ? 'Token ✓' : 'No token'}
              </p>
              ${channelInfo}
            </div>
          </div>
        `;
      })
      .join('');

    container.innerHTML = html;
  }

  /**
   * Render MCP servers
   */
  renderMCPServers(): void {
    const container = getElementByIdOrNull<HTMLElement>('dashboard-mcp');
    if (!container) {
      return;
    }

    if (this.mcpServers.length === 0) {
      container.innerHTML = `
        <p class="text-gray-500 text-sm col-span-full py-4 text-center">
          No MCP servers configured
        </p>
      `;
      return;
    }

    const icons = {
      'brave-devtools': '🌐',
      'brave-search': '🔍',
      mama: '🧠',
      slack: '💬',
      notion: '📝',
      linear: '📊',
      asana: '✅',
      atlassian: '🔷',
      ms365: '📧',
      monday: '📅',
      clickup: '✓',
    };

    const html = this.mcpServers
      .map((server) => {
        const icon = icons[server.name] || '🔌';
        const isHttp = server.type === 'http';
        const statusBadge = isHttp
          ? 'bg-yellow-100 text-yellow-700'
          : 'bg-green-100 text-green-700';
        const statusText = isHttp ? 'OAuth' : 'Ready';

        return `
          <div class="bg-white border border-gray-200 rounded-lg p-3 hover:shadow-md transition-shadow">
            <div class="flex items-center justify-between mb-1">
              <div class="flex items-center gap-2">
                <span class="text-lg">${icon}</span>
                <h4 class="font-semibold text-sm text-gray-900">${escapeHtml(server.name)}</h4>
              </div>
              <span class="text-[10px] px-1.5 py-0.5 rounded ${statusBadge}">${statusText}</span>
            </div>
            <p class="text-[10px] text-gray-500 truncate">${escapeHtml(server.type === 'http' ? server.url : server.command)}</p>
          </div>
        `;
      })
      .join('');

    container.innerHTML = html;
  }

  /**
   * Render session statistics
   */
  renderSessions(): void {
    const container = getElementByIdOrNull<HTMLElement>('dashboard-sessions');
    if (!container) {
      return;
    }

    const sessions = this.data.sessions || { total: 0, bySource: {}, channels: [] };

    if (sessions.total === 0) {
      container.innerHTML = `
        <p class="text-gray-500 text-sm text-center py-4">
          No active sessions yet. Start chatting to create sessions.
        </p>
      `;
      return;
    }

    // Source icons and labels
    const sourceInfo = {
      discord: { icon: '🎮', label: 'Discord', color: 'bg-indigo-100 text-indigo-700' },
      telegram: { icon: '✈️', label: 'Telegram', color: 'bg-sky-100 text-sky-700' },
      slack: { icon: '📱', label: 'Slack', color: 'bg-purple-100 text-purple-700' },
      chatwork: { icon: '💼', label: 'Chatwork', color: 'bg-green-100 text-green-700' },
      viewer: { icon: '🖥️', label: 'OS Viewer', color: 'bg-gray-100 text-gray-700' },
      mobile: { icon: '📲', label: 'Mobile', color: 'bg-orange-100 text-orange-700' },
    };

    // Build source summary
    const sourceSummary = Object.entries(sessions.bySource)
      .map(([source, count]) => {
        const info = sourceInfo[source] || {
          icon: '📝',
          label: source,
          color: 'bg-gray-100 text-gray-700',
        };
        const safeLabel = escapeHtml(info.label);
        return `<span class="inline-flex items-center gap-1 ${info.color} px-2 py-1 rounded text-xs font-medium">
          ${info.icon} ${safeLabel}: ${count}
        </span>`;
      })
      .join('');

    // Build recent channels list
    const channelList = sessions.channels
      .slice(0, 5)
      .map((ch) => {
        const info = sourceInfo[ch.source] || {
          icon: '📝',
          label: ch.source,
          color: 'bg-gray-100 text-gray-700',
        };
        const lastActive = this.formatRelativeTime(ch.lastActive);

        // Use channel name if available, otherwise use meaningful fallbacks
        let channelDisplay;
        if (ch.channelName) {
          // Show channel name (already human-readable)
          channelDisplay =
            ch.channelName.length > 25 ? ch.channelName.slice(0, 22) + '...' : ch.channelName;
        } else if (ch.source === 'viewer' || ch.channelId === 'mama_os_main') {
          // OS Viewer - shared channel
          channelDisplay = 'MAMA OS';
        } else if (ch.source === 'mobile') {
          // Mobile app - show user-friendly name
          channelDisplay = 'Mobile App';
        } else {
          // Fallback: truncate channel ID (Discord channels before update)
          channelDisplay =
            ch.channelId.length > 12
              ? ch.channelId.slice(0, 6) + '...' + ch.channelId.slice(-4)
              : ch.channelId;
        }

        return `
          <div class="flex items-center justify-between py-1.5 border-b border-gray-100 last:border-0">
            <div class="flex items-center gap-2">
              <span class="${info.color} px-1.5 py-0.5 rounded text-[10px] font-medium" title="${escapeHtml(info.label)}">${info.icon}</span>
              <span class="text-xs text-gray-700" title="${escapeHtml(ch.channelId)}">${escapeHtml(channelDisplay)}</span>
            </div>
            <div class="flex items-center gap-2">
              <span class="text-[10px] bg-blue-50 text-blue-600 px-1.5 py-0.5 rounded">${ch.messageCount} turns</span>
              <span class="text-[10px] text-gray-400">${lastActive}</span>
            </div>
          </div>
        `;
      })
      .join('');

    container.innerHTML = `
      <div class="mb-3">
        <div class="flex items-center justify-between mb-2">
          <span class="text-sm font-medium text-gray-900">Sessions by Platform</span>
          <span class="text-xs bg-indigo-100 text-indigo-600 px-2 py-0.5 rounded-full">${sessions.total} total</span>
        </div>
        <div class="flex flex-wrap gap-2">
          ${sourceSummary}
        </div>
      </div>
      <div>
        <p class="text-xs text-gray-500 mb-2">Recent Channels:</p>
        ${channelList || '<p class="text-xs text-gray-400">No recent activity</p>'}
      </div>
    `;
  }

  /**
   * Format relative time (e.g., "2h ago", "3d ago")
   */
  formatRelativeTime(timestamp: number | string | Date | undefined): string {
    if (timestamp === undefined || timestamp === null || timestamp === '') {
      return 'Never';
    }

    const now = Date.now();
    const target = typeof timestamp === 'number' ? timestamp : new Date(timestamp).getTime();
    const diff = now - target;
    const minutes = Math.floor(diff / 60000);
    const hours = Math.floor(diff / 3600000);
    const days = Math.floor(diff / 86400000);

    if (minutes < 1) {
      return 'Just now';
    }
    if (minutes < 60) {
      return `${minutes}m ago`;
    }
    if (hours < 24) {
      return `${hours}h ago`;
    }
    return `${days}d ago`;
  }

  /**
   * Render memory statistics
   */
  renderMemoryStats(): void {
    const container = getElementByIdOrNull<HTMLElement>('dashboard-memory');
    if (!container || !this.data.memory) {
      return;
    }

    const memory = this.data.memory;

    const stats = [
      { label: 'Total Decisions', value: memory.total || 0, icon: '🧠' },
      { label: 'This Week', value: memory.thisWeek || 0, icon: '📅' },
      { label: 'This Month', value: memory.thisMonth || 0, icon: '📆' },
      { label: 'Checkpoints', value: memory.checkpoints || 0, icon: '💾' },
    ];

    const html = stats
      .map(
        (stat) => `
        <div class="bg-white border border-gray-200 rounded-lg p-3 text-center">
          <span class="text-base">${stat.icon}</span>
          <p class="text-lg font-bold text-gray-900 mt-1">${stat.value}</p>
          <p class="text-[10px] text-gray-500">${stat.label}</p>
        </div>
      `
      )
      .join('');

    container.innerHTML = html;
  }

  /**
   * Render agent configuration
   */
  renderAgentConfig(): void {
    const container = getElementByIdOrNull<HTMLElement>('dashboard-agent');
    if (!container || !this.data.agent) {
      return;
    }

    const agent = this.data.agent;
    const heartbeat = this.data.heartbeat || {};
    const friendlyModel = formatModelName(agent.model) || 'Not Set';

    container.innerHTML = `
      <div class="mb-3 pb-3 border-b border-gray-200">
        <div class="flex items-center justify-between">
          <div>
            <p class="text-[10px] text-gray-500 uppercase tracking-wide">Current Model</p>
            <p class="font-bold text-gray-900 text-sm">${escapeHtml(friendlyModel)}</p>
            <p class="text-[10px] text-gray-400 font-mono">${escapeHtml(agent.model || 'Not configured')}</p>
          </div>
          <span class="text-2xl">🤖</span>
        </div>
      </div>
      <div class="grid grid-cols-3 gap-3">
        <div>
          <p class="text-[10px] text-gray-500 uppercase tracking-wide">Max Turns</p>
          <p class="font-semibold text-gray-900 text-sm mt-0.5">${agent.maxTurns || 'N/A'}</p>
        </div>
        <div>
          <p class="text-[10px] text-gray-500 uppercase tracking-wide">Timeout</p>
          <p class="font-semibold text-gray-900 text-sm mt-0.5">${this.formatTimeout(agent.timeout)}</p>
        </div>
        <div>
          <p class="text-[10px] text-gray-500 uppercase tracking-wide">Heartbeat</p>
          <p class="font-semibold text-gray-900 text-sm mt-0.5">
            ${heartbeat.enabled ? `${Math.round((heartbeat.interval || 1800000) / 60000)}min` : 'Off'}
          </p>
        </div>
      </div>
      ${
        heartbeat.enabled
          ? `
        <div class="mt-2 pt-2 border-t border-gray-200">
          <p class="text-[10px] text-gray-500">
            Quiet hours: ${heartbeat.quiet_start ?? heartbeat.quietStart ?? 23}:00 - ${
              heartbeat.quiet_end ?? heartbeat.quietEnd ?? 8
            }:00
          </p>
        </div>
      `
          : ''
      }
    `;
  }

  /**
   * Render agent swarm section
   * Sprint 3 F2: Multi-agent dashboard
   */
  renderAgentSwarm(): void {
    const container = getElementByIdOrNull<HTMLElement>('dashboard-agent-swarm');
    if (!container) {
      return;
    }

    const multiAgent = this.multiAgentData || { enabled: false, agents: [] };

    if (!multiAgent.enabled) {
      container.innerHTML = `
        <p class="text-gray-500 text-sm text-center py-4">
          Multi-agent is not enabled. Enable in <a href="/viewer?tab=settings" class="text-indigo-600 hover:underline" data-action="open-settings">Settings</a>.
        </p>
      `;
      return;
    }

    const agents = multiAgent.agents || [];

    if (agents.length === 0) {
      container.innerHTML = `
        <p class="text-gray-500 text-sm text-center py-4">
          No agents configured yet.
        </p>
      `;
      return;
    }

    // Tier badge colors
    const tierColors = {
      1: { bg: 'bg-indigo-100', text: 'text-indigo-700', label: 'T1' },
      2: { bg: 'bg-green-100', text: 'text-green-700', label: 'T2' },
      3: { bg: 'bg-yellow-100', text: 'text-yellow-700', label: 'T3' },
    };

    // Status icons (F2 enhanced)
    const statusIcons = {
      idle: '🟢', // 대기 중
      online: '🟢', // 온라인 (fallback)
      busy: '🟡', // 작업 중
      starting: '🔵', // 시작 중
      dead: '🔴', // 비정상 종료
      offline: '🔴', // 오프라인
      disabled: '⚪', // 비활성
    };

    // Status text labels
    const statusLabels = {
      idle: 'Ready',
      online: 'Ready',
      busy: 'Working...',
      starting: 'Starting...',
      dead: 'Error',
      offline: 'Offline',
      disabled: 'Disabled',
    };

    // Agent cards
    const agentCards = agents
      .map((agent) => {
        const tier = tierColors[agent.tier] || tierColors[1];
        const statusIcon = statusIcons[agent.status] || statusIcons.offline;
        const statusLabel = statusLabels[agent.status] || 'Unknown';
        const friendlyModel = formatModelName(agent.model) || agent.model || 'Default';

        return `
          <div class="bg-white border border-gray-200 rounded-lg p-3 hover:shadow-md transition-shadow">
            <div class="flex items-center justify-between mb-1.5">
              <div class="flex items-center gap-2">
                <span class="${tier.bg} ${tier.text} text-[10px] font-bold px-1.5 py-0.5 rounded">${tier.label}</span>
                <span class="text-[10px]">${statusIcon} ${escapeHtml(statusLabel)}</span>
              </div>
            </div>
            <h3 class="font-semibold text-sm text-gray-900">${escapeHtml(agent.name)}</h3>
            <p class="text-[10px] text-gray-500 mt-0.5">${escapeHtml(friendlyModel)}</p>
            ${
              agent.lastActivity
                ? `<p class="text-[10px] text-gray-400 mt-1">Last: ${this.formatRelativeTime(agent.lastActivity)}</p>`
                : ''
            }
            <div class="flex gap-1 mt-2 pt-2 border-t border-gray-100">
              <button
                data-action="restart-agent"
                data-agent-id="${escapeAttr(agent.id)}"
                class="text-xs px-3 py-1.5 rounded bg-blue-50 text-blue-600 hover:bg-blue-100 transition-colors"
                title="Restart agent"
              >Restart</button>
              ${
                agent.status === 'busy'
                  ? `<button
                      data-action="stop-agent"
                      data-agent-id="${escapeAttr(agent.id)}"
                      class="text-xs px-3 py-1.5 rounded bg-red-50 text-red-600 hover:bg-red-100 transition-colors"
                      title="Stop agent"
                    >Stop</button>`
                  : ''
              }
            </div>
          </div>
        `;
      })
      .join('');

    // Recent delegations (F2 F4 API integration)
    const delegationsData = this.delegationsData || { delegations: [], count: 0 };
    const delegations = delegationsData.delegations || [];

    // Status badge colors
    const statusColors = {
      completed: 'bg-green-100 text-green-700',
      claimed: 'bg-yellow-100 text-yellow-700',
      failed: 'bg-red-100 text-red-700',
      pending: 'bg-gray-100 text-gray-700',
    };

    const delegationList =
      delegations.length > 0
        ? delegations
            .slice(0, 5)
            .map((del) => {
              const statusColor = statusColors[del.status] || statusColors.pending;
              const timestamp = del.completedAt || del.claimedAt;
              return `
            <div class="text-xs text-gray-700 py-1 border-b border-gray-100 last:border-0">
              <span class="${statusColor} text-[10px] font-bold px-1 py-0.5 rounded">${escapeHtml(del.status)}</span>
              <span class="font-medium">${escapeHtml(del.claimedBy || 'unknown')}</span>:
              "${escapeHtml(del.description)}"
              ${del.wave ? `<span class="text-gray-400">(wave ${del.wave})</span>` : ''}
              ${timestamp ? `<span class="text-gray-400 text-[10px]"> ${this.formatRelativeTime(timestamp)}</span>` : ''}
            </div>
          `;
            })
            .join('')
        : '<p class="text-xs text-gray-400">No recent delegations</p>';

    // Active chains
    const activeChains = multiAgent.activeChains || 0;
    const chainBadge =
      activeChains > 0
        ? `<span class="text-xs bg-green-100 text-green-600 px-2 py-0.5 rounded-full">${activeChains} active</span>`
        : '<span class="text-xs bg-gray-100 text-gray-500 px-2 py-0.5 rounded-full">0 active</span>';

    container.innerHTML = `
      <div class="mb-3">
        <p class="text-xs text-gray-500 mb-2">Agent Team:</p>
        <div class="grid grid-cols-1 md:grid-cols-3 gap-2">
          ${agentCards}
        </div>
      </div>
        <div class="mb-2 pb-2 border-b border-gray-200">
        <div class="flex items-center justify-between mb-2">
          <p class="text-xs text-gray-500">Delegation Chain:</p>
          ${chainBadge}
        </div>
        <div class="bg-mama-lavender-light rounded p-2">
          ${delegationList}
        </div>
      </div>
    `;
  }

  /**
   * Render top topics
   */
  renderTopTopics(): void {
    const container = getElementByIdOrNull<HTMLElement>('dashboard-topics');
    if (!container || !this.data.memory) {
      return;
    }

    const topics = this.data.memory.topTopics || [];

    if (topics.length === 0) {
      container.innerHTML = `
        <p class="text-gray-500 text-sm">No topics yet. Start making decisions!</p>
      `;
      return;
    }

    const counts = topics
      .map((topic) => (Number.isFinite(topic.count) ? topic.count : 0))
      .filter((count) => count >= 0);
    const maxCount = Math.max(1, ...counts);

    const html = topics
      .map((topic) => {
        const safeCount = Number.isFinite(topic.count) ? topic.count : 0;
        return `
        <div class="flex items-center gap-3 mb-2">
          <div class="flex-1">
            <div class="flex justify-between items-center mb-1">
              <span class="text-sm font-medium text-gray-900">${escapeHtml(topic.topic)}</span>
              <span class="text-xs text-gray-500">${safeCount}</span>
            </div>
            <div class="w-full bg-gray-200 rounded-full h-2">
              <div class="bg-mama-yellow h-2 rounded-full" style="width: ${(safeCount / maxCount) * 100}%"></div>
            </div>
          </div>
        </div>
            `;
      })
      .join('');

    container.innerHTML = html;
  }

  /**
   * Format timeout in human readable format
   */
  formatTimeout(ms?: number): string {
    if (!ms) {
      return 'N/A';
    }
    if (ms < 60000) {
      return `${Math.round(ms / 1000)}s`;
    }
    return `${Math.round(ms / 60000)}min`;
  }

  /**
   * Render cron jobs section
   */
  renderCronJobs(): void {
    const container = getElementByIdOrNull<HTMLElement>('dashboard-cron');
    if (!container) {
      return;
    }

    const jobs = this.cronData?.jobs || this.cronData || [];

    if (!Array.isArray(jobs) || jobs.length === 0) {
      container.innerHTML = `
        <p class="text-gray-500 text-sm text-center py-4">
          No cron jobs configured. Ask the agent to schedule a task or use the Settings tab.
        </p>
      `;
      return;
    }

    const rows = jobs
      .map((job) => {
        const isEnabled = job.enabled !== false;
        const statusBadge = isEnabled
          ? '<span class="text-xs px-2 py-0.5 rounded-full bg-green-100 text-green-600">Active</span>'
          : '<span class="text-xs px-2 py-0.5 rounded-full bg-gray-100 text-gray-500">Paused</span>';

        const nextRun = job.nextRun
          ? new Date(job.nextRun).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
          : '-';

        return `
        <div class="flex items-center justify-between py-2 border-b border-gray-100 last:border-0">
          <div class="flex-1 min-w-0">
            <div class="flex items-center gap-2">
              <span class="font-medium text-sm text-gray-900 truncate">${escapeHtml(job.name || job.id)}</span>
              ${statusBadge}
            </div>
            <p class="text-xs text-gray-500 mt-0.5">
              <code class="bg-gray-100 px-1 py-0.5 rounded text-[10px]">${escapeHtml(job.schedule || job.cron || '')}</code>
              <span class="ml-2">Next: ${nextRun}</span>
            </p>
          </div>
          <div class="flex items-center gap-1 ml-2 shrink-0">
            <button class="text-xs px-2 py-1 bg-mama-yellow hover:bg-mama-yellow-hover text-mama-black rounded transition-colors"
              data-action="run-cron"
              data-cron-id="${escapeAttr(job.id)}" title="Run Now">
              Run
            </button>
          </div>
        </div>
      `;
      })
      .join('');

    container.innerHTML = `
      <div class="space-y-0">
        ${rows}
      </div>
    `;
  }

  /**
   * Run a cron job immediately
   */
  async runCronJob(id: string): Promise<void> {
    try {
      await API.runCronJob(id);
      const statusEl = getElementByIdOrNull<HTMLElement>('dashboard-status');
      if (statusEl) {
        statusEl.textContent = `Cron job "${id}" triggered`;
      }
      await this.loadStatus();
    } catch (e) {
      logger.error('[Dashboard] Failed to run cron job:', e);
      const statusEl = getElementByIdOrNull<HTMLElement>('dashboard-status');
      if (statusEl) {
        const message = getErrorMessage(e);
        statusEl.textContent = `Cron job "${id}" failed: ${message}`;
      }
    }
  }

  async restartAgent(agentId: string): Promise<void> {
    try {
      await API.restartAgent(agentId);
      showToast(`Agent "${agentId}" restarted`);
      await this.loadStatus();
    } catch (e) {
      logger.error('[Dashboard] Failed to restart agent:', e);
      showToast(`Restart failed: ${getErrorMessage(e)}`);
    }
  }

  async stopAgent(agentId: string): Promise<void> {
    try {
      await API.stopAgent(agentId);
      showToast(`Agent "${agentId}" stopped`);
      await this.loadStatus();
    } catch (e) {
      logger.error('[Dashboard] Failed to stop agent:', e);
      showToast(`Stop failed: ${getErrorMessage(e)}`);
    }
  }

  /**
   * Render system health section
   */
  renderSystemHealth(): void {
    const container = getElementByIdOrNull<HTMLElement>('dashboard-health');
    if (!container) {
      return;
    }

    if (!this.healthData) {
      container.innerHTML = `
        <p class="text-gray-500 text-sm text-center py-4">
          Health data unavailable. Metrics may be disabled.
        </p>
      `;
      return;
    }

    const h = this.healthData;
    const scoreColor =
      h.score >= 80 ? 'text-green-600' : h.score >= 50 ? 'text-yellow-600' : 'text-red-600';
    const statusBadgeColor =
      h.status === 'healthy'
        ? 'bg-green-100 text-green-700'
        : h.status === 'degraded'
          ? 'bg-yellow-100 text-yellow-700'
          : 'bg-red-100 text-red-700';

    // Render checks list (new connection-based health)
    const checks: HealthCheckItem[] = h.checks || [];
    const checksHtml =
      checks.length > 0
        ? checks
            .map((c: HealthCheckItem) => {
              const icon =
                c.status === 'pass'
                  ? '<span class="text-green-600">&#10003;</span>'
                  : c.status === 'skip'
                    ? '<span class="text-gray-400">&#8212;</span>'
                    : c.severity === 'critical'
                      ? '<span class="text-red-600">&#10007;</span>'
                      : '<span class="text-yellow-600">&#9888;</span>';
              const bgClass = c.status === 'fail' && c.severity === 'critical' ? 'bg-red-50' : '';
              return `
            <div class="flex items-center justify-between py-1 px-2 rounded ${bgClass}">
              <div class="flex items-center gap-2">
                <span class="text-sm">${icon}</span>
                <span class="text-xs font-medium text-gray-700">${escapeHtml(c.name)}</span>
              </div>
              <span class="text-[10px] text-gray-500">${escapeHtml(c.message)}</span>
            </div>
          `;
            })
            .join('')
        : '';

    // Fallback: legacy component cards if no checks available
    const rawComponents = h.components || {};
    let legacyCardsHtml = '';
    if (checks.length === 0) {
      const componentEntries = Array.isArray(rawComponents)
        ? rawComponents.map((c) => ({ name: c.name, score: c.score, detail: c.detail }))
        : Object.entries(rawComponents).map(([name, val]) => {
            const v = val as Record<string, unknown>;
            return {
              name,
              score: (v.score as number) ?? 0,
              detail: (v.details as Record<string, unknown>)?.status as string | undefined,
            };
          });
      legacyCardsHtml = componentEntries
        .map((c) => {
          const cColor =
            c.score >= 80
              ? 'bg-green-100 text-green-700'
              : c.score >= 50
                ? 'bg-yellow-100 text-yellow-700'
                : 'bg-red-100 text-red-700';
          return `
            <div class="bg-white border border-gray-200 rounded-lg p-2 text-center">
              <p class="text-sm font-bold ${cColor.split(' ')[1]}">${c.score}</p>
              <p class="text-[10px] text-gray-500">${escapeHtml(c.name)}</p>
              ${c.detail ? `<p class="text-[9px] text-gray-400">${escapeHtml(c.detail)}</p>` : ''}
            </div>
          `;
        })
        .join('');
      if (legacyCardsHtml) {
        legacyCardsHtml = `<div class="grid grid-cols-3 gap-2">${legacyCardsHtml}</div>`;
      }
    }

    container.innerHTML = `
      <div class="flex items-center gap-3 mb-3">
        <p class="text-2xl font-bold ${scoreColor}">${h.score}<span class="text-xs font-normal text-gray-400">/100</span></p>
        <span class="text-[10px] px-2 py-0.5 rounded-full ${statusBadgeColor} font-medium">${escapeHtml(h.status)}</span>
      </div>
      ${checksHtml ? `<div class="space-y-0.5">${checksHtml}</div>` : legacyCardsHtml}
    `;
  }

  /**
   * Render token usage summary section
   */
  renderTokenSummary(): void {
    const container = getElementByIdOrNull<HTMLElement>('dashboard-tokens');
    if (!container) {
      return;
    }

    if (!this.tokenData?.summary) {
      container.innerHTML = `
        <p class="text-gray-500 text-sm text-center py-4">
          Token tracking not yet available. Usage data will appear after conversations.
        </p>
      `;
      return;
    }

    const s = this.tokenData.summary;
    const agents = this.tokenData.byAgent?.agents || [];

    const formatTokens = (n: number | undefined): string => {
      if (!n || n === 0) {
        return '0';
      }
      if (n >= 1000000) {
        return (n / 1000000).toFixed(1) + 'M';
      }
      if (n >= 1000) {
        return (n / 1000).toFixed(1) + 'K';
      }
      return n.toString();
    };

    const formatCost = (usd: number | undefined): string => {
      if (!usd || usd === 0) {
        return '$0.00';
      }
      return '$' + usd.toFixed(2);
    };

    // Summary cards
    const periods = [
      {
        label: 'Today',
        tokens: (s.today?.input_tokens || 0) + (s.today?.output_tokens || 0),
        cost: s.today?.cost_usd,
        icon: '📊',
      },
      {
        label: 'This Week',
        tokens: (s.week?.input_tokens || 0) + (s.week?.output_tokens || 0),
        cost: s.week?.cost_usd,
        icon: '📅',
      },
      {
        label: 'This Month',
        tokens: (s.month?.input_tokens || 0) + (s.month?.output_tokens || 0),
        cost: s.month?.cost_usd,
        icon: '📆',
      },
    ];

    const cards = periods
      .map(
        (p) => `
      <div class="bg-white border border-gray-200 rounded-lg p-3 text-center">
        <span class="text-base">${p.icon}</span>
        <p class="text-lg font-bold text-gray-900 mt-1">${formatTokens(p.tokens)}</p>
        <p class="text-[10px] text-gray-500">${p.label}</p>
        <p class="text-[10px] text-mama-yellow-hover font-medium">${formatCost(p.cost)}</p>
      </div>
    `
      )
      .join('');

    // Agent breakdown (mini bar chart)
    const maxTokens = Math.max(
      ...agents.map((a) => (a.input_tokens || 0) + (a.output_tokens || 0)),
      1
    );
    const agentBars = agents
      .slice(0, 5)
      .map((a) => {
        const totalTokens = (a.input_tokens || 0) + (a.output_tokens || 0);
        const pct = Math.round((totalTokens / maxTokens) * 100);
        const agentLabel = a.agent_name || a.agent_id || 'unknown';
        return `
        <div class="flex items-center gap-2 mb-1.5">
          <span class="text-xs text-gray-700 w-20 truncate" title="${escapeHtml(agentLabel)}">${escapeHtml(agentLabel)}</span>
          <div class="flex-1 bg-gray-200 rounded-full h-2">
            <div class="bg-mama-yellow h-2 rounded-full transition-all" style="width: ${pct}%"></div>
          </div>
          <span class="text-[10px] text-gray-500 w-12 text-right">${formatTokens(totalTokens)}</span>
        </div>
      `;
      })
      .join('');

    container.innerHTML = `
      <div class="grid grid-cols-3 gap-2 mb-3">
        ${cards}
      </div>
      ${
        agents.length > 0
          ? `
        <div>
          <p class="text-xs text-gray-500 mb-2">By Agent:</p>
          ${agentBars}
        </div>
      `
          : ''
      }
    `;
  }

  /**
   * Set status message
   */
  setStatus(message: string, type = ''): void {
    const statusEl = getElementByIdOrNull<HTMLElement>('dashboard-status');
    if (statusEl) {
      statusEl.textContent = message;
      statusEl.className = `text-xs text-center py-2 ${type === 'error' ? 'text-red-500' : 'text-gray-400'}`;
    }
  }

  /**
   * Cleanup interval on destroy
   */
  cleanup(): void {
    if (this.updateInterval) {
      clearInterval(this.updateInterval);
      this.updateInterval = null;
    }
    if (this.onCronClick) {
      document.removeEventListener('click', this.onCronClick);
      this.onCronClick = null;
    }
  }
}
