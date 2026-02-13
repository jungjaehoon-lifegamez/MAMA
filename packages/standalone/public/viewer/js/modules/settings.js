/**
 * Settings Module - MAMA OS Settings Management
 * @module modules/settings
 * @version 1.0.0
 *
 * Handles Settings tab functionality including:
 * - Load current configuration
 * - Save configuration changes
 * - Form validation
 * - Gateway enable/disable toggles
 */

/* eslint-env browser */

import { showToast, escapeHtml, escapeAttr } from '../utils/dom.js';
import { formatModelName } from '../utils/format.js';
import { DebugLogger } from '../utils/debug-logger.js';

const logger = new DebugLogger('Settings');

// Model options by backend (single source of truth)
const MODEL_OPTIONS = {
  codex: ['gpt-5.3-codex', 'gpt-5.2', 'gpt-5.1', 'gpt-4.1'],
  claude: ['claude-sonnet-4-20250514', 'claude-opus-4-5-20251101', 'claude-haiku-3-5-20241022'],
};

/**
 * Settings Module Class
 */
export class SettingsModule {
  constructor() {
    this.config = null;
    this.initialized = false;
    this.backendListenersInitialized = false;
  }

  /**
   * Initialize settings module
   */
  async init() {
    if (this.initialized) {
      return;
    }
    this.initialized = true;

    await this.loadSettings();
    this.initBackendModelBinding();
  }

  /**
   * Load current settings from API
   */
  async loadSettings() {
    this.setStatus('Loading...');

    try {
      const response = await fetch('/api/config');
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      this.config = await response.json();

      // Load MCP servers data
      try {
        const mcpResponse = await fetch('/api/mcp-servers');
        if (mcpResponse.ok) {
          this.mcpServersData = await mcpResponse.json();
        } else {
          this.mcpServersData = { servers: [] };
        }
      } catch (e) {
        logger.warn('MCP servers data unavailable:', e);
        this.mcpServersData = { servers: [] };
      }

      // Load multi-agent data (F3)
      try {
        const multiAgentResponse = await fetch('/api/multi-agent/agents');
        if (multiAgentResponse.ok) {
          this.multiAgentData = await multiAgentResponse.json();
        } else {
          this.multiAgentData = { agents: [] };
        }
      } catch (e) {
        logger.warn('Multi-agent data unavailable:', e);
        this.multiAgentData = { agents: [] };
      }

      this.populateForm();
      this.setStatus('');
    } catch (error) {
      logger.error('Load error:', error);
      this.setStatus(`Error: ${error.message}`, 'error');
    }
  }

  /**
   * Populate form with current config values
   */
  populateForm() {
    if (!this.config) {
      return;
    }

    // Discord
    this.setCheckbox('settings-discord-enabled', this.config.discord?.enabled);
    this.setValue('settings-discord-token', this.config.discord?.token || '', true);
    this.setValue('settings-discord-channel', this.config.discord?.default_channel_id || '');

    // Slack
    this.setCheckbox('settings-slack-enabled', this.config.slack?.enabled);
    this.setValue('settings-slack-bot-token', this.config.slack?.bot_token || '', true);
    this.setValue('settings-slack-app-token', this.config.slack?.app_token || '', true);

    // Telegram
    this.setCheckbox('settings-telegram-enabled', this.config.telegram?.enabled);
    this.setValue('settings-telegram-token', this.config.telegram?.token || '', true);

    // Chatwork
    this.setCheckbox('settings-chatwork-enabled', this.config.chatwork?.enabled);
    this.setValue('settings-chatwork-token', this.config.chatwork?.api_token || '', true);

    // Heartbeat
    this.setCheckbox('settings-heartbeat-enabled', this.config.heartbeat?.enabled);
    this.setValue(
      'settings-heartbeat-interval',
      Math.round((this.config.heartbeat?.interval || 1800000) / 60000)
    );
    this.setValue('settings-heartbeat-quiet-start', this.config.heartbeat?.quiet_start ?? 23);
    this.setValue('settings-heartbeat-quiet-end', this.config.heartbeat?.quiet_end ?? 8);

    // Agent
    const backend = this.config.agent?.backend || 'claude';
    const model = this.config.agent?.model || 'claude-sonnet-4-20250514';
    this.setSelectValue('settings-agent-backend', backend);
    this.updateModelOptions(backend, model);
    this.setValue('settings-agent-model', this.getNormalizedModelForBackend(backend, model));
    this.updatePersistentCliToggle(backend, this.config.agent?.use_persistent_cli || false);
    this.setValue('settings-agent-max-turns', this.config.agent?.max_turns || 10);
    this.setValue(
      'settings-agent-timeout',
      Math.round((this.config.agent?.timeout || 300000) / 1000)
    );

    // Tool Mode
    this.populateToolMode();

    // Role Permissions
    this.populateRoles();

    // Multi-Agent Team (F3)
    this.populateMultiAgentSection();

    // Skills + Token Budget + Cron
    this.populateSkillsSection();
    this.populateTokenSection();
    this.populateCronSection();
  }

