/**
 * Chat Module - Mobile Chat with Voice Input
 * @module modules/chat
 * @version 1.0.0
 *
 * Handles Chat tab functionality including:
 * - WebSocket chat with Claude Code CLI
 * - Voice input (Web Speech API)
 * - Conversation history management
 * - Real-time streaming responses
 */

/* eslint-env browser */

import { escapeHtml, showToast, scrollToBottom, autoResizeTextarea } from '../utils/dom.js';
import { formatMessageTime, formatAssistantMessage } from '../utils/format.js';
import { API } from '../utils/api.js';
import { DebugLogger } from '../utils/debug-logger.js';

const logger = new DebugLogger('Chat');

/**
 * Chat Module Class
 */
export class ChatModule {
  constructor(memoryModule = null) {
    // External dependencies
    this.memoryModule = memoryModule;

    // WebSocket state
    this.ws = null;
    this.sessionId = null;
    this.reconnectAttempts = 0;
    this.maxReconnectDelay = 30000; // 30 seconds

    // Voice input state (STT)
    this.speechRecognition = null;
    this.isRecording = false;
    this.silenceTimeout = null;
    this.silenceDelay = 2500; // 2.5 seconds (increased for continuous mode)
    this.accumulatedTranscript = ''; // Track accumulated final transcripts

    // Voice output state (TTS)
    this.speechSynthesis = window.speechSynthesis;
    this.isSpeaking = false;
    this.ttsEnabled = false; // Auto-play toggle
    this.handsFreeMode = false; // Auto-listen after TTS
    this.ttsVoice = null;
    this.ttsRate = 1.8; // Speech rate (0.5 - 2.0), optimized for Korean
    this.ttsPitch = 1.0; // Speech pitch (0.0 - 2.0)

    // Streaming state
    this.currentStreamEl = null;
    this.currentStreamText = '';
    this.streamBuffer = '';
    this.rafPending = false;

    // History state
    this.history = [];
    this.historyPrefix = 'mama_chat_history_';
    this.maxHistoryMessages = 50;
    this.historyExpiryMs = 24 * 60 * 60 * 1000; // 24 hours

    // Idle auto-checkpoint state
    this.idleTimer = null;
    this.IDLE_TIMEOUT = 5 * 60 * 1000; // 5 minutes
    this.checkpointCooldown = false;
    this.COOLDOWN_MS = 60 * 1000; // 1 minute between checkpoints

    // Initialize
    this.initChatInput();
    this.initLongPressCopy();
    this.initSpeechRecognition();
    this.initSpeechSynthesis();
  }

  // =============================================
  // Idle Auto-Checkpoint
  // =============================================

