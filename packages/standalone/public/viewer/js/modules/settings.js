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

import { showToast } from '../utils/dom.js';

/**
 * Settings Module Class
 */
export class SettingsModule {
  constructor() {
    this.config = null;
    this.initialized = false;
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
      this.populateForm();
      this.setStatus('');
    } catch (error) {
      console.error('[Settings] Load error:', error);
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
    this.setValue('settings-discord-token', this.config.discord?.token || '');
    this.setValue('settings-discord-channel', this.config.discord?.default_channel_id || '');

    // Slack
    this.setCheckbox('settings-slack-enabled', this.config.slack?.enabled);
    this.setValue('settings-slack-bot-token', this.config.slack?.bot_token || '');
    this.setValue('settings-slack-app-token', this.config.slack?.app_token || '');

    // Telegram
    this.setCheckbox('settings-telegram-enabled', this.config.telegram?.enabled);
    this.setValue('settings-telegram-token', this.config.telegram?.token || '');

    // Chatwork
    this.setCheckbox('settings-chatwork-enabled', this.config.chatwork?.enabled);
    this.setValue('settings-chatwork-token', this.config.chatwork?.api_token || '');

    // Heartbeat
    this.setCheckbox('settings-heartbeat-enabled', this.config.heartbeat?.enabled);
    this.setValue(
      'settings-heartbeat-interval',
      Math.round((this.config.heartbeat?.interval || 1800000) / 60000)
    );
    this.setValue('settings-heartbeat-quiet-start', this.config.heartbeat?.quiet_start ?? 23);
    this.setValue('settings-heartbeat-quiet-end', this.config.heartbeat?.quiet_end ?? 8);

    // Agent
    this.setSelectValue(
      'settings-agent-model',
      this.config.agent?.model || 'claude-sonnet-4-20250514'
    );
    this.setValue('settings-agent-max-turns', this.config.agent?.max_turns || 10);
    this.setValue(
      'settings-agent-timeout',
      Math.round((this.config.agent?.timeout || 300000) / 1000)
    );
  }

  /**
   * Save settings to API
   */
  async saveSettings() {
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

      this.setStatus('Saved!', 'success');
      showToast('Settings saved successfully');

      // Reload to get updated masked values
      setTimeout(() => this.loadSettings(), 1500);
    } catch (error) {
      console.error('[Settings] Save error:', error);
      this.setStatus(`Error: ${error.message}`, 'error');
      showToast(`Failed to save: ${error.message}`);
    }
  }

  /**
   * Collect form data into config update object
   */
  collectFormData() {
    return {
      discord: {
        enabled: this.getCheckbox('settings-discord-enabled'),
        token: this.getValue('settings-discord-token'),
        default_channel_id: this.getValue('settings-discord-channel'),
      },
      slack: {
        enabled: this.getCheckbox('settings-slack-enabled'),
        bot_token: this.getValue('settings-slack-bot-token'),
        app_token: this.getValue('settings-slack-app-token'),
      },
      telegram: {
        enabled: this.getCheckbox('settings-telegram-enabled'),
        token: this.getValue('settings-telegram-token'),
      },
      chatwork: {
        enabled: this.getCheckbox('settings-chatwork-enabled'),
        api_token: this.getValue('settings-chatwork-token'),
      },
      heartbeat: {
        enabled: this.getCheckbox('settings-heartbeat-enabled'),
        interval: parseInt(this.getValue('settings-heartbeat-interval') || '30', 10) * 60000,
        quiet_start: parseInt(this.getValue('settings-heartbeat-quiet-start') || '23', 10),
        quiet_end: parseInt(this.getValue('settings-heartbeat-quiet-end') || '8', 10),
      },
      agent: {
        model: this.getSelectValue('settings-agent-model'),
        max_turns: parseInt(this.getValue('settings-agent-max-turns') || '10', 10),
        timeout: parseInt(this.getValue('settings-agent-timeout') || '300', 10) * 1000,
      },
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
   */
  setValue(id, value) {
    const el = document.getElementById(id);
    if (el) {
      el.value = value;
    }
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
}
