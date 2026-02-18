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

import { showToast, escapeHtml, escapeAttr, getElementByIdOrNull } from '../utils/dom.js';
import { formatModelName } from '../utils/format.js';
import { DebugLogger } from '../utils/debug-logger.js';
import {
  API,
  type ApiConfigResponse,
  type ApiRoleDefinition,
  type CronJob,
  type CronJobsResponse,
  type EffortLevel,
  type McpServer,
  type McpServersResponse,
  type MultiAgentAgent,
  type MultiAgentAgentsResponse,
  type SkillsResponse,
} from '../utils/api.js';

const logger = new DebugLogger('Settings');

type AgentBackend = 'claude' | 'codex-mcp';
type SettingsFilterValue = 'loading' | 'error' | 'success' | '';
type SettingsPayloadToolConfig = {
  gateway: string[];
  mcp: string[];
  mcp_config: string;
};

type SettingsPayload = {
  discord: {
    enabled: boolean;
    token: string;
    default_channel_id: string;
  };
  slack: {
    enabled: boolean;
    bot_token: string;
    app_token: string;
  };
  telegram: {
    enabled: boolean;
    token: string;
  };
  chatwork: {
    enabled: boolean;
    api_token: string;
  };
  heartbeat: {
    enabled: boolean;
    interval: number;
    quiet_start: number;
    quiet_end: number;
  };
  use_claude_cli: boolean;
  agent: {
    backend: AgentBackend;
    model: string;
    effort?: EffortLevel;
    max_turns: number;
    timeout: number;
    tools: SettingsPayloadToolConfig;
  };
  token_budget: {
    daily_limit?: number;
    alert_threshold?: number;
  };
};

// Model options by backend (single source of truth)
// Claude models: https://platform.claude.com/docs/en/about-claude/models/overview
const MODEL_OPTIONS: Record<AgentBackend, readonly string[]> = {
  'codex-mcp': [
    'gpt-5.3-codex',
    'gpt-5.2-codex',
    'gpt-5.1-codex-max',
    'gpt-4.1',
    'gpt-4o',
    'gpt-4o-mini',
    'o1',
    'o1-mini',
    'o3-mini',
  ],
  claude: [
    // Latest models (4.6)
    'claude-opus-4-6',
    'claude-sonnet-4-6',
    // Previous gen (4.5)
    'claude-opus-4-5-20251101',
    'claude-sonnet-4-5-20250929',
    'claude-haiku-4-5-20251001',
    // Legacy models
    'claude-sonnet-4-20250514',
    'claude-opus-4-20250514',
    'claude-3-7-sonnet-20250219',
    'claude-3-haiku-20240307',
  ],
};

/**
 * Settings Module Class
 */
export class SettingsModule {
  config: ApiConfigResponse | null = null;
  mcpServersData: McpServersResponse = { servers: [] };
  multiAgentData: MultiAgentAgentsResponse = { agents: [] };
  initialized = false;
  backendListenersInitialized = false;
  delegatedListenersInitialized = false;

  constructor() {}

  /**
   * Parse and validate required integer input.
   */
  private parseIntegerInput(id: string, min: number, max: number, fallback: number | null): number {
    const raw = this.getValue(id);
    if (raw === null) {
      if (fallback === null) {
        throw new Error(`필수 값이 비어 있습니다: ${id}`);
      }
      return fallback;
    }

    const trimmed = raw.trim();
    if (!trimmed) {
      if (fallback === null) {
        throw new Error(`필수 값이 비어 있습니다: ${id}`);
      }
      return fallback;
    }

    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
      throw new Error(`숫자 형식이 유효하지 않습니다: ${id}`);
    }

    if (parsed < min || parsed > max) {
      throw new Error(`${id}는 ${min}~${max} 사이여야 합니다.`);
    }