  resetIdleTimer() {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
    }

    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.idleTimer = setTimeout(() => {
        this.autoCheckpoint();
      }, this.IDLE_TIMEOUT);
    }
  }

  async autoCheckpoint() {
    // DISABLED: Auto-checkpoint was saving raw conversation history to MAMA memory.
    // Checkpoints should only be saved manually via /checkpoint command with proper summaries.
    // The viewer chat uses localStorage for session persistence instead.
    logger.info('Auto-checkpoint disabled (use /checkpoint for manual saves)');
    return;
  }

  // =============================================
  // Session Management
  // =============================================

  /**
   * Initialize chat session
   */
  async initSession() {
    // Check for resumable session first
    await this.checkForResumableSession();

    // Try to get last active server session first
    const lastActiveSession = await API.getLastActiveSession();
    if (lastActiveSession && lastActiveSession.id && lastActiveSession.isAlive) {
      logger.info('Resuming last active session:', lastActiveSession.id);
      this.addSystemMessage('Resuming previous session...');
      localStorage.setItem('mama_chat_session_id', lastActiveSession.id);
      this.initWebSocket(lastActiveSession.id);
      return;
    }

    const savedSessionId = localStorage.getItem('mama_chat_session_id');

    if (savedSessionId) {
      logger.info('Trying saved session:', savedSessionId);
      this.addSystemMessage('Connecting to session...');
      this.initWebSocket(savedSessionId);
    } else {
      try {
        this.addSystemMessage('Creating new session...');
        const data = await API.createSession('.');
        const sessionId = data.sessionId;

        logger.info('Created new session:', sessionId);
        localStorage.setItem('mama_chat_session_id', sessionId);

        this.initWebSocket(sessionId);
      } catch (error) {
        logger.error('Failed to create session:', error);
        this.addSystemMessage(`Failed to create session: ${error.message}`, 'error');
      }
    }
  }

  /**
   * Connect to session (public method)
   */
  connectToSession(sessionId) {
    this.initWebSocket(sessionId);
  }

  /**
   * Disconnect from session (public method)
   */
  disconnect() {
    if (this.ws) {
      this.sessionId = null; // Prevent auto-reconnect
      this.ws.close();
      this.ws = null;
    }
    this.updateStatus('disconnected');
    this.enableInput(false);
  }

  // =============================================
  // WebSocket Management
  // =============================================

  /**
   * Initialize WebSocket connection
   */
  initWebSocket(sessionId) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      logger.info('Already connected');
      return;
    }

    this.sessionId = sessionId;
    this.restoreHistory(sessionId);

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws?sessionId=${sessionId}`;

    logger.info('Connecting to:', wsUrl);
    this.ws = new WebSocket(wsUrl);

    this.ws.onopen = () => {
      logger.info('Connected');
      this.reconnectAttempts = 0;
      this.updateStatus('connected');
      this.enableInput(true);

      this.ws.send(
        JSON.stringify({
          type: 'attach',
          sessionId: sessionId,
          osAgentMode: true, // Enable OS Agent capabilities (Viewer-only)
          language: navigator.language || 'en', // Browser language for greeting
        })
      );
    };

    this.ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        this.handleMessage(data);
      } catch (e) {
        logger.error('Parse error:', e);
      }
    };

    this.ws.onclose = (event) => {
      logger.info('Disconnected:', event.code, event.reason);
      this.updateStatus('disconnected');
      this.enableInput(false);

      if (this.sessionId) {
        this.scheduleReconnect();
      }
    };

    this.ws.onerror = (error) => {
      logger.error('WebSocket error:', error);
      this.updateStatus('disconnected');
    };
  }

  /**
   * Handle incoming WebSocket message
   */
  handleMessage(data) {
    switch (data.type) {
      case 'attached':
        logger.info('Attached to session:', data.sessionId);
        this.addSystemMessage('Connected to session');
        break;

      case 'history':
        // Display conversation history from server
        if (data.messages && data.messages.length > 0) {
          logger.info('Received history:', data.messages.length, 'messages');
          this.displayHistory(data.messages);
        }
        break;

      case 'output':
      case 'stream':
        if (data.content) {
          this.hideTypingIndicator();
          this.enableSend(true);
          this.appendStreamChunk(data.content);
        }
        break;

      case 'stream_end':
        this.hideTypingIndicator();
        this.finalizeStreamMessage();
        break;

      case 'error':
        if (data.error === 'session_not_found') {
          logger.info('Session not found, creating new one...');
          localStorage.removeItem('mama_chat_session_id');
          this.addSystemMessage('Session expired. Creating new session...');

          if (this.ws) {
            this.ws.close();
            this.ws = null;
          }

          setTimeout(() => this.initSession(), 500);
        } else {
          this.addSystemMessage(`Error: ${data.message || data.error}`, 'error');
          this.enableSend(true);
        }
        break;

      case 'tool_use':
        this.addToolCard(data.tool, data.toolId, data.input);
        break;

      case 'tool_complete':
        this.completeToolCard(data.index);
        break;

      case 'typing':
        this.showTypingIndicator(data.elapsed);
        break;

      case 'pong':
        break;

      case 'connected':
        logger.info('WebSocket connected:', data.clientId);
        break;

      default:
        logger.warn('Unknown message type:', data.type);
    }
  }

  /**
   * Schedule reconnection with exponential backoff
   */
  scheduleReconnect() {
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), this.maxReconnectDelay);
    this.reconnectAttempts++;

    logger.info(`Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);
    this.addSystemMessage(
      `Connection lost. Reconnecting in ${Math.round(delay / 1000)}s...`,
      'warning'
    );

    setTimeout(() => {
      if (this.sessionId) {
        this.initWebSocket(this.sessionId);
      }
    }, delay);
  }

  // =============================================
  // Message Handling
  // =============================================

  /**
   * Send chat message
   */
  send() {
    const input = document.getElementById('chat-input');
    const message = input.value.trim();

    if (!message) {
      return;
    }

    // Handle slash commands
    if (message.startsWith('/')) {
      this.handleCommand(message);
      input.value = '';
      autoResizeTextarea(input);
      return;
    }

    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.addSystemMessage('Not connected. Please connect to a session first.', 'error');
      return;
    }

    this.addUserMessage(message);
    this.enableSend(false);

    this.ws.send(
      JSON.stringify({
        type: 'send',
        sessionId: this.sessionId,
        content: message,
      })
    );

    // Search for related MAMA decisions
    if (this.memoryModule) {
      this.memoryModule.showRelatedForMessage(message);
    }

    input.value = '';
    autoResizeTextarea(input);

    logger.info('Sent:', message);
    this.resetIdleTimer();
  }

  /**
   * Send quiz choice (A, B, C, D)
   * Called from quiz-choice-btn onclick
   */
  sendQuizChoice(choice) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.addSystemMessage('Not connected.', 'error');
      return;
    }

    // Display choice as user message
    this.addUserMessage(choice);
    this.enableSend(false);

    // Send to server
    this.ws.send(
      JSON.stringify({
        type: 'send',
        sessionId: this.sessionId,
        content: choice,
      })
    );

    logger.info('Quiz choice sent:', choice);
    this.resetIdleTimer();
  }

  /**
   * Handle slash commands
   */
  handleCommand(message) {
    const parts = message.slice(1).split(' ');
    const command = parts[0].toLowerCase();
    const args = parts.slice(1).join(' ');

    logger.info('Command:', command, 'Args:', args);

    switch (command) {
      case 'save':
        this.commandSave(args);
        break;
      case 'search':
        this.commandSearch(args);
        break;
      case 'checkpoint':
        this.commandCheckpoint();
        break;
      case 'resume':
        this.commandResume();
        break;
      case 'help':
        this.commandHelp();
        break;
      default:
        // Forward unrecognized commands to agent as regular messages
        this.sendRaw(message);
    }
  }

  /**
   * Send a message directly to the agent (bypass command parsing)
   * Rewrites /command to avoid Claude CLI slash command interception
   */
  sendRaw(message) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.addSystemMessage('Not connected. Please connect to a session first.', 'error');
      return;
    }

    this.addUserMessage(message);
    this.enableSend(false);

    // Rewrite /command → natural language to avoid Claude CLI interception
    // Must be explicit enough to override built-in skills (BMAD, etc.)
    let agentMessage = message;
    if (message.startsWith('/')) {
      const parts = message.slice(1).split(' ');
      const cmd = parts[0];
      const args = parts.slice(1).join(' ');
      agentMessage = [
        `[INSTALLED PLUGIN COMMAND — DO NOT USE SKILL TOOL]`,
        `Look in your system prompt under "Installed Skills (PRIORITY)" for the "commands/${cmd}.md" section.`,
        `Execute ONLY the instructions from that installed plugin command file.`,
        `DO NOT invoke the Skill tool. DO NOT match to bmad or any other built-in skill.`,
        `This command comes from a user-installed Cowork/OpenClaw plugin, not a system skill.`,
        args ? `User arguments: <user_args>${args}</user_args>` : '',
      ]
        .filter(Boolean)
        .join(' ');
    }

    this.ws.send(
      JSON.stringify({
        type: 'send',
        sessionId: this.sessionId,
        content: agentMessage,
      })
    );

    if (this.memoryModule) {
      this.memoryModule.showRelatedForMessage(message);
    }

    logger.info('Forwarded to agent:', agentMessage);
    this.resetIdleTimer();
  }

  /**
   * /save <text> - Open Memory form with text
   */
  commandSave(text) {
    if (!this.memoryModule) {
      this.addSystemMessage('Memory module not available', 'error');
      return;
    }

    if (!text) {
      this.addSystemMessage('Usage: /save <decision text>', 'error');
      return;
    }

    // Switch to Memory tab and open form with text
    window.switchTab('memory');
    this.memoryModule.showSaveFormWithText(text);
    this.addSystemMessage(`💾 Opening save form with: "${text.substring(0, 50)}..."`);
  }

  /**
   * /search <query> - Search in Memory tab
   */
  commandSearch(query) {
    if (!this.memoryModule) {
      this.addSystemMessage('Memory module not available', 'error');
      return;
    }

    if (!query) {
      this.addSystemMessage('Usage: /search <query>', 'error');
      return;
    }

    // Switch to Memory tab and execute search
    window.switchTab('memory');
    this.memoryModule.searchWithQuery(query);
    this.addSystemMessage(`🔍 Searching for: "${query}"`);
  }

  /**
   * /checkpoint - Save current session as checkpoint
   */
  async commandCheckpoint() {
    try {
      const summary = this.generateCheckpointSummary();
      await this.saveCheckpoint(summary);
      this.addSystemMessage('✅ Checkpoint saved successfully');
    } catch (error) {
      logger.error('Checkpoint save failed:', error);
      this.addSystemMessage(`Failed to save checkpoint: ${error.message}`, 'error');
    }
  }

  /**
   * /resume - Load last checkpoint
   */
  async commandResume() {
    try {
      const checkpoint = await this.loadCheckpoint();
      if (checkpoint) {
        this.addSystemMessage(
          `📖 Last checkpoint (${new Date(checkpoint.timestamp).toLocaleString()}):`
        );
        this.addSystemMessage(checkpoint.summary);
      } else {
        this.addSystemMessage('No checkpoint found', 'error');
      }
    } catch (error) {
      logger.error('Checkpoint load failed:', error);
      this.addSystemMessage(`Failed to load checkpoint: ${error.message}`, 'error');
    }
  }

  /**
   * /help - Show available commands
   */
  commandHelp() {
    const helpText = `
**Available Commands:**

**/save <text>** - Save a decision to Memory
**/search <query>** - Search decisions in Memory
**/checkpoint** - Save current session
**/resume** - Load last checkpoint
**/help** - Show this help message

**Keyboard Shortcuts:**
- **Enter** - Send message
- **Shift+Enter** - New line
- **Long press message** - Copy to clipboard
    `.trim();

    this.addSystemMessage(helpText);
  }

  /**
   * Add user message to chat
   */
  addUserMessage(text) {
    const container = document.getElementById('chat-messages');
    this.removePlaceholder();

    const timestamp = new Date();
    const msgEl = document.createElement('div');
    msgEl.className = 'chat-message user';
    msgEl.innerHTML = `
      <div class="message-content">${escapeHtml(text)}</div>
      <div class="message-time">${formatMessageTime(timestamp)}</div>
    `;

    container.appendChild(msgEl);
    scrollToBottom(container);

    this.saveToHistory('user', text, timestamp);
  }

  addUserMessageWithAttachment(text, attachment) {
    const container = document.getElementById('chat-messages');
    this.removePlaceholder();

    const timestamp = new Date();
    const msgEl = document.createElement('div');
    msgEl.className = 'chat-message user';

    let attachHtml = '';
    if (attachment.isImage) {
      const safeUrl = escapeHtml(attachment.mediaUrl);
      attachHtml = `<img src="${safeUrl}" class="max-w-[200px] rounded-lg mt-1 cursor-pointer" alt="${escapeHtml(attachment.originalName)}" onclick="event.stopPropagation();openLightbox('${safeUrl}')" />`;
    } else {
      const safeName = encodeURIComponent(attachment.filename);
      attachHtml = `<a href="/api/media/download/${safeName}" target="_blank" class="flex items-center gap-2 mt-1 px-3 py-2 bg-white/50 rounded-lg border border-gray-200 text-sm hover:bg-white/80 transition-colors"><span class="text-lg">${attachment.isImage ? '' : '\u{1F4CE}'}</span><span class="truncate max-w-[180px]">${escapeHtml(attachment.originalName)}</span></a>`;
    }

    msgEl.innerHTML = `
      <div class="message-content">${escapeHtml(text)}${attachHtml}</div>
      <div class="message-time">${formatMessageTime(timestamp)}</div>
    `;

    container.appendChild(msgEl);
    scrollToBottom(container);

    this.saveToHistory('user', text, timestamp, attachment);
  }

  /**
   * Add assistant message to chat
   */
  addAssistantMessage(text) {
    const container = document.getElementById('chat-messages');
    this.removePlaceholder();

    this.enableSend(true);

    const timestamp = new Date();
    const msgEl = document.createElement('div');
    msgEl.className = 'chat-message assistant';
    msgEl.innerHTML = `
      <div class="message-content">${formatAssistantMessage(text)}</div>
      <div class="message-time">${formatMessageTime(timestamp)}</div>
    `;

    container.appendChild(msgEl);
    scrollToBottom(container);

    this.saveToHistory('assistant', text, timestamp);

    // Show unread badge if floating panel is closed
    this.showUnreadBadge();

    // Auto-play TTS if enabled
    if (this.ttsEnabled && text) {
      logger.info('Auto-play enabled, speaking assistant message');
      this.speak(text);
    }
  }

  /**
   * Add system message to chat
   */
  addSystemMessage(text, type = 'info') {
    const container = document.getElementById('chat-messages');
    this.removePlaceholder();

    const msgEl = document.createElement('div');
    msgEl.className = `chat-message system ${type}`;
    msgEl.innerHTML = `
      <div class="message-content">${escapeHtml(text)}</div>
    `;

    container.appendChild(msgEl);
    scrollToBottom(container);
  }

  /**
   * Add tool usage card
   */
  addToolCard(toolName, toolId, input) {
    const container = document.getElementById('chat-messages');
    this.removePlaceholder();

    // Tool icon mapping
    const iconMap = {
      Read: '📄',
      Write: '✏️',
      Bash: '💻',
      Edit: '🔧',
      Grep: '🔍',
      Glob: '📂',
      Task: '🤖',
      WebFetch: '🌐',
      WebSearch: '🔎',
    };
    const icon = iconMap[toolName] || '🔧';

    // Extract file path for Read tool
    let detail = '';
    if (toolName === 'Read' && input && input.file_path) {
      const fileName = input.file_path.split('/').pop();
      detail = `<div class="tool-detail">${escapeHtml(fileName)}</div>`;
    } else if (toolName === 'Bash' && input && input.command) {
      detail = `<div class="tool-detail">${escapeHtml(input.command.substring(0, 50))}${input.command.length > 50 ? '...' : ''}</div>`;
    }

    const cardEl = document.createElement('div');
    cardEl.className = 'tool-card loading';
    cardEl.dataset.toolId = toolId;
    cardEl.dataset.collapsed = 'true';
    cardEl.innerHTML = `
      <div class="tool-header" onclick="window.chatModule.toggleToolCard('${toolId}')">
        <span class="tool-icon">${icon}</span>
        <span class="tool-name">${escapeHtml(toolName)}</span>
        <span class="tool-spinner">⏳</span>
      </div>
      ${detail}
    `;

    container.appendChild(cardEl);
    scrollToBottom(container);
  }

  /**
   * Complete tool card (mark as finished)
   */
  completeToolCard(_index) {
    // Find the most recent loading tool card
    const loadingCards = document.querySelectorAll('.tool-card.loading');
    if (loadingCards.length > 0) {
      const lastCard = loadingCards[loadingCards.length - 1];
      lastCard.classList.remove('loading');
      lastCard.classList.add('completed');

      // Replace spinner with checkmark
      const spinner = lastCard.querySelector('.tool-spinner');
      if (spinner) {
        spinner.textContent = '✓';
        spinner.classList.add('checkmark');
      }
    }
  }

  /**
   * Toggle tool card collapsed/expanded state
   */
  toggleToolCard(toolId) {
    const card = document.querySelector(`.tool-card[data-tool-id="${toolId}"]`);
    if (card) {
      const isCollapsed = card.dataset.collapsed === 'true';
      card.dataset.collapsed = isCollapsed ? 'false' : 'true';
      // Future: expand to show detailed results
    }
  }

  /**
   * Remove placeholder
   */
  removePlaceholder() {
    const placeholder = document.querySelector('.chat-placeholder');
    if (placeholder) {
      placeholder.remove();
    }
  }

  // =============================================
  // Streaming Message Handling
  // =============================================

  /**
   * Append streaming chunk with RAF batching
   */
  appendStreamChunk(content) {
    const container = document.getElementById('chat-messages');

    if (!this.currentStreamEl) {
      this.removePlaceholder();
      this.currentStreamEl = document.createElement('div');
      this.currentStreamEl.className = 'chat-message assistant streaming';
      this.currentStreamEl.innerHTML = `
        <div class="message-content"></div>
        <div class="message-time">${formatMessageTime(new Date())}</div>
      `;
      container.appendChild(this.currentStreamEl);
      this.currentStreamText = '';
      this.streamBuffer = '';
    }

    this.streamBuffer += content;

    if (!this.rafPending) {
      this.rafPending = true;
      requestAnimationFrame(() => {
        if (this.streamBuffer) {
          this.currentStreamText += this.streamBuffer;
          this.streamBuffer = '';

          const contentEl = this.currentStreamEl.querySelector('.message-content');
          contentEl.innerHTML = formatAssistantMessage(this.currentStreamText);

          container.scrollTo({
            top: container.scrollHeight,
            behavior: 'auto',
          });
        }
        this.rafPending = false;
      });
    }
  }

  /**
   * Finalize streaming message
   */
  finalizeStreamMessage() {
    if (this.streamBuffer && this.currentStreamEl) {
      this.currentStreamText += this.streamBuffer;
      const contentEl = this.currentStreamEl.querySelector('.message-content');
      contentEl.innerHTML = formatAssistantMessage(this.currentStreamText);
    }

    if (this.currentStreamText) {
      this.saveToHistory('assistant', this.currentStreamText);

      // Auto-play TTS for streamed responses
      if (this.ttsEnabled) {
        this.speak(this.currentStreamText);
      }
    }

    // Show unread badge if floating panel is closed
    this.showUnreadBadge();

    if (this.currentStreamEl) {
      this.currentStreamEl.classList.remove('streaming');
      this.currentStreamEl = null;
      this.currentStreamText = '';
      this.streamBuffer = '';
    }
    this.rafPending = false;
    this.enableSend(true);
  }

  /**
   * Show typing indicator while agent is processing
   */
  showTypingIndicator(elapsed) {
    const container = document.getElementById('chat-messages');
    let indicator = container.querySelector('.chat-typing-indicator');
    if (!indicator) {
      indicator = document.createElement('div');
      indicator.className = 'chat-typing-indicator';
      indicator.innerHTML = `
        <div class="typing-dots">
          <span></span><span></span><span></span>
        </div>
        <span class="typing-label">thinking...</span>`;
      container.appendChild(indicator);
      scrollToBottom(container);
    }
    if (elapsed) {
      const label = indicator.querySelector('.typing-label');
      label.textContent = `thinking... (${elapsed}s)`;
    }
  }

  /**
   * Hide typing indicator
   */
  hideTypingIndicator() {
    const container = document.getElementById('chat-messages');
    const indicator = container?.querySelector('.chat-typing-indicator');
    if (indicator) {
      indicator.remove();
    }
  }

  // =============================================
  // UI Control
  // =============================================

  /**
   * Update chat status
   */
  updateStatus(status) {
    const statusEl = document.getElementById('chat-status');
    if (!statusEl) {
      logger.warn('Status element not found');
      return;
    }

    const indicator = statusEl.querySelector('.status-indicator');
    const text = statusEl.querySelector('span:not(.status-indicator)');

    if (!indicator || !text) {
      logger.warn('Status indicator or text not found');
      return;
    }

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

  /**
   * Enable/disable chat input
   */
  enableInput(enabled) {
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

  /**
   * Enable/disable send button
   */
  enableSend(enabled) {
    const sendBtn = document.getElementById('chat-send');
    sendBtn.disabled = !enabled;

    if (enabled) {
      sendBtn.textContent = 'Send';
      sendBtn.classList.remove('loading');
    } else {
      sendBtn.textContent = 'Sending...';
      sendBtn.classList.add('loading');
    }
  }

  /**
   * Enable/disable mic button
   */
  enableMic(enabled) {
    const micBtn = document.getElementById('chat-mic');
    if (micBtn) {
      micBtn.disabled = !enabled;
    }
  }

  // =============================================
  // Input Handlers
  // =============================================

  /**
   * Handle chat input keydown
   */
  handleInputKeydown(event) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      this.send();
    }
  }

  /**
   * Initialize chat input handlers
   */
  initChatInput() {
    const input = document.getElementById('chat-input');

    input.addEventListener('input', () => {
      autoResizeTextarea(input);
    });

    input.addEventListener('keydown', (event) => {
      this.handleInputKeydown(event);
    });
  }

  /**
   * Initialize long press to copy message functionality
   * Supports both touch (mobile) and mouse (desktop) events
   */
  initLongPressCopy() {
    const messagesContainer = document.getElementById('chat-messages');
    let pressTimer = null;
    const PRESS_DURATION = 750; // milliseconds

    // Touch events (mobile)
    messagesContainer.addEventListener('touchstart', (e) => {
      const message = e.target.closest('.message');
      if (!message || message.classList.contains('system')) {
        return;
      }

      pressTimer = setTimeout(() => {
        copyMessageText(message);
      }, PRESS_DURATION);
    });

    messagesContainer.addEventListener('touchend', () => {
      if (pressTimer) {
        clearTimeout(pressTimer);
        pressTimer = null;
      }
    });

    messagesContainer.addEventListener('touchmove', () => {
      if (pressTimer) {
        clearTimeout(pressTimer);
        pressTimer = null;
      }
    });

    // Mouse events (desktop)
    messagesContainer.addEventListener('mousedown', (e) => {
      const message = e.target.closest('.message');
      if (!message || message.classList.contains('system')) {
        return;
      }

      pressTimer = setTimeout(() => {
        copyMessageText(message);
      }, PRESS_DURATION);
    });

    messagesContainer.addEventListener('mouseup', () => {
      if (pressTimer) {
        clearTimeout(pressTimer);
        pressTimer = null;
      }
    });

    messagesContainer.addEventListener('mouseleave', () => {
      if (pressTimer) {
        clearTimeout(pressTimer);
        pressTimer = null;
      }
    });

    /**
     * Copy message text to clipboard
     */
    async function copyMessageText(messageEl) {
      const textContent = messageEl.querySelector('.message-text');
      if (!textContent) {
        return;
      }

      const text = textContent.textContent;

      try {
        await navigator.clipboard.writeText(text);
        showToast('📋 Copied to clipboard');

        // Visual feedback
        messageEl.style.opacity = '0.5';
        setTimeout(() => {
          messageEl.style.opacity = '1';
        }, 300);
      } catch (err) {
        logger.error('Copy failed:', err);
        showToast('Failed to copy', 'error');
      }
    }
  }

  // =============================================
  // Voice Input (Web Speech API)
  // =============================================

  /**
   * Initialize speech recognition
   */
  initSpeechRecognition() {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

    if (!SpeechRecognition) {
      logger.warn('SpeechRecognition not supported');
      const micBtn = document.getElementById('chat-mic');
      if (micBtn) {
        micBtn.style.display = 'none';
      }
      return;
    }

    this.speechRecognition = new SpeechRecognition();
    this.speechRecognition.lang = navigator.language || 'ko-KR';
    this.speechRecognition.continuous = true; // Enable continuous recognition for longer phrases
    this.speechRecognition.interimResults = true;
    this.speechRecognition.maxAlternatives = 3; // Get multiple recognition candidates for better accuracy

    this.speechRecognition.onresult = (event) => {
      const input = document.getElementById('chat-input');
      let interimTranscript = '';
      let finalTranscript = '';

      // Build transcript from NEW results only (use resultIndex)
      logger.debug(
        'onresult fired, resultIndex:',
        event.resultIndex,
        'total results:',
        event.results.length
      );

      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        const transcript = result[0].transcript;

        if (result.isFinal) {
          finalTranscript += transcript;
          logger.debug(
            'Final result [' + i + ']:',
            transcript,
            'Confidence:',
            result[0].confidence
          );
        } else {
          interimTranscript += transcript;
          logger.debug('Interim result [' + i + ']:', transcript);
        }
      }

      // Handle final transcripts - accumulate them
      if (finalTranscript) {
        // Add space before appending if there's already text
        if (this.accumulatedTranscript) {
          this.accumulatedTranscript += ' ' + finalTranscript;
        } else {
          this.accumulatedTranscript = finalTranscript;
        }
        input.value = this.accumulatedTranscript;
        input.classList.remove('voice-active');
        logger.debug('Accumulated transcript:', this.accumulatedTranscript);
      }

      // Handle interim transcripts - show temporarily with accumulated text
      if (interimTranscript) {
        const displayText = this.accumulatedTranscript
          ? this.accumulatedTranscript + ' ' + interimTranscript
          : interimTranscript;
        input.value = displayText;
        input.classList.add('voice-active');
        logger.debug('Showing interim (temp):', displayText);
      }

      autoResizeTextarea(input);

      // Reset silence timer on each result
      clearTimeout(this.silenceTimeout);
      this.silenceTimeout = setTimeout(() => {
        if (this.isRecording) {
          logger.info('Silence detected, stopping...');
          this.stopVoice();
        }
      }, this.silenceDelay);
    };

    this.speechRecognition.onend = () => {
      logger.info('Recognition ended');
      this.stopVoice();
    };

    this.speechRecognition.onerror = (event) => {
      logger.error('Error:', event.error);
      this.stopVoice();

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

      this.addSystemMessage(errorMessage, 'error');
    };

    logger.info('SpeechRecognition initialized (lang:', this.speechRecognition.lang + ')');
  }

  /**
   * Toggle voice input
   */
  toggleVoice() {
    if (this.isRecording) {
      this.stopVoice();
    } else {
      this.startVoice();
    }
  }

  /**
   * Start voice recording
   */
  startVoice() {
    if (!this.speechRecognition) {
      this.addSystemMessage('이 브라우저에서는 음성 인식이 지원되지 않습니다.', 'error');
      return;
    }

    try {
      const micBtn = document.getElementById('chat-mic');
      const input = document.getElementById('chat-input');

      // Clear input and accumulated transcript for new recording
      input.value = '';
      this.accumulatedTranscript = '';

      this.speechRecognition.start();
      this.isRecording = true;

      micBtn.classList.add('recording');
      input.classList.add('voice-active');
      input.placeholder = '말씀해주세요... (계속 말하면 이어서 인식됩니다)';

      logger.info('Recording started (continuous mode)');
      logger.debug('Settings:', {
        lang: this.speechRecognition.lang,
        continuous: this.speechRecognition.continuous,
        interimResults: this.speechRecognition.interimResults,
        maxAlternatives: this.speechRecognition.maxAlternatives,
      });

      this.silenceTimeout = setTimeout(() => {
        if (this.isRecording) {
          this.stopVoice();
        }
      }, this.silenceDelay);
    } catch (err) {
      logger.error('Failed to start:', err);
      this.addSystemMessage('음성 인식을 시작할 수 없습니다.', 'error');
    }
  }

  /**
   * Stop voice recording
   */
  stopVoice() {
    if (!this.isRecording) {
      return;
    }

    clearTimeout(this.silenceTimeout);

    try {
      this.speechRecognition.stop();
    } catch (e) {
      // Ignore errors
    }

    this.isRecording = false;

    const micBtn = document.getElementById('chat-mic');
    const input = document.getElementById('chat-input');

    micBtn.classList.remove('recording');
    input.classList.remove('voice-active');
    input.placeholder = 'Type your message...';

    logger.info('Recording stopped');
    this.resetIdleTimer();
  }

  // =============================================
  // Text-to-Speech (TTS)
  // =============================================

  /**
   * Initialize Speech Synthesis
   */
  initSpeechSynthesis() {
    if (!this.speechSynthesis) {
      logger.warn('SpeechSynthesis not supported');
      return;
    }

    // Wait for voices to load
    const loadVoices = () => {
      const voices = this.speechSynthesis.getVoices();
      // Find Korean voice
      this.ttsVoice =
        voices.find((v) => v.lang === 'ko-KR') ||
        voices.find((v) => v.lang.startsWith('ko')) ||
        voices[0];

      if (this.ttsVoice) {
        logger.info('Korean voice selected:', this.ttsVoice.name, this.ttsVoice.lang);
      } else {
        logger.warn('No Korean voice found, using default');
      }
    };

    // Voices might not be loaded immediately
    if (this.speechSynthesis.getVoices().length > 0) {
      loadVoices();
    } else {
      this.speechSynthesis.onvoiceschanged = loadVoices;
    }

    logger.info('SpeechSynthesis initialized');
  }

  /**
   * Toggle TTS auto-play
   */
  toggleTTS() {
    this.ttsEnabled = !this.ttsEnabled;
    const btn = document.getElementById('chat-tts-toggle');

    if (btn) {
      btn.classList.toggle('active', this.ttsEnabled);
      btn.title = this.ttsEnabled
        ? 'TTS 활성화됨 (클릭하여 끄기)'
        : 'TTS 비활성화됨 (클릭하여 켜기)';
    }

    logger.info('Auto-play:', this.ttsEnabled ? 'ON' : 'OFF');
    showToast(this.ttsEnabled ? '🔊 TTS 활성화' : '🔇 TTS 비활성화');
  }

  /**
   * Toggle hands-free mode
   */
  toggleHandsFree() {
    this.handsFreeMode = !this.handsFreeMode;
    const btn = document.getElementById('chat-handsfree-toggle');

    if (btn) {
      btn.classList.toggle('active', this.handsFreeMode);
      btn.title = this.handsFreeMode ? '핸즈프리 활성화됨' : '핸즈프리 비활성화됨';
    }

    logger.info('Hands-free mode:', this.handsFreeMode ? 'ON' : 'OFF');
    showToast(this.handsFreeMode ? '🎙️ 핸즈프리 모드 활성화' : '🎙️ 핸즈프리 모드 비활성화');

    // Enable TTS automatically when hands-free is enabled
    if (this.handsFreeMode && !this.ttsEnabled) {
      this.toggleTTS();
    }
  }

  /**
   * Speak text using TTS
   */
  speak(text) {
    if (!this.speechSynthesis || !text) {
      return;
    }

    // Stop any ongoing speech
    this.stopSpeaking();

    const utterance = new SpeechSynthesisUtterance(text);
    utterance.voice = this.ttsVoice;
    utterance.rate = this.ttsRate;
    utterance.pitch = this.ttsPitch;
    utterance.lang = this.ttsVoice?.lang || navigator.language || 'ko-KR';

    utterance.onstart = () => {
      this.isSpeaking = true;
      logger.debug('Speaking started');
    };

    utterance.onend = () => {
      this.isSpeaking = false;
      logger.debug('Speaking ended');

      // If hands-free mode, start listening after TTS finishes
      if (this.handsFreeMode && !this.isRecording) {
        logger.info('Hands-free mode: auto-starting voice input');
        setTimeout(() => {
          this.startVoice();
        }, 500); // Small delay for smooth transition
      }
    };

    utterance.onerror = (event) => {
      this.isSpeaking = false;
      logger.error('Error:', event.error);
    };

    this.speechSynthesis.speak(utterance);
    logger.debug('Speaking:', text.substring(0, 50) + '...');
  }

  /**
   * Stop speaking
   */
  stopSpeaking() {
    if (this.speechSynthesis && this.isSpeaking) {
      this.speechSynthesis.cancel();
      this.isSpeaking = false;
      logger.debug('Speaking stopped');
    }
  }

  /**
   * Set TTS rate (0.5 - 2.0)
   */
  setTTSRate(rate) {
    this.ttsRate = Math.max(0.5, Math.min(2.0, rate));
    logger.info('Rate set to:', this.ttsRate);
  }

  // =============================================
  // History Management
  // =============================================

  /**
   * Save message to history
   */
  saveToHistory(role, content, timestamp = new Date(), attachment = null) {
    if (!this.sessionId) {
      return;
    }

    const entry = {
      role,
      content,
      timestamp: timestamp.toISOString(),
    };
    if (attachment) {
      entry.attachment = attachment;
    }

    this.history.push(entry);

    if (this.history.length > this.maxHistoryMessages) {
      this.history = this.history.slice(-this.maxHistoryMessages);
    }

    try {
      const storageKey = this.historyPrefix + this.sessionId;
      const storageData = {
        history: this.history,
        savedAt: Date.now(),
      };
      localStorage.setItem(storageKey, JSON.stringify(storageData));
    } catch (e) {
      logger.warn('Failed to save history:', e);
    }
  }

  /**
   * Load history from localStorage
   */
  loadHistory(sessionId) {
    try {
      const storageKey = this.historyPrefix + sessionId;
      const stored = localStorage.getItem(storageKey);

      if (!stored) {
        return null;
      }

      const data = JSON.parse(stored);

      if (Date.now() - data.savedAt > this.historyExpiryMs) {
        localStorage.removeItem(storageKey);
        return null;
      }

      return data.history || [];
    } catch (e) {
      logger.warn('Failed to load history:', e);
      return null;
    }
  }

  /**
   * Restore chat history
   */
  restoreHistory(sessionId) {
    const history = this.loadHistory(sessionId);

    if (!history || history.length === 0) {
      return false;
    }

    this.history = history;
    const container = document.getElementById('chat-messages');

    this.removePlaceholder();

    history.forEach((msg) => {
      const msgEl = document.createElement('div');
      msgEl.className = `chat-message ${msg.role}`;

      if (msg.role === 'user') {
        let attachHtml = '';
        if (msg.attachment) {
          const att = msg.attachment;
          if (att.isImage) {
            const safeUrl = escapeHtml(att.mediaUrl);
            attachHtml = `<img src="${safeUrl}" class="max-w-[200px] rounded-lg mt-1 cursor-pointer" alt="${escapeHtml(att.originalName || '')}" onclick="event.stopPropagation();openLightbox('${safeUrl}')" />`;
          } else {
            const safeName = encodeURIComponent(att.filename);
            attachHtml = `<a href="/api/media/download/${safeName}" target="_blank" class="flex items-center gap-2 mt-1 px-3 py-2 bg-white/50 rounded-lg border border-gray-200 text-sm hover:bg-white/80 transition-colors"><span class="text-lg">\u{1F4CE}</span><span class="truncate max-w-[180px]">${escapeHtml(att.originalName || att.filename)}</span></a>`;
          }
        }
        msgEl.innerHTML = `
          <div class="message-content">${escapeHtml(msg.content)}${attachHtml}</div>
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

    scrollToBottom(container);
    showToast('Previous conversation restored');

    return true;
  }

  /**
   * Display history received from server
   */
  displayHistory(messages) {
    const container = document.getElementById('chat-messages');
    if (!container) {
      return;
    }

    // If localStorage history already restored (has attachments), skip server history
    if (this.history.length > 0) {
      logger.info('localStorage history already loaded, skipping server history');
      return;
    }

    container.innerHTML = '';
    this.history = [];

    messages.forEach((msg) => {
      const msgEl = document.createElement('div');
      msgEl.className = `chat-message ${msg.role}`;

      const timestamp = msg.timestamp ? new Date(msg.timestamp) : new Date();

      if (msg.role === 'user') {
        msgEl.innerHTML = `
          <div class="message-content">${escapeHtml(msg.content)}</div>
          <div class="message-time">${formatMessageTime(timestamp)}</div>
        `;
      } else if (msg.role === 'assistant') {
        msgEl.innerHTML = `
          <div class="message-content">${formatAssistantMessage(msg.content)}</div>
          <div class="message-time">${formatMessageTime(timestamp)}</div>
        `;
      } else if (msg.role === 'system') {
        msgEl.innerHTML = `
          <div class="message-content">${escapeHtml(msg.content)}</div>
        `;
      }

      container.appendChild(msgEl);
    });

    scrollToBottom(container);
    logger.info('Displayed', messages.length, 'history messages');
  }

  /**
   * Clear chat history
   */
  clearHistory(sessionId = null) {
    try {
      const storageKey = this.historyPrefix + (sessionId || this.sessionId);
      localStorage.removeItem(storageKey);
      this.history = [];
    } catch (e) {
      logger.warn('Failed to clear history:', e);
    }
  }

  /**
   * Clean up expired histories
   */
  cleanupExpiredHistories() {
    try {
      const keys = Object.keys(localStorage);
      const now = Date.now();

      keys.forEach((key) => {
        if (key.startsWith(this.historyPrefix)) {
          try {
            const data = JSON.parse(localStorage.getItem(key));
            if (data && data.savedAt && now - data.savedAt > this.historyExpiryMs) {
              localStorage.removeItem(key);
              logger.info('Cleaned up expired history:', key);
            }
          } catch (e) {
            // Invalid data, remove it
            localStorage.removeItem(key);
          }
        }
      });
    } catch (e) {
      logger.warn('Failed to cleanup histories:', e);
    }
  }

  // =============================================
  // Checkpoint Management
  // =============================================

  /**
   * Generate checkpoint summary from current session (for manual /checkpoint command)
   */
  generateCheckpointSummary() {
    const summary = {
      sessionId: this.sessionId,
      messageCount: this.history.length,
      lastActivity: new Date().toISOString(),
      messages: this.history.slice(-10).map((msg) => ({
        role: msg.role,
        preview: msg.content.substring(0, 100),
        timestamp: msg.timestamp,
      })),
    };

    return JSON.stringify(summary, null, 2);
  }

  /**
   * Save checkpoint via API
   */
  async saveCheckpoint(summary) {
    const response = await fetch('/api/checkpoint/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ summary }),
    });

    if (!response.ok) {
      throw new Error('Failed to save checkpoint');
    }

    return await response.json();
  }

  /**
   * Load last checkpoint via API
   */
  async loadCheckpoint() {
    const response = await fetch('/api/checkpoint/load');

    if (!response.ok) {
      if (response.status === 404) {
        return null; // No checkpoint found
      }
      throw new Error('Failed to load checkpoint');
    }

    return await response.json();
  }

  /**
   * Check for resumable session on init
   */
  async checkForResumableSession() {
    try {
      const checkpoint = await this.loadCheckpoint();
      if (checkpoint) {
        // Show resume banner
        const banner = document.getElementById('session-resume-banner');
        if (banner) {
          banner.style.display = 'flex';
          logger.info('Resume banner shown');
        }
      }
    } catch (error) {
      // Silent fail - no checkpoint is okay
      logger.info('No resumable session');
    }
  }

  // =============================================
  // Floating Chat
  // =============================================

  /**
   * Initialize floating chat panel bindings
   */
  initFloating() {
    const bubble = document.getElementById('chat-bubble');
    const closeBtn = document.getElementById('chat-close');
    const resizeHandle = document.getElementById('chat-resize-handle');
    const panel = document.getElementById('chat-panel');
    const header = document.getElementById('chat-header');

    if (bubble) {
      bubble.addEventListener('click', () => this.togglePanel());
    }
    if (closeBtn) {
      closeBtn.addEventListener('click', () => this.togglePanel(false));
    }

    if (panel && header) {
      let dragging = false;
      let startX = 0;
      let startY = 0;
      let startLeft = 0;
      let startTop = 0;

      const startDrag = (clientX, clientY) => {
        dragging = true;
        const rect = panel.getBoundingClientRect();
        startX = clientX;
        startY = clientY;
        startLeft = rect.left;
        startTop = rect.top;
        panel.classList.add('chat-panel-draggable');
        document.body.style.userSelect = 'none';
      };

      const doDrag = (clientX, clientY) => {
        if (!dragging) {
          return;
        }
        const dx = clientX - startX;
        const dy = clientY - startY;
        const nextLeft = Math.max(8, Math.min(window.innerWidth - 80, startLeft + dx));
        const nextTop = Math.max(8, Math.min(window.innerHeight - 80, startTop + dy));
        panel.style.left = `${nextLeft}px`;
        panel.style.top = `${nextTop}px`;
      };

      const endDrag = () => {
        if (!dragging) {
          return;
        }
        dragging = false;
        document.body.style.userSelect = '';
        document.body.classList.remove('no-scroll');
        this.savePanelState(panel);
      };

      header.addEventListener('mousedown', (e) => {
        if (e.target.closest('button, a, input, select')) {
          return;
        }
        e.preventDefault();
        startDrag(e.clientX, e.clientY);
      });

      this._onDragMouseMove = (e) => doDrag(e.clientX, e.clientY);
      this._onDragMouseUp = endDrag;
      window.addEventListener('mousemove', this._onDragMouseMove);
      window.addEventListener('mouseup', this._onDragMouseUp);

      this._onDragTouchMove = (e) => {
        const touch = e.touches[0];
        if (!touch) {
          return;
        }
        if (!dragging) {
          return;
        }
        e.preventDefault();
        doDrag(touch.clientX, touch.clientY);
      };
      this._onDragTouchEnd = endDrag;

      header.addEventListener(
        'touchstart',
        (e) => {
          if (e.target.closest('button, a, input, select')) {
            return;
          }
          const touch = e.touches[0];
          if (!touch) {
            return;
          }
          e.preventDefault();
          startDrag(touch.clientX, touch.clientY);
          document.body.classList.add('no-scroll');
        },
        { passive: false }
      );
      window.addEventListener('touchmove', this._onDragTouchMove, { passive: false });
      window.addEventListener('touchend', this._onDragTouchEnd);
    }

    if (resizeHandle && panel) {
      let resizing = false;
      let startX = 0;
      let startY = 0;
      let startW = 0;
      let startH = 0;

      const startResize = (clientX, clientY) => {
        resizing = true;
        const rect = panel.getBoundingClientRect();
        startX = clientX;
        startY = clientY;
        startW = rect.width;
        startH = rect.height;
        document.body.style.userSelect = 'none';
      };

      const doResize = (clientX, clientY) => {
        if (!resizing) {
          return;
        }
        const dx = clientX - startX;
        const dy = clientY - startY;
        const minW = 280;
        const minH = 320;
        const maxW = Math.min(window.innerWidth * 0.96, 800);
        const maxH = Math.min(window.innerHeight * 0.85, 900);
        const nextW = Math.max(minW, Math.min(maxW, startW + dx));
        const nextH = Math.max(minH, Math.min(maxH, startH + dy));
        panel.style.width = `${nextW}px`;
        panel.style.height = `${nextH}px`;
      };

      const endResize = () => {
        if (!resizing) {
          return;
        }
        resizing = false;
        document.body.style.userSelect = '';
        document.body.classList.remove('no-scroll');
        this.savePanelState(panel);
      };

      resizeHandle.addEventListener('mousedown', (e) => {
        e.preventDefault();
        startResize(e.clientX, e.clientY);
      });

      this._onResizeMouseMove = (e) => doResize(e.clientX, e.clientY);
      this._onResizeMouseUp = endResize;
      window.addEventListener('mousemove', this._onResizeMouseMove);
      window.addEventListener('mouseup', this._onResizeMouseUp);

      this._onResizeTouchMove = (e) => {
        const touch = e.touches[0];
        if (!touch) {
          return;
        }
        if (!resizing) {
          return;
        }
        e.preventDefault();
        doResize(touch.clientX, touch.clientY);
      };
      this._onResizeTouchEnd = endResize;

      resizeHandle.addEventListener(
        'touchstart',
        (e) => {
          const touch = e.touches[0];
          if (!touch) {
            return;
          }
          e.preventDefault();
          startResize(touch.clientX, touch.clientY);
          document.body.classList.add('no-scroll');
        },
        { passive: false }
      );
      window.addEventListener('touchmove', this._onResizeTouchMove, { passive: false });
      window.addEventListener('touchend', this._onResizeTouchEnd);
    }

    this._onEscapeKey = (e) => {
      if (e.key === 'Escape' && this.isFloatingOpen()) {
        this.togglePanel(false);
      }
    };
    document.addEventListener('keydown', this._onEscapeKey);

    logger.info('Floating mode initialized');
  }

  /**
   * Toggle floating chat panel open/close
   * @param {boolean} [forceState] - Force open (true) or close (false)
   */
  togglePanel(forceState) {
    const panel = document.getElementById('chat-panel');
    const bubble = document.getElementById('chat-bubble');
    const badge = document.getElementById('chat-badge');
    if (!panel) {
      return;
    }

    const shouldOpen = forceState !== undefined ? forceState : panel.classList.contains('hidden');

    if (shouldOpen) {
      panel.classList.remove('hidden');
      panel.classList.add('animate-slide-up');
      this.restorePanelState(panel);
      if (bubble) {
        bubble.classList.add('scale-0');
      }
      if (badge) {
        badge.classList.add('hidden');
      }
      const input = document.getElementById('chat-input');
      if (input) {
        setTimeout(() => input.focus(), 100);
      }
      const messages = document.getElementById('chat-messages');
      if (messages) {
        messages.scrollTop = messages.scrollHeight;
      }
    } else {
      panel.classList.add('hidden');
      panel.classList.remove('animate-slide-up');
      if (bubble) {
        bubble.classList.remove('scale-0');
      }
    }
  }

  /**
   * Persist panel size + position
   */
  savePanelState(panel) {
    try {
      const rect = panel.getBoundingClientRect();
      const state = {
        width: rect.width,
        height: rect.height,
        left: rect.left,
        top: rect.top,
      };
      localStorage.setItem('mama_chat_panel_state', JSON.stringify(state));
    } catch {
      // ignore storage errors
    }
  }

  /**
   * Restore panel size + position
   */
  restorePanelState(panel) {
    try {
      const raw = localStorage.getItem('mama_chat_panel_state');
      if (!raw) {
        return;
      }
      const state = JSON.parse(raw);
      if (state.width) {
        panel.style.width = `${state.width}px`;
      }
      if (state.height) {
        panel.style.height = `${state.height}px`;
      }
      if (state.left !== undefined && state.top !== undefined) {
        panel.classList.add('chat-panel-draggable');
        panel.style.left = `${state.left}px`;
        panel.style.top = `${state.top}px`;
      }
    } catch {
      // ignore storage errors
    }
  }

  /**
   * Check if floating panel is open
   */
  isFloatingOpen() {
    const panel = document.getElementById('chat-panel');
    return panel && !panel.classList.contains('hidden');
  }

  /**
   * Show unread badge on bubble when panel is closed
   */
  showUnreadBadge() {
    if (this.isFloatingOpen()) {
      return;
    }
    const badge = document.getElementById('chat-badge');
    if (badge) {
      badge.classList.remove('hidden');
    }
  }

  /**
   * Cleanup resources when module is destroyed
   * Prevents memory leaks by cleaning up timers, connections, and APIs
   */
  cleanup() {
    // Clean up WebSocket
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }

    // Clean up timers
    if (this.silenceTimeout) {
      clearTimeout(this.silenceTimeout);
      this.silenceTimeout = null;
    }
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }

    // Clean up Speech Recognition
    if (this.speechRecognition) {
      this.speechRecognition.stop();
      this.speechRecognition = null;
    }

    // Clean up Speech Synthesis
    if (this.isSpeaking) {
      this.speechSynthesis.cancel();
      this.isSpeaking = false;
    }

    // Clean up window/document event listeners
    if (this._onDragMouseMove) {
      window.removeEventListener('mousemove', this._onDragMouseMove);
      this._onDragMouseMove = null;
    }
    if (this._onDragMouseUp) {
      window.removeEventListener('mouseup', this._onDragMouseUp);
      this._onDragMouseUp = null;
    }
    if (this._onDragTouchMove) {
      window.removeEventListener('touchmove', this._onDragTouchMove);
      this._onDragTouchMove = null;
    }
    if (this._onDragTouchEnd) {
      window.removeEventListener('touchend', this._onDragTouchEnd);
      this._onDragTouchEnd = null;
    }
    if (this._onResizeMouseMove) {
      window.removeEventListener('mousemove', this._onResizeMouseMove);
      this._onResizeMouseMove = null;
    }
    if (this._onResizeMouseUp) {
      window.removeEventListener('mouseup', this._onResizeMouseUp);
      this._onResizeMouseUp = null;
    }
    if (this._onResizeTouchMove) {
      window.removeEventListener('touchmove', this._onResizeTouchMove);
      this._onResizeTouchMove = null;
    }
    if (this._onResizeTouchEnd) {
      window.removeEventListener('touchend', this._onResizeTouchEnd);
      this._onResizeTouchEnd = null;
    }
    if (this._onEscapeKey) {
      document.removeEventListener('keydown', this._onEscapeKey);
      this._onEscapeKey = null;
    }

    logger.info('Cleanup completed');
  }
}
