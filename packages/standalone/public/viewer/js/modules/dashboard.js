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

import { escapeHtml } from '../utils/dom.js';

/**
 * Dashboard Module Class
 */
export class DashboardModule {
  constructor() {
    this.data = null;
    this.updateInterval = null;
    this.initialized = false;
  }

  /**
   * Initialize dashboard
   */
  async init() {
    if (this.initialized) {
      return;
    }
    this.initialized = true;

    await this.loadStatus();

    // Auto-refresh every 30 seconds
    this.updateInterval = setInterval(() => this.loadStatus(), 30000);
  }

  /**
   * Load dashboard status from API
   */
  async loadStatus() {
    try {
      const response = await fetch('/api/dashboard/status');
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      this.data = await response.json();
      this.render();
      this.setStatus(`Last updated: ${new Date().toLocaleTimeString()}`);
    } catch (error) {
      console.error('[Dashboard] Load error:', error);
      this.setStatus(`Error: ${error.message}`, 'error');
    }
  }

  /**
   * Render all dashboard sections
   */
  render() {
    if (!this.data) {
      return;
    }

    this.renderGateways();
    this.renderMemoryStats();
    this.renderAgentConfig();
    this.renderTopTopics();
  }

  /**
   * Render gateway status cards
   */
  renderGateways() {
    const container = document.getElementById('dashboard-gateways');
    if (!container || !this.data.gateways) {
      return;
    }

    const gateways = [
      { key: 'discord', name: 'Discord', icon: '💬', color: 'indigo' },
      { key: 'slack', name: 'Slack', icon: '📱', color: 'green' },
      { key: 'telegram', name: 'Telegram', icon: '✈️', color: 'blue' },
      { key: 'chatwork', name: 'Chatwork', icon: '💼', color: 'orange' },
    ];

    const html = gateways
      .map((gw) => {
        const status = this.data.gateways[gw.key] || {};
        const isConfigured = status.configured;
        const isEnabled = status.enabled;

        const statusBadge = isConfigured
          ? isEnabled
            ? `<span class="text-xs px-2 py-0.5 rounded-full bg-green-100 dark:bg-green-900/30 text-green-600 dark:text-green-400">Enabled</span>`
            : `<span class="text-xs px-2 py-0.5 rounded-full bg-yellow-100 dark:bg-yellow-900/30 text-yellow-600 dark:text-yellow-400">Disabled</span>`
          : `<span class="text-xs px-2 py-0.5 rounded-full bg-gray-100 dark:bg-gray-700 text-gray-500">Not Configured</span>`;

        return `
          <div class="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg p-4 hover:shadow-md transition-shadow">
            <div class="flex items-center justify-between mb-2">
              <span class="text-2xl">${gw.icon}</span>
              ${statusBadge}
            </div>
            <h3 class="font-semibold text-gray-900 dark:text-gray-100">${gw.name}</h3>
            <p class="text-xs text-gray-500 dark:text-gray-400 mt-1">
              ${isConfigured ? 'Token configured' : 'No token set'}
            </p>
          </div>
        `;
      })
      .join('');

    container.innerHTML = html;
  }

  /**
   * Render memory statistics
   */
  renderMemoryStats() {
    const container = document.getElementById('dashboard-memory');
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
        <div class="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg p-4 text-center">
          <span class="text-2xl">${stat.icon}</span>
          <p class="text-2xl font-bold text-gray-900 dark:text-gray-100 mt-2">${stat.value}</p>
          <p class="text-xs text-gray-500 dark:text-gray-400">${stat.label}</p>
        </div>
      `
      )
      .join('');

    container.innerHTML = html;
  }

  /**
   * Render agent configuration
   */
  renderAgentConfig() {
    const container = document.getElementById('dashboard-agent');
    if (!container || !this.data.agent) {
      return;
    }

    const agent = this.data.agent;
    const heartbeat = this.data.heartbeat || {};

    container.innerHTML = `
      <div class="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div>
          <p class="text-xs text-gray-500 dark:text-gray-400 uppercase tracking-wide">Model</p>
          <p class="font-semibold text-gray-900 dark:text-gray-100 text-sm mt-1">${escapeHtml(agent.model || 'N/A')}</p>
        </div>
        <div>
          <p class="text-xs text-gray-500 dark:text-gray-400 uppercase tracking-wide">Max Turns</p>
          <p class="font-semibold text-gray-900 dark:text-gray-100 text-sm mt-1">${agent.maxTurns || 'N/A'}</p>
        </div>
        <div>
          <p class="text-xs text-gray-500 dark:text-gray-400 uppercase tracking-wide">Timeout</p>
          <p class="font-semibold text-gray-900 dark:text-gray-100 text-sm mt-1">${this.formatTimeout(agent.timeout)}</p>
        </div>
        <div>
          <p class="text-xs text-gray-500 dark:text-gray-400 uppercase tracking-wide">Heartbeat</p>
          <p class="font-semibold text-gray-900 dark:text-gray-100 text-sm mt-1">
            ${heartbeat.enabled ? `Every ${Math.round((heartbeat.interval || 1800000) / 60000)}min` : 'Disabled'}
          </p>
        </div>
      </div>
      ${
        heartbeat.enabled
          ? `
        <div class="mt-3 pt-3 border-t border-gray-200 dark:border-gray-700">
          <p class="text-xs text-gray-500 dark:text-gray-400">
            Quiet hours: ${heartbeat.quietStart || 23}:00 - ${heartbeat.quietEnd || 8}:00
          </p>
        </div>
      `
          : ''
      }
    `;
  }

  /**
   * Render top topics
   */
  renderTopTopics() {
    const container = document.getElementById('dashboard-topics');
    if (!container || !this.data.memory) {
      return;
    }

    const topics = this.data.memory.topTopics || [];

    if (topics.length === 0) {
      container.innerHTML = `
        <p class="text-gray-500 dark:text-gray-400 text-sm">No topics yet. Start making decisions!</p>
      `;
      return;
    }

    const maxCount = Math.max(...topics.map((t) => t.count));

    const html = topics
      .map(
        (topic) => `
        <div class="flex items-center gap-3 mb-2">
          <div class="flex-1">
            <div class="flex justify-between items-center mb-1">
              <span class="text-sm font-medium text-gray-900 dark:text-gray-100">${escapeHtml(topic.topic)}</span>
              <span class="text-xs text-gray-500 dark:text-gray-400">${topic.count}</span>
            </div>
            <div class="w-full bg-gray-200 dark:bg-gray-700 rounded-full h-2">
              <div class="bg-indigo-500 h-2 rounded-full" style="width: ${(topic.count / maxCount) * 100}%"></div>
            </div>
          </div>
        </div>
      `
      )
      .join('');

    container.innerHTML = html;
  }

  /**
   * Format timeout in human readable format
   */
  formatTimeout(ms) {
    if (!ms) {
      return 'N/A';
    }
    if (ms < 60000) {
      return `${Math.round(ms / 1000)}s`;
    }
    return `${Math.round(ms / 60000)}min`;
  }

  /**
   * Set status message
   */
  setStatus(message, type = '') {
    const statusEl = document.getElementById('dashboard-status');
    if (statusEl) {
      statusEl.textContent = message;
      statusEl.className = `text-sm text-center py-2 ${type === 'error' ? 'text-red-500' : 'text-gray-500 dark:text-gray-400'}`;
    }
  }

  /**
   * Cleanup interval on destroy
   */
  cleanup() {
    if (this.updateInterval) {
      clearInterval(this.updateInterval);
      this.updateInterval = null;
    }
  }
}