    return parsed;
  }

  private parseOptionalNumber(
    id: string,
    fieldName: string,
    options: {
      min: number;
      max?: number;
      integerOnly?: boolean;
    }
  ): number | undefined {
    const raw = this.getValue(id);
    const trimmed = raw.trim();
    if (!trimmed) {
      return undefined;
    }

    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed)) {
      throw new Error(`${fieldName}은(는) 유효한 숫자여야 합니다.`);
    }

    if (parsed < options.min) {
      throw new Error(`${fieldName}은(는) ${options.min} 이상이어야 합니다.`);
    }

    if (options.max !== undefined && parsed > options.max) {
      throw new Error(`${fieldName}은(는) ${options.max} 이하여야 합니다.`);
    }

    if (options.integerOnly !== false && !Number.isInteger(parsed)) {
      throw new Error(`${fieldName}은(는) 정수여야 합니다.`);
    }

    return parsed;
  }

  /**
   * Initialize settings module
   */
  async init(): Promise<void> {
    if (this.initialized) {
      return;
    }
    this.initialized = true;

    await this.loadSettings();
    this.initBackendModelBinding();
    this.initDelegatedEventHandlers();
  }

  initDelegatedEventHandlers(): void {
    if (this.delegatedListenersInitialized) {
      return;
    }
    this.delegatedListenersInitialized = true;

    document.addEventListener('change', (e: Event) => {
      const target = e.target;
      if (!(target instanceof HTMLElement)) {
        return;
      }

      const actionElement = target.closest<HTMLElement>('[data-action]');
      const action = actionElement?.dataset.action;
      if (!action || !actionElement) {
        return;
      }

      if (action === 'agent-toggle') {
        const checkbox = actionElement as HTMLInputElement;
        const agentId = checkbox.dataset.agentId || '';
        if (agentId) {
          void this.toggleAgent(agentId, checkbox.checked);
        }
        return;
      }

      if (action === 'agent-backend') {
        const select = actionElement as HTMLSelectElement;
        const agentId = select.dataset.agentId || '';
        if (agentId) {
          this.onAgentBackendChange(agentId);
        }
        return;
      }

      if (action === 'agent-model') {
        const select = actionElement as HTMLSelectElement;
        const agentId = select.dataset.agentId || '';
        if (agentId) {
          this.onAgentModelChange(agentId);
        }
        return;
      }

      if (action === 'cron-toggle') {
        const checkbox = actionElement as HTMLInputElement;
        const cronId = checkbox.dataset.cronId || '';
        if (cronId) {
          void this.toggleCronJob(cronId, checkbox.checked);
        }
        return;
      }
    });

    document.addEventListener('click', (e: MouseEvent) => {
      const target = e.target;
      if (!(target instanceof HTMLElement)) {
        return;
      }

      // Handle agent-save button click
      const saveButton = target.closest<HTMLElement>('[data-action="agent-save"]');
      if (saveButton) {
        e.preventDefault();
        const agentId = saveButton.dataset.agentId || '';
        if (agentId) {
          void this.saveAgentConfig(agentId);
        }
        return;
      }

      // Handle cron-delete button click
      const deleteButton = target.closest<HTMLElement>('[data-action="cron-delete"]');
      if (deleteButton) {
        e.preventDefault();
        const cronId = deleteButton.dataset.cronId || '';
        if (cronId) {
          void this.deleteCronJob(cronId);
        }
        return;
      }
    });
  }

  /**
   * Load current settings from API
   */
  async loadSettings(): Promise<void> {
    this.setStatus('Loading...');

    try {
      this.config = await API.get<ApiConfigResponse>('/api/config');

      // Load MCP servers data
      try {
        this.mcpServersData = await API.get<McpServersResponse>('/api/mcp-servers');
      } catch (e) {
        logger.warn('MCP servers data unavailable:', e);
        this.mcpServersData = { servers: [] };
      }

      // Load multi-agent data (F3)
      try {
        this.multiAgentData = await API.get<MultiAgentAgentsResponse>('/api/multi-agent/agents');
      } catch (e) {
        logger.warn('Multi-agent data unavailable:', e);
        this.multiAgentData = { agents: [] };
      }

      this.populateForm();
      this.setStatus('');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error('Load error:', message);
      this.setStatus(`Error: ${message}`, 'error');
    }
  }

  /**
   * Populate form with current config values
   */
  populateForm(): void {
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
    const backend = (this.config.agent?.backend || 'claude') as AgentBackend;
    const model = this.config.agent?.model || 'claude-sonnet-4-6';
    const effort = (this.config.agent?.effort || 'medium') as EffortLevel;
    this.setSelectValue('settings-agent-backend', backend);
    this.updateModelOptions(backend, model);
    const normalizedModel = this.getNormalizedModelForBackend(backend, model);
    this.setSelectValue('settings-agent-model', normalizedModel);
    this.setSelectValue('settings-agent-effort', effort);
    this.updateEffortVisibility(normalizedModel);
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
  populateRoles(): void {
    const container = getElementByIdOrNull<HTMLElement>('settings-roles-container');
    if (!container || !this.config.roles) {
      return;
    }

    const { definitions, sourceMapping } = this.config.roles;
    if (!definitions || !sourceMapping) {
      return;
    }

    // Build reverse mapping: role -> sources
    const roleSources: Record<string, string[]> = {};
    for (const [source, role] of Object.entries(sourceMapping)) {
      if (!roleSources[role]) {
        roleSources[role] = [];
      }
      roleSources[role].push(source);
    }

    // Render each role
    const roleColors: Record<string, { badge: string; label: string }> = {
      os_agent: { badge: 'green', label: 'Full Access' },
      chat_bot: { badge: 'yellow', label: 'Limited' },
    };

    const roleIcons: Record<string, string> = {
      os_agent: '🖥️',
      chat_bot: '🤖',
    };

    const roleDefs = definitions as Record<string, ApiRoleDefinition>;
    const html = Object.entries(roleDefs)
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
                ${
                  maxTurns
                    ? `<span class="text-gray-400">| ${escapeHtml(String(maxTurns))} turns</span>`
                    : ''
                }
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
  populateToolMode(): void {
    const tools = this.config.agent?.tools || { gateway: ['*'], mcp: [] };
    const gatewayTools = tools.gateway || ['*'];
    const mcpTools = tools.mcp || [];

    // Set Gateway tool checkboxes
    const gatewayCheckboxes = document.querySelectorAll<HTMLInputElement>('.gateway-tool');
    const isGatewayAll = gatewayTools.includes('*');

    gatewayCheckboxes.forEach((cb) => {
      if (isGatewayAll) {
        cb.checked = true;
      } else {
        cb.checked = gatewayTools.includes(cb.value);
      }
    });

    // Set Select All checkbox
    const gatewaySelectAll = getElementByIdOrNull<HTMLInputElement>('gateway-select-all');
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
  renderMCPServers(selectedTools: string[] = []): void {
    const container = getElementByIdOrNull<HTMLElement>('mcp-tools-list');
    if (!container) {
      return;
    }

    const servers = (this.mcpServersData?.servers || []) as McpServer[];
    const isMCPAll = selectedTools.includes('*');

    if (servers.length === 0) {
      container.innerHTML = `
        <p class="text-xs text-gray-500 col-span-full">
          No MCP servers configured. Add servers to ~/.mama/mama-mcp-config.json
        </p>
      `;
      return;
    }

    const serverColors: Record<string, { border: string; bg: string; icon: string }> = {
      'brave-devtools': { border: 'border-blue-200', bg: 'bg-blue-50', icon: '🌐' },
      'brave-search': { border: 'border-orange-200', bg: 'bg-orange-50', icon: '🔍' },
      mama: { border: 'border-purple-200', bg: 'bg-purple-50', icon: '🧠' },
      default: { border: 'border-gray-200', bg: 'bg-gray-50', icon: '🔌' },
    };

    const html = servers
      .map((server) => {
        const serverName = server.name || '';
        const colors = serverColors[serverName] || serverColors['default'];
        const toolValue = `mcp__${serverName}__*`;
        const isChecked = isMCPAll || selectedTools.includes(toolValue);
        // Escape server.name for safe HTML rendering (XSS prevention)
        const safeName = escapeHtml(serverName);
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
    const mcpSelectAll = getElementByIdOrNull<HTMLInputElement>('mcp-select-all');
    if (mcpSelectAll) {
      mcpSelectAll.checked = isMCPAll || this.allChecked('.mcp-tool');
    }
  }

  /**
   * Check if all checkboxes of a class are checked
   */
  allChecked(selector: string): boolean {
    const checkboxes = document.querySelectorAll<HTMLInputElement>(selector);
    return Array.from(checkboxes).every((cb) => cb.checked);
  }

  /**
   * Toggle all Gateway tools
   */
  toggleAllGateway(checked: boolean): void {
    document.querySelectorAll<HTMLInputElement>('.gateway-tool').forEach((cb) => {
      cb.checked = checked;
    });
    this.updateToolSummary();
  }

  /**
   * Toggle all MCP tools
   */
  toggleAllMCP(checked: boolean): void {
    document.querySelectorAll<HTMLInputElement>('.mcp-tool').forEach((cb) => {
      cb.checked = checked;
    });
    this.updateToolSummary();
  }

  /**
   * Update tool summary display
   */
  updateToolSummary(): void {
    const gatewayCount =
      document.querySelectorAll<HTMLInputElement>('.gateway-tool:checked').length;
    const mcpCount = document.querySelectorAll<HTMLInputElement>('.mcp-tool:checked').length;

    const summaryEl = getElementByIdOrNull<HTMLElement>('tool-summary');
    if (summaryEl) {
      summaryEl.textContent = `Gateway: ${gatewayCount} tools | MCP: ${mcpCount} tools`;
    }
  }

  /**
   * Save settings and restart daemon to apply changes
   */
  async saveAndRestart(): Promise<void> {
    this.setStatus('Saving...');

    try {
      const updates = this.collectFormData();
      await API.put('/api/config', updates);

      this.setStatus('Saved! Restarting...', 'success');
      showToast('Settings saved. Restarting daemon...');

      // Trigger restart after save
      try {
        await API.post('/api/restart', {});
      } catch {
        // Expected: connection drops when server exits
      }

      const isServiceReady = await this.waitForServiceAfterRestart();
      if (!isServiceReady) {
        this.setStatus('Restarted, but reconnect timed out. Please refresh manually.', 'error');
        showToast('Restart request sent. Auto reconnect timed out - please refresh page.');
        return;
      }

      this.setStatus('Reconnected. Reloading page...', 'success');
      setTimeout(() => {
        window.location.reload();
      }, 400);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error('Save error:', message);
      this.setStatus(`Error: ${message}`, 'error');
      showToast(`Failed to save: ${message}`);
    }
  }

  /**
   * Wait for service recovery after restart by polling dashboard status endpoint.
   */
  private async waitForServiceAfterRestart(): Promise<boolean> {
    const maxAttempts = 40;
    const intervalMs = 1000;
    const readinessChecks = ['/api/health', '/api/dashboard/status'];
    // Server waits 500ms + shell sleeps 1s before stopping, so wait at least 2.5s
    // before first poll to ensure old server is actually down
    const initialDelayMs = 2500;

    this.setStatus('Restarting... waiting for shutdown', '');
    await new Promise((resolve) => setTimeout(resolve, initialDelayMs));

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      this.setStatus(`Restarting... reconnecting (${attempt}/${maxAttempts})`, '');

      let isReady = false;
      for (const endpoint of readinessChecks) {
        try {
          // Use shared API client for strict JSON response parsing and consistent errors.
          await API.get(endpoint);
          logger.debug('[Settings] Service ready check passed:', endpoint);
          isReady = true;
          break;
        } catch {
          logger.debug('[Settings] Service not ready yet:', endpoint);
        }
      }

      if (isReady) {
        return true;
      }

      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }

    return false;
  }

  /**
   * Collect form data into config update object
   */
  collectFormData(): SettingsPayload {
    const backend = (this.getSelectValue('settings-agent-backend') || 'claude') as AgentBackend;
    const model = this.getSelectValue('settings-agent-model');
    const effort = (this.getSelectValue('settings-agent-effort') || 'medium') as EffortLevel;
    const useClaudeCli = backend === 'claude';

    // Get token values - if empty and original was masked, keep original
    const discordToken = this.getTokenValue('settings-discord-token', this.config?.discord?.token);
    const slackBotToken = this.getTokenValue(
      'settings-slack-bot-token',
      this.config?.slack?.bot_token
    );
    const slackAppToken = this.getTokenValue(
      'settings-slack-app-token',
      this.config?.slack?.app_token
    );
    const telegramToken = this.getTokenValue(
      'settings-telegram-token',
      this.config?.telegram?.token
    );
    const chatworkToken = this.getTokenValue(
      'settings-chatwork-token',
      this.config?.chatwork?.api_token
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
        interval: this.parseIntegerInput('settings-heartbeat-interval', 1, 1440, 30) * 60000,
        quiet_start: this.parseIntegerInput('settings-heartbeat-quiet-start', 0, 23, 23),
        quiet_end: this.parseIntegerInput('settings-heartbeat-quiet-end', 0, 23, 8),
      },
      use_claude_cli: useClaudeCli,
      agent: {
        backend,
        model: model || (backend === 'codex-mcp' ? 'gpt-5.2-codex' : 'claude-sonnet-4-6'),
        // Effort for Claude 4.6 models (adaptive thinking). 'max' only on Opus.
        effort: model === 'claude-opus-4-6' || model === 'claude-sonnet-4-6' ? effort : undefined,
        max_turns: this.parseIntegerInput('settings-agent-max-turns', 1, 100, 10),
        timeout: this.parseIntegerInput('settings-agent-timeout', 1, 600, 300) * 1000,
        tools: this.collectToolModeData(),
      },
      token_budget: {
        // Keep existing integer constraint for daily limit to avoid partial values.
        daily_limit: this.parseOptionalNumber('settings-token-daily-limit', 'daily_limit', {
          min: 0,
          integerOnly: true,
        }),
        alert_threshold: this.parseOptionalNumber(
          'settings-token-alert-threshold',
          'alert_threshold',
          {
            min: 0,
            max: 100,
            integerOnly: false,
          }
        ),
      },
    };
  }

  initBackendModelBinding(): void {
    if (this.backendListenersInitialized) {
      return;
    }
    this.backendListenersInitialized = true;
    const backendSelect = getElementByIdOrNull<HTMLSelectElement>('settings-agent-backend');
    if (!backendSelect) {
      return;
    }
    backendSelect.addEventListener('change', () => {
      const backend = (this.getSelectValue('settings-agent-backend') || 'claude') as AgentBackend;
      const currentModel = this.getSelectValue('settings-agent-model');
      this.updateModelOptions(backend, currentModel);
      const normalizedModel = this.getNormalizedModelForBackend(backend, currentModel);
      this.setSelectValue('settings-agent-model', normalizedModel);
      this.updateEffortVisibility(normalizedModel);
    });

    // Also listen for model changes to update effort visibility
    const modelSelect = getElementByIdOrNull<HTMLSelectElement>('settings-agent-model');
    if (modelSelect) {
      modelSelect.addEventListener('change', () => {
        const model = this.getSelectValue('settings-agent-model');
        this.updateEffortVisibility(model);
      });
    }
  }

  updateModelOptions(backend: AgentBackend, currentModel: string): void {
    const select = getElementByIdOrNull<HTMLSelectElement>('settings-agent-model');
    if (!select) {
      return;
    }
    const modelList = MODEL_OPTIONS[backend] || MODEL_OPTIONS.claude;
    const normalized = this.getNormalizedModelForBackend(backend, currentModel);
    select.innerHTML = modelList
      .map(
        (m) =>
          `<option value="${escapeHtml(m)}" ${m === normalized ? 'selected' : ''}>${escapeHtml(formatModelName(m))}</option>`
      )
      .join('');

    // Update effort visibility when model options change
    this.updateEffortVisibility(normalized);
  }

  /**
   * Show/hide effort level dropdown based on model selection
   * Effort level only applies to Claude Opus 4.6 which supports adaptive thinking
   */
  updateEffortVisibility(model: string): void {
    const effortContainer = getElementByIdOrNull<HTMLElement>('settings-effort-container');
    if (!effortContainer) {
      return;
    }
    // Show effort for Claude 4.6 models (adaptive thinking)
    const supportsEffort = model === 'claude-opus-4-6' || model === 'claude-sonnet-4-6';
    effortContainer.style.display = supportsEffort ? 'block' : 'none';
  }

  getNormalizedModelForBackend(backend: AgentBackend, model: string): string {
    const isCodexBackend = backend === 'codex-mcp';
    if (!model) {
      return isCodexBackend ? 'gpt-5.2-codex' : 'claude-sonnet-4-6';
    }
    const isClaudeModel = /^claude-/i.test(model);
    if (isCodexBackend && isClaudeModel) {
      return 'gpt-5.2-codex';
    }
    if (backend === 'claude' && !isClaudeModel) {
      return 'claude-sonnet-4-20250514';
    }
    return model;
  }

  /**
   * Collect tool selection data from checkboxes
   */
  collectToolModeData(): SettingsPayloadToolConfig {
    const gatewayTools: string[] = [];
    const mcpTools: string[] = [];

    // Collect selected Gateway tools
    document.querySelectorAll<HTMLInputElement>('.gateway-tool:checked').forEach((cb) => {
      gatewayTools.push(cb.value);
    });

    // Collect selected MCP tools
    document.querySelectorAll<HTMLInputElement>('.mcp-tool:checked').forEach((cb) => {
      mcpTools.push(cb.value);
    });

    // If all Gateway tools are selected, use wildcard
    const allGateway = document.querySelectorAll<HTMLInputElement>('.gateway-tool');
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
  resetForm(): void {
    this.populateForm();
    this.setStatus('Form reset');
    setTimeout(() => this.setStatus(''), 2000);
  }

  /**
   * Helper: Set checkbox value
   */
  setCheckbox(id: string, checked: boolean): void {
    const el = getElementByIdOrNull<HTMLInputElement>(id);
    if (el) {
      el.checked = !!checked;
    }
  }

  /**
   * Helper: Get checkbox value
   */
  getCheckbox(id: string): boolean {
    const el = getElementByIdOrNull<HTMLInputElement>(id);
    return el ? el.checked : false;
  }

  /**
   * Helper: Set input value
   * @param {string} id - Element ID
   * @param {string} value - Value to set
   * @param {boolean} isSensitive - If true, treat as sensitive token (keep if masked)
   */
  setValue(id: string, value: string | number, isSensitive = false): void {
    const el = getElementByIdOrNull<HTMLInputElement>(id);
    if (el) {
      // For sensitive fields (tokens), preserve placeholder if value is masked
      const normalized = String(value ?? '');
      if (isSensitive && this.isMaskedToken(normalized)) {
        el.placeholder = normalized;
        el.value = '';
      } else {
        el.value = normalized;
      }
    }
  }

  /**
   * Check if a token is masked (e.g., "***[redacted]***")
   */
  isMaskedToken(token: string | number | undefined): boolean {
    if (token === undefined || token === null) {
      return false;
    }
    const str = String(token);
    return str === '***[redacted]***' || (str.startsWith('***[') && str.endsWith(']***'));
  }

  /**
   * Get token value from input, preserving original if input is empty and original was masked
   * @param {string} id - Input element ID
   * @param {string} originalToken - Original token value from config
   * @returns {string} Token to send (either new value or original masked token)
   */
  getTokenValue(id: string, originalToken?: string): string {
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
  getValue(id: string): string {
    const el = getElementByIdOrNull<HTMLInputElement>(id);
    return el ? el.value : '';
  }

  /**
   * Helper: Set select value
   */
  setSelectValue(id: string, value: string): void {
    const el = getElementByIdOrNull<HTMLSelectElement>(id);
    if (el) {
      el.value = value;
    }
  }

  /**
   * Helper: Get select value
   */
  getSelectValue(id: string): string {
    const el = getElementByIdOrNull<HTMLSelectElement>(id);
    return el ? el.value : '';
  }

  /**
   * Helper: Set radio button
   */
  setRadio(id: string, checked: boolean): void {
    const el = getElementByIdOrNull<HTMLInputElement>(id);
    if (el) {
      el.checked = !!checked;
    }
  }

  /**
   * Helper: Get radio button value
   */
  getRadio(id: string): boolean {
    const el = getElementByIdOrNull<HTMLInputElement>(id);
    return el ? el.checked : false;
  }

  /**
   * Set status message
   */
  setStatus(message: string, type: SettingsFilterValue = ''): void {
    const statusEl = getElementByIdOrNull<HTMLElement>('settings-status');
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
  populateMultiAgentSection(): void {
    const container = getElementByIdOrNull<HTMLElement>('settings-multi-agent-container');
    if (!container) {
      return;
    }

    const agents = (this.multiAgentData?.agents || []) as MultiAgentAgent[];

    if (agents.length === 0) {
      container.innerHTML = `
        <div class="bg-white border border-gray-200 rounded-lg p-3 text-xs text-gray-500">
          No agents configured. Add agents in <code class="bg-gray-100 px-1 rounded">config.yaml</code>
        </div>
      `;
      return;
    }

    // Tier badge colors
    const tierColors: Record<number, string> = {
      1: 'bg-indigo-100 text-indigo-700',
      2: 'bg-green-100 text-green-700',
      3: 'bg-yellow-100 text-yellow-700',
    };

    const agentCards = agents
      .map((agent: MultiAgentAgent) => {
        const tierColor = tierColors[agent.tier || 1] || tierColors[1];
        const backend =
          ((agent.backend || this.config?.agent?.backend || 'claude') as AgentBackend) || 'claude';
        const normalizedModel = this.getNormalizedModelForBackend(backend, agent.model || '');
        const agentId = agent.id || '';
        const backendOptions = ['codex-mcp', 'claude']
          .map(
            (b) =>
              `<option value="${escapeAttr(b)}" ${backend === b ? 'selected' : ''}>${escapeHtml(b)}</option>`
          )
          .join('');
        const modelOptions = MODEL_OPTIONS[backend] || MODEL_OPTIONS.claude;
        const modelOptionHtml = modelOptions
          .map(
            (m) =>
              `<option value="${escapeAttr(m)}" ${m === normalizedModel ? 'selected' : ''}>${escapeHtml(formatModelName(m))}</option>`
          )
          .join('');

        // Effort level (Claude 4.6 models only)
        const agentEffort = (agent as any).effort || '';
        const supportsAgentEffort =
          normalizedModel === 'claude-opus-4-6' || normalizedModel === 'claude-sonnet-4-6';
        const effortOptions = ['low', 'medium', 'high', 'max']
          .map(
            (e) =>
              `<option value="${e}" ${agentEffort === e ? 'selected' : ''}>${e}${e === 'max' ? ' (Opus)' : ''}</option>`
          )
          .join('');

        // Permission flags
        const canDelegate = agent.can_delegate ?? false;
        const hasAllTools = agent.tool_permissions?.allowed?.includes('*') ?? true;

        return `
          <div class="bg-white border border-gray-200 rounded-lg p-2 shadow-sm hover:shadow-md transition-shadow">
            <!-- Header: Tier + Name + Toggle -->
            <div class="flex items-center justify-between mb-2">
              <div class="flex items-center gap-1.5">
                <span class="${tierColor} text-[10px] font-bold px-1 py-0.5 rounded">T${agent.tier}</span>
                <span class="font-medium text-gray-900 text-xs truncate max-w-[80px]" title="${escapeAttr(agent.display_name || agent.name)}">${escapeHtml(agent.display_name || agent.name)}</span>
              </div>
              <label class="relative inline-flex items-center cursor-pointer">
                <input type="checkbox" class="sr-only peer" data-action="agent-toggle" data-agent-id="${escapeAttr(agentId)}" ${agent.enabled ? 'checked' : ''}>
                <div class="w-7 h-4 bg-gray-200 rounded-full peer peer-checked:after:translate-x-full after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-3 after:w-3 after:transition-all peer-checked:bg-green-500"></div>
              </label>
            </div>

            <!-- Backend + Model Row -->
            <div class="flex gap-1 mb-1">
              <select id="agent-backend-${escapeAttr(agentId)}" data-action="agent-backend" data-agent-id="${escapeAttr(agentId)}" class="flex-1 text-[10px] rounded border border-gray-200 px-1 py-0.5 bg-gray-50">${backendOptions}</select>
              <select id="agent-model-${escapeAttr(agentId)}" data-action="agent-model" data-agent-id="${escapeAttr(agentId)}" class="flex-1 text-[10px] rounded border border-gray-200 px-1 py-0.5 bg-gray-50">${modelOptionHtml}</select>
            </div>
            <!-- Effort Row (Claude 4.6 only) -->
            <div id="agent-effort-container-${escapeAttr(agentId)}" class="mb-2" style="display: ${supportsAgentEffort ? 'block' : 'none'}">
              <select id="agent-effort-${escapeAttr(agentId)}" class="w-full text-[10px] rounded border border-gray-200 px-1 py-0.5 bg-gray-50">${effortOptions}</select>
            </div>

            <!-- Permissions Row -->
            <div class="flex items-center gap-2 mb-2 text-[10px] text-gray-600">
              <label class="flex items-center gap-0.5 cursor-pointer">
                <input type="checkbox" id="agent-delegate-${escapeAttr(agentId)}" class="w-3 h-3 rounded border-gray-300 text-yellow-500 focus:ring-yellow-400" ${canDelegate ? 'checked' : ''}>
                <span>Delegate</span>
              </label>
              <label class="flex items-center gap-0.5 cursor-pointer">
                <input type="checkbox" id="agent-alltools-${escapeAttr(agentId)}" class="w-3 h-3 rounded border-gray-300 text-yellow-500 focus:ring-yellow-400" ${hasAllTools ? 'checked' : ''}>
                <span>All Tools</span>
              </label>
            </div>

            <!-- Save Button -->
            <button type="button" data-action="agent-save" data-agent-id="${escapeAttr(agentId)}" class="w-full text-[10px] px-2 py-1 rounded bg-yellow-400 text-black hover:bg-yellow-300 font-medium">Save</button>
          </div>
        `;
      })
      .join('');

    // Grid layout: 2 cols on mobile, 3 cols on md+
    container.innerHTML = `<div class="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-2">${agentCards}</div>`;
  }

  /**
   * Toggle agent enabled status (F3)
   */
  async toggleAgent(agentId: string, enabled: boolean): Promise<void> {
    try {
      await API.put(`/api/multi-agent/agents/${agentId}`, { enabled });

      logger.info(`Agent ${agentId} ${enabled ? 'enabled' : 'disabled'}`);
    } catch (error) {
      logger.error('Failed to toggle agent:', error);
      // Revert checkbox on error
      const checkbox = document.querySelector<HTMLInputElement>(
        `input[data-action="agent-toggle"][data-agent-id="${agentId}"]`
      );
      if (checkbox) {
        checkbox.checked = !enabled;
      }
      alert(`Failed to update agent: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  onAgentBackendChange(agentId: string): void {
    const backendSelect = getElementByIdOrNull<HTMLSelectElement>(`agent-backend-${agentId}`);
    const modelSelect = getElementByIdOrNull<HTMLSelectElement>(`agent-model-${agentId}`);
    if (!backendSelect || !modelSelect) {
      return;
    }

    const backend = (backendSelect.value || 'claude') as AgentBackend;
    const currentModel = modelSelect.value || '';
    const normalized = this.getNormalizedModelForBackend(backend, currentModel);
    const options = MODEL_OPTIONS[backend] || MODEL_OPTIONS.claude;

    modelSelect.innerHTML = options
      .map(
        (m) =>
          `<option value="${escapeAttr(m)}" ${m === normalized ? 'selected' : ''}>${escapeHtml(formatModelName(m))}</option>`
      )
      .join('');

    // Update effort visibility for this agent card
    const effortContainer = getElementByIdOrNull<HTMLElement>(`agent-effort-container-${agentId}`);
    if (effortContainer) {
      const showEffort = normalized === 'claude-opus-4-6' || normalized === 'claude-sonnet-4-6';
      effortContainer.style.display = showEffort ? 'block' : 'none';
    }
  }

  onAgentModelChange(agentId: string): void {
    const modelSelect = getElementByIdOrNull<HTMLSelectElement>(`agent-model-${agentId}`);
    const effortContainer = getElementByIdOrNull<HTMLElement>(`agent-effort-container-${agentId}`);
    if (!modelSelect || !effortContainer) return;

    const model = modelSelect.value || '';
    const showEffort = model === 'claude-opus-4-6' || model === 'claude-sonnet-4-6';
    effortContainer.style.display = showEffort ? 'block' : 'none';
  }

  async saveAgentConfig(agentId: string): Promise<void> {
    try {
      const backendSelect = getElementByIdOrNull<HTMLSelectElement>(`agent-backend-${agentId}`);
      const modelSelect = getElementByIdOrNull<HTMLSelectElement>(`agent-model-${agentId}`);
      const delegateCheckbox = getElementByIdOrNull<HTMLInputElement>(`agent-delegate-${agentId}`);
      const allToolsCheckbox = getElementByIdOrNull<HTMLInputElement>(`agent-alltools-${agentId}`);

      if (!backendSelect || !modelSelect) {
        throw new Error('Agent settings inputs not found');
      }

      const backend = (backendSelect.value || 'claude') as AgentBackend;
      const model = this.getNormalizedModelForBackend(backend, modelSelect.value || '');
      const can_delegate = delegateCheckbox?.checked ?? false;
      const hasAllTools = allToolsCheckbox?.checked ?? true;

      // Effort level
      const effortSelect = getElementByIdOrNull<HTMLSelectElement>(`agent-effort-${agentId}`);
      const supportsEffort = model === 'claude-opus-4-6' || model === 'claude-sonnet-4-6';
      const effort = supportsEffort && effortSelect ? effortSelect.value : undefined;

      // Build tool_permissions based on checkbox
      const tool_permissions = hasAllTools
        ? { allowed: ['*'], blocked: [] }
        : { allowed: ['Read', 'Grep', 'Glob'], blocked: [] };

      await API.put(`/api/multi-agent/agents/${agentId}`, {
        backend,
        model,
        effort,
        can_delegate,
        tool_permissions,
      });

      showToast(`Saved ${agentId} (applied)`);
      await this.loadSettings();
    } catch (error) {
      logger.error('Failed to save agent config:', error);
      alert(
        `Failed to save agent config: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Populate installed skills section
   */
  async populateSkillsSection(): Promise<void> {
    const container = getElementByIdOrNull<HTMLElement>('settings-skills-container');
    if (!container) {
      return;
    }

    try {
      const { skills } = await API.get<SkillsResponse>('/api/skills');
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
      logger.warn('Skills load error:', error instanceof Error ? error.message : String(error));
      container.innerHTML = '<p class="text-xs text-gray-400">Failed to load skills</p>';
    }
  }

  /**
   * Toggle skill enabled/disabled from settings
   */
  async toggleSkill(source: string, name: string, enabled: boolean): Promise<void> {
    try {
      await API.toggleSkill(name, enabled, source);
    } catch (error) {
      logger.error('Skill toggle failed:', error instanceof Error ? error.message : String(error));
      this.populateSkillsSection();
    }
  }

  /**
   * Populate scheduled jobs section
   */
  async populateCronSection(): Promise<void> {
    const container = getElementByIdOrNull<HTMLElement>('settings-cron-container');
    if (!container) {
      return;
    }

    try {
      const { jobs } = await API.get<CronJobsResponse>('/api/cron');
      if (!jobs || jobs.length === 0) {
        container.innerHTML = '<p class="text-xs text-gray-400">No scheduled jobs</p>';
        return;
      }

      const cronJobs = jobs as CronJob[];
      container.innerHTML = `<div class="space-y-1.5">${cronJobs
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
                <input
                  type="checkbox"
                    ${job.enabled !== false ? 'checked' : ''}
                    data-action="cron-toggle"
                    data-cron-id="${escapeAttr(job.id)}"
                    class="sr-only peer cron-toggle"
                  >
                <div class="w-9 h-5 bg-gray-200 peer-focus:ring-2 peer-focus:ring-yellow-300 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-yellow-400"></div>
              </label>
              <button
                type="button"
                data-action="cron-delete"
                data-cron-id="${escapeAttr(job.id)}"
                class="text-red-400 hover:text-red-600 text-xs px-1"
                title="Delete"
              >
                ✕
              </button>
            </div>
          </div>`;
        })
        .join('')}</div>`;
    } catch (error) {
      logger.warn('Cron load error:', error);
      container.innerHTML = '<p class="text-xs text-gray-400">Failed to load jobs</p>';
    }
  }

  async addCronJob(): Promise<void> {
    const nameInput = getElementByIdOrNull<HTMLInputElement>('settings-cron-name');
    const cronExprInput = getElementByIdOrNull<HTMLInputElement>('settings-cron-expr');
    const promptInput = getElementByIdOrNull<HTMLInputElement>('settings-cron-prompt');
    if (!nameInput || !cronExprInput || !promptInput) {
      return;
    }

    const name = nameInput.value.trim();
    const cronExpr = cronExprInput.value.trim();
    const prompt = promptInput.value.trim();

    if (!name || !cronExpr || !prompt) {
      showToast('Please fill in all fields');
      return;
    }

    try {
      await API.post('/api/cron', { name, cron_expr: cronExpr, prompt });

      nameInput.value = '';
      cronExprInput.value = '';
      promptInput.value = '';
      showToast('Job created');
      this.populateCronSection();
    } catch (error) {
      showToast(`Failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async toggleCronJob(id: string, enabled: boolean): Promise<void> {
    try {
      await API.updateCronJob(id, { enabled });
    } catch (error) {
      logger.error('Cron toggle failed:', error);
      this.populateCronSection();
    }
  }

  async deleteCronJob(id: string): Promise<void> {
    if (!confirm('Delete this scheduled job?')) {
      return;
    }
    try {
      await API.del(`/api/cron/${encodeURIComponent(id)}`);
      showToast('Job deleted');
      this.populateCronSection();
    } catch (error) {
      showToast(`Failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Populate token budget section from config
   */
  populateTokenSection(): void {
    const budget = this.config?.token_budget;
    if (!budget) {
      return;
    }

    this.setValue('settings-token-daily-limit', budget.daily_limit || '');
    this.setValue('settings-token-alert-threshold', budget.alert_threshold || '');
  }
}