  /**
   * Populate role permissions from config
   */
  populateRoles() {
    const container = document.getElementById('settings-roles-container');
    if (!container || !this.config.roles) {
      return;
    }

    const { definitions, sourceMapping } = this.config.roles;
    if (!definitions || !sourceMapping) {
      return;
    }

    // Build reverse mapping: role -> sources
    const roleSources = {};
    for (const [source, role] of Object.entries(sourceMapping)) {
      if (!roleSources[role]) {
        roleSources[role] = [];
      }
      roleSources[role].push(source);
    }

    // Render each role
    const roleColors = {
      os_agent: { badge: 'green', label: 'Full Access' },
      chat_bot: { badge: 'yellow', label: 'Limited' },
    };

    const roleIcons = {
      os_agent: '🖥️',
      chat_bot: '🤖',
    };

    const html = Object.entries(definitions)
      .map(([roleName, roleConfig]) => {
        const sources = roleSources[roleName] || [];
        const color = roleColors[roleName] || { badge: 'gray', label: 'Custom' };
        const icon = roleIcons[roleName] || '⚙️';
        const displayName = escapeHtml(
          roleName.replace(/_/g, ' ').replace(/\b\w/g, (l) => l.toUpperCase())
        );

        const allowedTools = roleConfig.allowedTools || [];
        const blockedTools = roleConfig.blockedTools || [];
        const hasSystemControl = roleConfig.systemControl;
        const hasSensitiveAccess = roleConfig.sensitiveAccess;
        const model = roleConfig.model || 'default';
        const maxTurns = roleConfig.maxTurns;

        // Format model name for display (and escape)
        const displayModel = escapeHtml(formatModelName(model));

        return `
          <div class="bg-white border border-gray-200 rounded-lg p-2.5">
            <div class="flex items-center justify-between mb-2">
              <div class="flex items-center gap-2">
                <span class="text-xl">${icon}</span>
                <h3 class="font-semibold text-gray-900 text-sm">${displayName}</h3>
                <span class="text-[10px] bg-${color.badge}-100 text-${color.badge}-800 px-1.5 py-0.5 rounded">${color.label}</span>
              </div>
            </div>
            <div class="text-xs text-gray-600 space-y-1">
              <div class="flex items-center gap-2">
                <span class="font-medium">Model:</span>
                <span class="bg-indigo-50 text-indigo-700 px-1.5 py-0.5 rounded text-[10px] font-medium">${displayModel}</span>
                ${maxTurns ? `<span class="text-gray-400">| ${escapeHtml(maxTurns)} turns</span>` : ''}
              </div>
              <div><span class="font-medium">Source:</span> ${sources.map((s) => `<code class="bg-gray-100 px-1 rounded">${escapeHtml(s)}</code>`).join(' ')}</div>
              <div><span class="font-medium">Allowed:</span> <code class="text-green-600 text-[10px]">${escapeHtml(allowedTools.join(', '))}</code></div>
              ${blockedTools.length > 0 ? `<div><span class="font-medium">Blocked:</span> <code class="text-red-600 text-[10px]">${escapeHtml(blockedTools.join(', '))}</code></div>` : ''}
              ${
                hasSystemControl || hasSensitiveAccess
                  ? `<div><span class="font-medium">Permissions:</span>
                ${hasSystemControl ? '<span class="inline-block bg-blue-100 text-blue-800 text-[10px] px-1 rounded mr-1">systemControl</span>' : ''}
                ${hasSensitiveAccess ? '<span class="inline-block bg-purple-100 text-purple-800 text-[10px] px-1 rounded">sensitiveAccess</span>' : ''}
              </div>`
                  : ''
              }
            </div>
          </div>
        `;
      })
      .join('');

    container.innerHTML = html;
  }

  /**
   * Populate tool selection checkboxes
   */
  populateToolMode() {
    const tools = this.config.agent?.tools || { gateway: ['*'], mcp: [] };
    const gatewayTools = tools.gateway || ['*'];
    const mcpTools = tools.mcp || [];

    // Set Gateway tool checkboxes
    const gatewayCheckboxes = document.querySelectorAll('.gateway-tool');
    const isGatewayAll = gatewayTools.includes('*');

    gatewayCheckboxes.forEach((cb) => {
      if (isGatewayAll) {
        cb.checked = true;
      } else {
        cb.checked = gatewayTools.includes(cb.value);
      }
    });

    // Set Select All checkbox
    const gatewaySelectAll = document.getElementById('gateway-select-all');
    if (gatewaySelectAll) {
      gatewaySelectAll.checked = isGatewayAll || this.allChecked('.gateway-tool');
    }

    // Dynamically render MCP servers from API
    this.renderMCPServers(mcpTools);

    // Update summary
    this.updateToolSummary();
  }

