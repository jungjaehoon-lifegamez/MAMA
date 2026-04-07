/**
 * Dashboard Module - MAMA OS Control Tower
 * @module modules/dashboard
 * @version 2.0.0
 *
 * Handles Control Tower tab functionality including:
 * - Event Stream (connector extraction results)
 * - Connected Apps (connector status)
 * - Gateway status display (Discord, Slack, Telegram, Chatwork)
 * - Memory statistics
 * - System Health
 * - Token Usage
 * - Cron Jobs
 */

/* eslint-env browser */

import {
  escapeAttr,
  escapeHtml,
  getElementByIdOrNull,
  getErrorMessage,
  showToast,
} from '../utils/dom.js';
import { formatRelativeTime, CONNECTOR_ICONS } from '../utils/format.js';
import {
  API,
  type HealthCheckItem,
  type HealthReportResponse,
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

type DashboardMemoryStats = {
  total?: number;
  thisWeek?: number;
  thisMonth?: number;
  checkpoints?: number;
};

type DashboardData = {
  gateways?: Record<string, DashboardGateway>;
  memory?: DashboardMemoryStats;
};

type DashboardTokenData = {
  summary?: TokenSummaryResponse;
  byAgent?: TokensByAgentResponse;
};

type ConnectorStatusItem = {
  name: string;
  enabled: boolean;
  healthy: boolean;
  lastPollTime: string | null;
  lastPollCount: number;
  channelCount: number;
};

type ConnectorEvent = {
  timestamp: string;
  source: string;
  channel: string;
  memoriesExtracted: number;
  error?: string;
};

type ConnectorEventsResponse = {
  events: ConnectorEvent[];
  stats: { total: number; errors: number; totalMemories: number };
};

/**
 * Dashboard Module Class — Control Tower
 */
export class DashboardModule {
  data: DashboardData | null = null;
  updateInterval: ReturnType<typeof setInterval> | null = null;
  initialized = false;
  onCronClick: ((event: MouseEvent) => void) | null = null;
  tokenData: DashboardTokenData | null = null;
  healthData: HealthReportResponse | null = null;
  connectorStatus: ConnectorStatusItem[] = [];
  connectorEvents: ConnectorEventsResponse | null = null;
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

  constructor() {
    this.data = null;
    this.updateInterval = null;
    this.initialized = false;
    this.onCronClick = null;
  }

  /**
   * Initialize Control Tower
   */
  async init(): Promise<void> {
    if (this.initialized) {
      return;
    }
    this.initialized = true;

    // Event delegation for dashboard actions
    this.onCronClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (!target) return;

      const cronButton = target.closest<HTMLElement>('[data-action="run-cron"]');
      if (cronButton) {
        const jobId = cronButton.getAttribute('data-cron-id');
        if (jobId) this.runCronJob(jobId);
        return;
      }

      const pollBtn = target.closest<HTMLElement>('[data-action="poll-connector"]');
      if (pollBtn) {
        const name = pollBtn.getAttribute('data-connector-name');
        if (name) this.triggerPoll(name);
      }
    };
    document.addEventListener('click', this.onCronClick);

    await this.loadStatus();

    // Auto-refresh every 30 seconds
    this.updateInterval = setInterval(() => this.loadStatus(), 30000);
  }

  /**
   * Load all dashboard data from APIs
   */
  async loadStatus(): Promise<void> {
    try {
      this.data = await API.get<DashboardData>('/api/dashboard/status');

      // Load all data in parallel
      const [cronData, tokenData, healthData] = await Promise.allSettled([
        API.getCronJobs(),
        Promise.all([API.getTokenSummary(), API.getTokensByAgent()]),
        API.getHealthReport(),
      ]);

      this.cronData = cronData.status === 'fulfilled' ? cronData.value : null;
      if (tokenData.status === 'fulfilled') {
        this.tokenData = { summary: tokenData.value[0], byAgent: tokenData.value[1] };
      }
      this.healthData = healthData.status === 'fulfilled' ? healthData.value : null;

      // Load connector data in parallel
      await Promise.allSettled([this.loadConnectorStatus(), this.loadConnectorEvents()]);

      this.render();
      this.setStatus(`Last updated: ${new Date().toLocaleTimeString()}`);
    } catch (error) {
      logger.error('[Dashboard] Load error:', error);
      this.setStatus(`Error: ${getErrorMessage(error)}`, 'error');
    }
  }

  /**
   * Load connector status from API
   */
  async loadConnectorStatus(): Promise<void> {
    try {
      const data = await API.get<{ connectors: ConnectorStatusItem[] }>('/api/connectors/status');
      this.connectorStatus = data?.connectors || [];
    } catch {
      this.connectorStatus = [];
    }
    this.renderConnectorStatus();
  }

  /**
   * Load connector events from API
   */
  async loadConnectorEvents(): Promise<void> {
    try {
      this.connectorEvents = await API.get<ConnectorEventsResponse>('/api/connectors/events');
    } catch {
      this.connectorEvents = null;
    }
    this.renderConnectorEvents();
  }

  /**
   * Render all dashboard sections
   */
  render(): void {
    if (!this.data) return;

    this.renderConnectorStatus();
    this.renderConnectorEvents();
    this.renderMemoryStats();
    this.renderGateways();
    this.renderSystemHealth();
    this.renderCronJobs();
    this.renderTokenSummary();
  }

  /**
   * Render connected apps panel
   */
  renderConnectorStatus(): void {
    const container = getElementByIdOrNull<HTMLElement>('connector-status');
    if (!container) return;

    if (this.connectorStatus.length === 0) {
      container.innerHTML = `
        <div class="bg-white border border-gray-200 rounded-lg p-3 text-center">
          <p class="text-sm text-gray-400">No connectors configured</p>
          <p class="text-[10px] text-gray-300 mt-1">Use <code>mama connector add</code> to connect apps</p>
        </div>
      `;
      return;
    }

    const html = this.connectorStatus
      .map((c) => {
        const icon = CONNECTOR_ICONS[c.name] || '🔌';
        const dot = c.enabled ? (c.healthy ? '🟢' : '🟡') : '⚪';
        const lastPoll = c.lastPollTime ? formatRelativeTime(c.lastPollTime) : 'never';
        const pollBtn = c.enabled
          ? `<button data-action="poll-connector" data-connector-name="${escapeAttr(c.name)}"
              class="text-[10px] text-gray-400 hover:text-mama-yellow-hover ml-auto">poll</button>`
          : '';

        return `
          <div class="flex items-center gap-2 bg-white border border-gray-200 rounded-lg px-3 py-2">
            <span class="text-xs">${dot}</span>
            <span class="text-sm">${icon}</span>
            <div class="flex-1 min-w-0">
              <span class="text-xs font-medium text-gray-900">${escapeHtml(c.name)}</span>
              ${c.enabled ? `<span class="text-[10px] text-gray-400 ml-1">${lastPoll}</span>` : ''}
            </div>
            ${c.enabled && c.lastPollCount > 0 ? `<span class="text-[10px] bg-blue-50 text-blue-600 px-1.5 py-0.5 rounded">${c.lastPollCount}</span>` : ''}
            ${pollBtn}
          </div>
        `;
      })
      .join('');

    container.innerHTML = html;
  }

  /**
   * Render event stream timeline
   */
  renderConnectorEvents(): void {
    const container = getElementByIdOrNull<HTMLElement>('connector-events');
    const statsEl = getElementByIdOrNull<HTMLElement>('connector-event-stats');
    if (!container) return;

    if (!this.connectorEvents || this.connectorEvents.events.length === 0) {
      container.innerHTML = `
        <div class="text-sm text-gray-400 text-center py-6">No extraction events yet</div>
      `;
      if (statsEl) statsEl.textContent = '';
      return;
    }

    const { events, stats } = this.connectorEvents;

    if (statsEl) {
      statsEl.textContent = `${stats.totalMemories} memories extracted · ${stats.total} events${stats.errors > 0 ? ` · ${stats.errors} errors` : ''}`;
    }

    const html = events
      .slice(0, 50)
      .map((ev) => {
        const time = new Date(ev.timestamp).toLocaleTimeString([], {
          hour: '2-digit',
          minute: '2-digit',
        });
        const icon = CONNECTOR_ICONS[ev.source] || '📡';
        const isError = !!ev.error;

        return `
          <div class="flex items-start gap-2 py-1.5 border-b border-gray-50 last:border-0 ${isError ? 'bg-red-50' : ''}">
            <span class="text-[10px] text-gray-400 mt-0.5 shrink-0">${time}</span>
            <span class="text-sm shrink-0">${icon}</span>
            <div class="flex-1 min-w-0">
              <span class="text-xs font-medium text-gray-700">${escapeHtml(ev.channel)}</span>
              ${
                isError
                  ? `<span class="text-[10px] text-red-500 ml-1">${escapeHtml(ev.error!)}</span>`
                  : ev.memoriesExtracted > 0
                    ? `<span class="text-[10px] text-green-600 ml-1">${ev.memoriesExtracted} memories</span>`
                    : `<span class="text-[10px] text-gray-400 ml-1">no new memories</span>`
              }
            </div>
          </div>
        `;
      })
      .join('');

    container.innerHTML = html;
  }

  /**
   * Render gateway status cards
   */
  renderGateways(): void {
    const container = getElementByIdOrNull<HTMLElement>('dashboard-gateways');
    if (!container || !this.data?.gateways) return;

    const gateways = [
      { key: 'discord', name: 'Discord', icon: '💬', color: 'indigo' },
      { key: 'slack', name: 'Slack', icon: '📱', color: 'green' },
      { key: 'telegram', name: 'Telegram', icon: '✈️', color: 'blue' },
      { key: 'chatwork', name: 'Chatwork', icon: '💼', color: 'orange' },
    ];

    const html = gateways
      .map((gw) => {
        const status = this.data!.gateways![gw.key] || {};
        const isConfigured = status.configured;
        const isEnabled = status.enabled;

        const statusBadge = isConfigured
          ? isEnabled
            ? `<span class="text-[10px] px-2 py-0.5 rounded-full bg-green-100 text-green-600 font-medium">Active</span>`
            : `<span class="text-[10px] px-2 py-0.5 rounded-full bg-yellow-100 text-yellow-600 font-medium">Off</span>`
          : `<span class="text-[10px] px-2 py-0.5 rounded-full bg-gray-100 text-gray-500 font-medium">---</span>`;

        return `
          <div class="bg-white border border-gray-200 rounded-lg p-3 hover:shadow-md transition-shadow">
            <div class="flex items-center justify-between mb-1.5">
              <span class="text-lg">${gw.icon}</span>
              ${statusBadge}
            </div>
            <h3 class="font-semibold text-sm text-gray-900">${gw.name}</h3>
          </div>
        `;
      })
      .join('');

    container.innerHTML = html;
  }

  /**
   * Render memory statistics
   */
  renderMemoryStats(): void {
    const container = getElementByIdOrNull<HTMLElement>('dashboard-memory');
    if (!container || !this.data?.memory) return;

    const memory = this.data.memory;
    const stats = [
      { label: 'Total Facts', value: memory.total || 0, icon: '🧠' },
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
   * Render system health section
   */
  renderSystemHealth(): void {
    const container = getElementByIdOrNull<HTMLElement>('dashboard-health');
    if (!container) return;

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
    if (!container) return;

    if (!this.tokenData?.summary) {
      container.innerHTML = `
        <p class="text-gray-500 text-sm text-center py-4">
          Token tracking not yet available.
        </p>
      `;
      return;
    }

    const s = this.tokenData.summary;
    const agents = this.tokenData.byAgent?.agents || [];

    const formatTokens = (n: number | undefined): string => {
      if (!n || n === 0) return '0';
      if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
      if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
      return n.toString();
    };

    const formatCost = (usd: number | undefined): string => {
      if (!usd || usd === 0) return '$0.00';
      return '$' + usd.toFixed(2);
    };

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
   * Render cron jobs section
   */
  renderCronJobs(): void {
    const container = getElementByIdOrNull<HTMLElement>('dashboard-cron');
    if (!container) return;

    const jobs = this.cronData?.jobs || this.cronData || [];

    if (!Array.isArray(jobs) || jobs.length === 0) {
      container.innerHTML = `
        <p class="text-gray-500 text-sm text-center py-4">
          No cron jobs configured.
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

    container.innerHTML = `<div class="space-y-0">${rows}</div>`;
  }

  /**
   * Run a cron job immediately
   */
  async runCronJob(id: string): Promise<void> {
    try {
      await API.runCronJob(id);
      this.setStatus(`Cron job "${id}" triggered`);
      await this.loadStatus();
    } catch (e) {
      logger.error('[Dashboard] Failed to run cron job:', e);
      this.setStatus(`Cron job "${id}" failed: ${getErrorMessage(e)}`, 'error');
    }
  }

  /**
   * Trigger a manual connector poll
   */
  async triggerPoll(name: string): Promise<void> {
    try {
      await API.post(`/api/connectors/${name}/poll`, {});
      showToast(`Poll triggered for ${name}`);
    } catch (e) {
      logger.error('[Dashboard] Failed to trigger poll:', e);
      showToast(`Poll failed: ${getErrorMessage(e)}`);
    }
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