  /**
   * Render MCP servers dynamically from loaded data
   */
  renderMCPServers(selectedTools = []) {
    const container = document.getElementById('mcp-tools-list');
    if (!container) {
      return;
    }

    const servers = this.mcpServersData?.servers || [];
    const isMCPAll = selectedTools.includes('*');

    if (servers.length === 0) {
      container.innerHTML = `
        <p class="text-xs text-gray-500 col-span-full">
          No MCP servers configured. Add servers to ~/.mama/mama-mcp-config.json
        </p>
      `;
      return;
    }

    const serverColors = {
      'brave-devtools': { border: 'border-blue-200', bg: 'bg-blue-50', icon: '🌐' },
      'brave-search': { border: 'border-orange-200', bg: 'bg-orange-50', icon: '🔍' },
      mama: { border: 'border-purple-200', bg: 'bg-purple-50', icon: '🧠' },
      default: { border: 'border-gray-200', bg: 'bg-gray-50', icon: '🔌' },
    };

    const html = servers
      .map((server) => {
        const colors = serverColors[server.name] || serverColors['default'];
        const toolValue = `mcp__${server.name}__*`;
        const isChecked = isMCPAll || selectedTools.includes(toolValue);
        // Escape server.name for safe HTML rendering (XSS prevention)
        const safeName = escapeHtml(server.name);
        const safeToolValue = escapeAttr(toolValue);

        return `
        <label class="flex items-center gap-2 p-2 border ${colors.border} rounded-lg text-xs cursor-pointer hover:${colors.bg}">
          <input type="checkbox" class="mcp-tool" value="${safeToolValue}" ${isChecked ? 'checked' : ''}>
          ${colors.icon} ${safeName}
        </label>
      `;
      })
      .join('');

    container.innerHTML = html;

    // Update Select All checkbox
    const mcpSelectAll = document.getElementById('mcp-select-all');
    if (mcpSelectAll) {
      mcpSelectAll.checked = isMCPAll || this.allChecked('.mcp-tool');
    }
  }

  /**
   * Check if all checkboxes of a class are checked
   */
  allChecked(selector) {
    const checkboxes = document.querySelectorAll(selector);
    return Array.from(checkboxes).every((cb) => cb.checked);
  }

  /**
   * Toggle all Gateway tools
   */
  toggleAllGateway(checked) {
    document.querySelectorAll('.gateway-tool').forEach((cb) => {
      cb.checked = checked;
    });
    this.updateToolSummary();
  }

  /**
   * Toggle all MCP tools
   */
  toggleAllMCP(checked) {
    document.querySelectorAll('.mcp-tool').forEach((cb) => {
      cb.checked = checked;
    });
    this.updateToolSummary();
  }

  /**
   * Update tool summary display
   */
  updateToolSummary() {
    const gatewayCount = document.querySelectorAll('.gateway-tool:checked').length;
    const mcpCount = document.querySelectorAll('.mcp-tool:checked').length;

    const summaryEl = document.getElementById('tool-summary');
    if (summaryEl) {
      summaryEl.textContent = `Gateway: ${gatewayCount} tools | MCP: ${mcpCount} tools`;
    }
  }

  /**
   * Save settings and restart daemon to apply changes
   */
  async saveAndRestart() {
    this.setStatus('Saving...');

    try {
      const updates = this.collectFormData();

      const response = await fetch('/api/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates),
      });

      const result = await response.json();

      if (!response.ok) {
        throw new Error(result.message || `HTTP ${response.status}`);
      }

      this.setStatus('Saved! Restarting...', 'success');
      showToast('Settings saved. Restarting daemon...');

      // Trigger restart after save
      try {
        await fetch('/api/restart', { method: 'POST' });
      } catch {
        // Expected: connection drops when server exits
      }

      this.setStatus('Restarting... page will reconnect automatically', '');
    } catch (error) {
      logger.error('Save error:', error);
      this.setStatus(`Error: ${error.message}`, 'error');
      showToast(`Failed to save: ${error.message}`);
    }
  }

  /**
   * Collect form data into config update object
   */
  collectFormData() {
    const backend = this.getSelectValue('settings-agent-backend') || 'claude';
    const model = this.getValue('settings-agent-model');
    const useClaudeCli = backend === 'claude';

    // Get token values - if empty and original was masked, keep original
    const discordToken = this.getTokenValue('settings-discord-token', this.config.discord?.token);
    const slackBotToken = this.getTokenValue(
      'settings-slack-bot-token',
      this.config.slack?.bot_token
    );
    const slackAppToken = this.getTokenValue(
      'settings-slack-app-token',
      this.config.slack?.app_token
    );
    const telegramToken = this.getTokenValue(
      'settings-telegram-token',
      this.config.telegram?.token
    );
    const chatworkToken = this.getTokenValue(
      'settings-chatwork-token',
      this.config.chatwork?.api_token
    );

    return {
      discord: {
        enabled: this.getCheckbox('settings-discord-enabled'),
        token: discordToken,
        default_channel_id: this.getValue('settings-discord-channel'),
      },
      slack: {
        enabled: this.getCheckbox('settings-slack-enabled'),
        bot_token: slackBotToken,
        app_token: slackAppToken,
      },
      telegram: {
        enabled: this.getCheckbox('settings-telegram-enabled'),
        token: telegramToken,
      },
      chatwork: {
        enabled: this.getCheckbox('settings-chatwork-enabled'),
        api_token: chatworkToken,
      },
      heartbeat: {
        enabled: this.getCheckbox('settings-heartbeat-enabled'),
        interval: parseInt(this.getValue('settings-heartbeat-interval') || '30', 10) * 60000,
        quiet_start: parseInt(this.getValue('settings-heartbeat-quiet-start') || '23', 10),
        quiet_end: parseInt(this.getValue('settings-heartbeat-quiet-end') || '8', 10),
      },
      use_claude_cli: useClaudeCli,
      agent: {
        backend,
        use_persistent_cli: useClaudeCli
          ? this.getCheckbox('settings-agent-persistent-cli')
          : false,
        model: model || (backend === 'codex' ? 'gpt-5.2' : 'claude-sonnet-4-20250514'),
        max_turns: parseInt(this.getValue('settings-agent-max-turns') || '10', 10),
        timeout: parseInt(this.getValue('settings-agent-timeout') || '300', 10) * 1000,
        tools: this.collectToolModeData(),
      },
      token_budget: {
        daily_limit: parseInt(this.getValue('settings-token-daily-limit') || '0', 10) || undefined,
        alert_threshold:
          parseInt(this.getValue('settings-token-alert-threshold') || '0', 10) || undefined,
      },
    };
  }

  initBackendModelBinding() {
    if (this.backendListenersInitialized) {
      return;
    }
    this.backendListenersInitialized = true;
    const backendSelect = document.getElementById('settings-agent-backend');
    if (!backendSelect) {
      return;
    }
    backendSelect.addEventListener('change', () => {
      const backend = this.getSelectValue('settings-agent-backend') || 'claude';
      const currentModel = this.getValue('settings-agent-model');
      this.updateModelOptions(backend, currentModel);
      this.setValue(
        'settings-agent-model',
        this.getNormalizedModelForBackend(backend, currentModel)
      );
      this.updatePersistentCliToggle(backend, this.getCheckbox('settings-agent-persistent-cli'));
    });
  }

  updatePersistentCliToggle(backend, isChecked) {
    const checkbox = document.getElementById('settings-agent-persistent-cli');
    if (!checkbox) {
      return;
    }
    if (backend === 'codex') {
      checkbox.checked = false;
      checkbox.disabled = true;
      checkbox.title = 'Persistent CLI is supported for Claude backend only';
    } else {
      checkbox.disabled = false;
      checkbox.title = '';
      checkbox.checked = Boolean(isChecked);
    }
  }

  updateModelOptions(backend, currentModel) {
    const datalist = document.getElementById('settings-agent-model-list');
    if (!datalist) {
      return;
    }
    const claudeModels = [
      { value: 'claude-sonnet-4-20250514', label: 'Claude Sonnet 4 (Recommended)' },
      { value: 'claude-opus-4-5-20251101', label: 'Claude Opus 4.5' },
      { value: 'claude-haiku-3-5-20241022', label: 'Claude Haiku 3.5' },
    ];
    const codexModels = [
      { value: 'gpt-5.2', label: 'GPT-5.2 (Recommended)' },
      { value: 'gpt-5.1', label: 'GPT-5.1' },
      { value: 'gpt-4.1', label: 'GPT-4.1' },
    ];
    const list = backend === 'codex' ? codexModels : claudeModels;
    datalist.innerHTML = list
      .map((item) => `<option value="${escapeHtml(item.value)}">${escapeHtml(item.label)}</option>`)
      .join('');
    const normalized = this.getNormalizedModelForBackend(backend, currentModel);
    const input = document.getElementById('settings-agent-model');
    if (input && normalized) {
      input.placeholder = backend === 'codex' ? 'gpt-5.2' : 'claude-sonnet-4-20250514';
    }
  }

  getNormalizedModelForBackend(backend, model) {
    if (!model) {
      return backend === 'codex' ? 'gpt-5.2' : 'claude-sonnet-4-20250514';
    }
    const isClaudeModel = /^claude-/i.test(model);
    if (backend === 'codex' && isClaudeModel) {
      return 'gpt-5.2';
    }
    if (backend === 'claude' && !isClaudeModel) {
      return 'claude-sonnet-4-20250514';
    }
    return model;
  }

  /**
   * Collect tool selection data from checkboxes
   */
  collectToolModeData() {
    const gatewayTools = [];
    const mcpTools = [];

    // Collect selected Gateway tools
    document.querySelectorAll('.gateway-tool:checked').forEach((cb) => {
      gatewayTools.push(cb.value);
    });

    // Collect selected MCP tools
    document.querySelectorAll('.mcp-tool:checked').forEach((cb) => {
      mcpTools.push(cb.value);
    });

    // If all Gateway tools are selected, use wildcard
    const allGateway = document.querySelectorAll('.gateway-tool');
    if (gatewayTools.length === allGateway.length && gatewayTools.length > 0) {
      return {
        gateway: ['*'],
        mcp: mcpTools,
        mcp_config: '~/.mama/mama-mcp-config.json',
      };
    }

    return {
      gateway: gatewayTools,
      mcp: mcpTools,
      mcp_config: '~/.mama/mama-mcp-config.json',
    };
  }

  /**
   * Reset form to current saved values
   */
  resetForm() {
    this.populateForm();
    this.setStatus('Form reset');
    setTimeout(() => this.setStatus(''), 2000);
  }

  /**
   * Helper: Set checkbox value
   */
  setCheckbox(id, checked) {
    const el = document.getElementById(id);
    if (el) {
      el.checked = !!checked;
    }
  }

  /**
   * Helper: Get checkbox value
   */
  getCheckbox(id) {
    const el = document.getElementById(id);
    return el ? el.checked : false;
  }

  /**
   * Helper: Set input value
   * @param {string} id - Element ID
   * @param {string} value - Value to set
   * @param {boolean} isSensitive - If true, treat as sensitive token (keep if masked)
   */
  setValue(id, value, isSensitive = false) {
    const el = document.getElementById(id);
    if (el) {
      // For sensitive fields (tokens), preserve placeholder if value is masked
      if (isSensitive && this.isMaskedToken(value)) {
        el.placeholder = value;
        el.value = '';
      } else {
        el.value = value;
      }
    }
  }

  /**
   * Check if a token is masked (e.g., "***[redacted]***")
   */
  isMaskedToken(token) {
    if (!token || typeof token !== 'string') {
      return false;
    }
    return token === '***[redacted]***' || (token.startsWith('***[') && token.endsWith(']***'));
  }

  /**
   * Get token value from input, preserving original if input is empty and original was masked
   * @param {string} id - Input element ID
   * @param {string} originalToken - Original token value from config
   * @returns {string} Token to send (either new value or original masked token)
   */
  getTokenValue(id, originalToken) {
    const inputValue = this.getValue(id);

    // If user entered a new value, use it
    if (inputValue && inputValue.trim() !== '') {
      return inputValue;
    }

    // If input is empty and original was masked, keep the masked token (backend will preserve it)
    if (this.isMaskedToken(originalToken)) {
      return originalToken;
    }

    // Otherwise return the input value (may be empty)
    return inputValue;
  }

  /**
   * Helper: Get input value
   */
  getValue(id) {
    const el = document.getElementById(id);
    return el ? el.value : '';
  }

  /**
   * Helper: Set select value
   */
  setSelectValue(id, value) {
    const el = document.getElementById(id);
    if (el) {
      el.value = value;
    }
  }

  /**
   * Helper: Get select value
   */
  getSelectValue(id) {
    const el = document.getElementById(id);
    return el ? el.value : '';
  }

  /**
   * Helper: Set radio button
   */
  setRadio(id, checked) {
    const el = document.getElementById(id);
    if (el) {
      el.checked = !!checked;
    }
  }

  /**
   * Helper: Get radio button value
   */
  getRadio(id) {
    const el = document.getElementById(id);
    return el ? el.checked : false;
  }

  /**
   * Set status message
   */
  setStatus(message, type = '') {
    const statusEl = document.getElementById('settings-status');
    if (statusEl) {
      statusEl.textContent = message;
      statusEl.className = `text-sm ${
        type === 'error'
          ? 'text-red-500'
          : type === 'success'
            ? 'text-green-500'
            : 'text-gray-500 dark:text-gray-400'
      }`;
    }
  }

  /**
   * Populate Multi-Agent Team section (F3)
   */
  populateMultiAgentSection() {
    const container = document.getElementById('settings-multi-agent-container');
    if (!container) {
      return;
    }

    const agents = this.multiAgentData?.agents || [];

    if (agents.length === 0) {
      container.innerHTML = `
        <div class="bg-white border border-gray-200 rounded-lg p-3 text-xs text-gray-500">
          No agents configured. Add agents in <code class="bg-gray-100 px-1 rounded">config.yaml</code>
        </div>
      `;
      return;
    }

    // Tier badge colors
    const tierColors = {
      1: 'bg-indigo-100 text-indigo-700',
      2: 'bg-green-100 text-green-700',
      3: 'bg-yellow-100 text-yellow-700',
    };

    // Mask token (show last 4 chars)
    const maskToken = (token) => {
      if (!token || token.length < 8) {
        return '****';
      }
      return '****' + token.slice(-4);
    };

    const agentCards = agents
      .map((agent) => {
        const tierColor = tierColors[agent.tier] || tierColors[1];
        const backend = agent.backend || this.config?.agent?.backend || 'claude';
        const normalizedModel = this.getNormalizedModelForBackend(backend, agent.model);
        const friendlyModel = formatModelName(normalizedModel) || normalizedModel || 'Default';
        const maskedToken = agent.bot_token ? maskToken(agent.bot_token) : 'N/A';
        const backendOptions = ['codex', 'claude']
          .map(
            (b) =>
              `<option value="${escapeAttr(b)}" ${backend === b ? 'selected' : ''}>${escapeHtml(b)}</option>`
          )
          .join('');
        const modelListId = `agent-model-list-${agent.id}`;
        const modelOptions = MODEL_OPTIONS[backend] || MODEL_OPTIONS.claude;
        const modelOptionHtml = modelOptions
          .map((m) => `<option value="${escapeAttr(m)}">${escapeHtml(formatModelName(m))}</option>`)
          .join('');

        return `
          <div class="bg-white border border-gray-200 rounded-lg p-2.5">
            <div class="flex items-center justify-between mb-1.5">
              <div class="flex items-center gap-2">
                <span class="${tierColor} text-xs font-bold px-1.5 py-0.5 rounded">T${agent.tier}</span>
                <h3 class="font-semibold text-gray-900 text-sm">${escapeHtml(agent.name)}</h3>
              </div>
              <label class="relative inline-flex items-center cursor-pointer">
                <input
                  type="checkbox"
                  class="sr-only peer"
                  data-agent-id="${escapeAttr(agent.id)}"
                  ${agent.enabled ? 'checked' : ''}
                  onchange="window.settingsModule.toggleAgent('${escapeAttr(agent.id)}', this.checked)"
                >
                <div class="w-9 h-5 bg-gray-200 peer-focus:ring-2 peer-focus:ring-yellow-300 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-green-500"></div>
              </label>
            </div>
            <div class="grid grid-cols-2 gap-1 text-xs text-gray-600">
              <div><span class="font-medium">Model:</span> ${escapeHtml(friendlyModel)}</div>
              <div><span class="font-medium">Token:</span> <code class="bg-gray-100 px-1 rounded">${maskedToken}</code></div>
            </div>
            <div class="mt-2 grid grid-cols-1 md:grid-cols-3 gap-1.5 text-xs">
              <div>
                <label class="block text-gray-500 mb-0.5">Backend</label>
                <select
                  id="agent-backend-${escapeAttr(agent.id)}"
                  class="w-full rounded border border-gray-200 px-2 py-1"
                  onchange="window.settingsModule.onAgentBackendChange('${escapeHtml(agent.id)}')"
                >
                  ${backendOptions}
                </select>
              </div>
              <div>
                <label class="block text-gray-500 mb-0.5">Model</label>
                <input
                  id="agent-model-${escapeAttr(agent.id)}"
                  list="${escapeAttr(modelListId)}"
                  value="${escapeAttr(normalizedModel)}"
                  class="w-full rounded border border-gray-200 px-2 py-1"
                >
                <datalist id="${escapeAttr(modelListId)}">${modelOptionHtml}</datalist>
              </div>
              <div class="flex items-end">
                <button
                  class="w-full px-2 py-1 rounded bg-yellow-400 text-black hover:bg-yellow-300"
                  onclick="window.settingsModule.saveAgentConfig('${escapeAttr(agent.id)}')"
                >
                  Save
                </button>
              </div>
            </div>
          </div>
        `;
      })
      .join('');

    container.innerHTML = agentCards;
  }

  /**
   * Toggle agent enabled status (F3)
   */
  async toggleAgent(agentId, enabled) {
    try {
      const response = await fetch(`/api/multi-agent/agents/${agentId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled }),
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      logger.info(`Agent ${agentId} ${enabled ? 'enabled' : 'disabled'}`);
    } catch (error) {
      logger.error('Failed to toggle agent:', error);
      // Revert checkbox on error
      const checkbox = document.querySelector(`input[data-agent-id="${agentId}"]`);
      if (checkbox) {
        checkbox.checked = !enabled;
      }
      alert(`Failed to update agent: ${error.message}`);
    }
  }

  onAgentBackendChange(agentId) {
    const backendSelect = document.getElementById(`agent-backend-${agentId}`);
    const modelInput = document.getElementById(`agent-model-${agentId}`);
    const modelList = document.getElementById(`agent-model-list-${agentId}`);
    if (!backendSelect || !modelInput || !modelList) {
      return;
    }

    const backend = backendSelect.value || 'claude';
    const currentModel = modelInput.value || '';
    const normalized = this.getNormalizedModelForBackend(backend, currentModel);
    const options = MODEL_OPTIONS[backend] || MODEL_OPTIONS.claude;

    modelList.innerHTML = options
      .map((m) => `<option value="${escapeAttr(m)}">${escapeHtml(formatModelName(m))}</option>`)
      .join('');
    modelInput.value = normalized;
  }

  async saveAgentConfig(agentId) {
    try {
      const backendSelect = document.getElementById(`agent-backend-${agentId}`);
      const modelInput = document.getElementById(`agent-model-${agentId}`);
      if (!backendSelect || !modelInput) {
        throw new Error('Agent settings inputs not found');
      }

      const backend = backendSelect.value || 'claude';
      const model = this.getNormalizedModelForBackend(backend, modelInput.value || '');

      const response = await fetch(`/api/multi-agent/agents/${agentId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ backend, model }),
      });

      const result = await response.json();
      if (!response.ok) {
        throw new Error(result.message || `HTTP ${response.status}`);
      }

      showToast(`Saved ${agentId}: ${backend} / ${model} (applied)`);
      await this.loadSettings();
    } catch (error) {
      logger.error('Failed to save agent config:', error);
      alert(`Failed to save agent config: ${error.message}`);
    }
  }

  /**
   * Populate installed skills section
   */
  async populateSkillsSection() {
    const container = document.getElementById('settings-skills-container');
    if (!container) {
      return;
    }

    try {
      const response = await fetch('/api/skills');
      if (!response.ok) {
        container.innerHTML = '<p class="text-xs text-gray-400">Skills API not available</p>';
        return;
      }

      const { skills } = await response.json();
      if (!skills || skills.length === 0) {
        container.innerHTML = '<p class="text-xs text-gray-400">No skills installed</p>';
        return;
      }

      const sourceColors = {
        mama: 'bg-yellow-100 text-yellow-700',
        cowork: 'bg-blue-100 text-blue-700',
        external: 'bg-purple-100 text-purple-700',
      };

      container.innerHTML = `
        <div class="space-y-1.5">
          ${skills
            .map(
              (s) => `
            <div class="flex items-center justify-between py-1">
              <div class="flex items-center gap-2">
                <span class="text-xs font-medium text-gray-900">${escapeHtml(s.name)}</span>
                <span class="text-[10px] px-1.5 py-0.5 rounded ${sourceColors[s.source] || 'bg-gray-100 text-gray-600'}">${escapeHtml(s.source)}</span>
              </div>
              <label class="relative inline-flex items-center cursor-pointer">
                <input type="checkbox" ${s.enabled !== false ? 'checked' : ''}
                  data-skill-source="${escapeHtml(s.source)}"
                  data-skill-id="${escapeHtml(s.id)}"
                  class="sr-only peer">
                <div class="w-9 h-5 bg-gray-200 peer-focus:ring-2 peer-focus:ring-yellow-300 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-yellow-400"></div>
              </label>
            </div>
          `
            )
            .join('')}
        </div>
      `;
      container.querySelectorAll('input[data-skill-id]').forEach((input) => {
        input.addEventListener('change', (event) => {
          const target = event.target;
          if (!(target instanceof HTMLInputElement)) {
            return;
          }
          const source = target.dataset.skillSource || '';
          const id = target.dataset.skillId || '';
          if (!source || !id) {
            return;
          }
          this.toggleSkill(source, id, target.checked);
        });
      });
    } catch (error) {
      logger.warn('Skills load error:', error);
      container.innerHTML = '<p class="text-xs text-gray-400">Failed to load skills</p>';
    }
  }

  /**
   * Toggle skill enabled/disabled from settings
   */
  async toggleSkill(source, name, enabled) {
    try {
      const response = await fetch(`/api/skills/${encodeURIComponent(name)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled, source }),
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
    } catch (error) {
      logger.error('Skill toggle failed:', error);
      this.populateSkillsSection();
    }
  }

  /**
   * Populate scheduled jobs section
   */
  async populateCronSection() {
    const container = document.getElementById('settings-cron-container');
    if (!container) {
      return;
    }

    try {
      const response = await fetch('/api/cron');
      if (!response.ok) {
        container.innerHTML = '<p class="text-xs text-gray-400">Cron API not available</p>';
        return;
      }

      const { jobs } = await response.json();
      if (!jobs || jobs.length === 0) {
        container.innerHTML = '<p class="text-xs text-gray-400">No scheduled jobs</p>';
        return;
      }

      container.innerHTML = `<div class="space-y-1.5">${jobs
        .map((job) => {
          const nextRun = job.nextRun
            ? new Date(job.nextRun).toLocaleString([], {
                month: 'short',
                day: 'numeric',
                hour: '2-digit',
                minute: '2-digit',
              })
            : '-';
          return `
          <div class="flex items-center justify-between py-1">
            <div class="flex-1 min-w-0">
              <div class="flex items-center gap-2">
                <span class="text-xs font-medium text-gray-900">${escapeHtml(job.name || job.id)}</span>
                <code class="text-[10px] bg-gray-100 px-1 rounded">${escapeHtml(job.schedule || job.cronExpr || '')}</code>
              </div>
              <p class="text-[10px] text-gray-500 truncate">${escapeHtml((job.prompt || '').slice(0, 80))}</p>
            </div>
            <div class="flex items-center gap-1 ml-2 shrink-0">
              <span class="text-[10px] text-gray-400">${nextRun}</span>
              <label class="relative inline-flex items-center cursor-pointer">
                <input type="checkbox" ${job.enabled !== false ? 'checked' : ''}
                  data-cron-id="${escapeHtml(job.id)}"
                  class="sr-only peer cron-toggle">
                <div class="w-9 h-5 bg-gray-200 peer-focus:ring-2 peer-focus:ring-yellow-300 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-yellow-400"></div>
              </label>
              <button onclick="settingsModule.deleteCronJob('${escapeHtml(job.id)}')" class="text-red-400 hover:text-red-600 text-xs px-1" title="Delete">✕</button>
            </div>
          </div>`;
        })
        .join('')}</div>`;

      container.querySelectorAll('.cron-toggle').forEach((input) => {
        input.addEventListener('change', (e) => {
          const id = e.target.dataset.cronId;
          this.toggleCronJob(id, e.target.checked);
        });
      });
    } catch (error) {
      logger.warn('Cron load error:', error);
      container.innerHTML = '<p class="text-xs text-gray-400">Failed to load jobs</p>';
    }
  }

  async addCronJob() {
    const name = document.getElementById('settings-cron-name')?.value?.trim();
    const cronExpr = document.getElementById('settings-cron-expr')?.value?.trim();
    const prompt = document.getElementById('settings-cron-prompt')?.value?.trim();

    if (!name || !cronExpr || !prompt) {
      showToast('Please fill in all fields');
      return;
    }

    try {
      const response = await fetch('/api/cron', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, cron_expr: cronExpr, prompt }),
      });

      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        throw new Error(err.error || `HTTP ${response.status}`);
      }

      document.getElementById('settings-cron-name').value = '';
      document.getElementById('settings-cron-expr').value = '';
      document.getElementById('settings-cron-prompt').value = '';
      showToast('Job created');
      this.populateCronSection();
    } catch (error) {
      showToast(`Failed: ${error.message}`);
    }
  }

  async toggleCronJob(id, enabled) {
    try {
      const response = await fetch(`/api/cron/${encodeURIComponent(id)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled }),
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
    } catch (error) {
      logger.error('Cron toggle failed:', error);
      this.populateCronSection();
    }
  }

  async deleteCronJob(id) {
    if (!confirm('Delete this scheduled job?')) {
      return;
    }
    try {
      const response = await fetch(`/api/cron/${encodeURIComponent(id)}`, { method: 'DELETE' });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      showToast('Job deleted');
      this.populateCronSection();
    } catch (error) {
      showToast(`Failed: ${error.message}`);
    }
  }

  /**
   * Populate token budget section from config
   */
  populateTokenSection() {
    const budget = this.config?.token_budget;
    if (!budget) {
      return;
    }

    this.setValue('settings-token-daily-limit', budget.daily_limit || '');
    this.setValue('settings-token-alert-threshold', budget.alert_threshold || '');
  }
}
