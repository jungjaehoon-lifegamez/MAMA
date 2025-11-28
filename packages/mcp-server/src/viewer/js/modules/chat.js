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

    // Auto checkpoint state
    this.idleTimer = null;
    this.idleDelay = 5 * 60 * 1000; // 5 minutes

    // Initialize
    this.initChatInput();
    this.initLongPressCopy();
    this.initSpeechRecognition();
    this.initSpeechSynthesis();
    this.initAutoCheckpoint();
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

    const savedSessionId = localStorage.getItem('mama_chat_session_id');

    if (savedSessionId) {
      console.log('[Chat] Trying saved session:', savedSessionId);
      this.addSystemMessage('Connecting to session...');
      this.initWebSocket(savedSessionId);
    } else {
      try {
        this.addSystemMessage('Creating new session...');
        const data = await API.createSession('.');
        const sessionId = data.sessionId;

        console.log('[Chat] Created new session:', sessionId);
        localStorage.setItem('mama_chat_session_id', sessionId);

        this.initWebSocket(sessionId);
      } catch (error) {
        console.error('[Chat] Failed to create session:', error);
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
      console.log('[Chat] Already connected');
      return;
    }

    this.sessionId = sessionId;
    this.restoreHistory(sessionId);

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws?sessionId=${sessionId}`;

    console.log('[Chat] Connecting to:', wsUrl);
    this.ws = new WebSocket(wsUrl);

    this.ws.onopen = () => {
      console.log('[Chat] Connected');
      this.reconnectAttempts = 0;
      this.updateStatus('connected');
      this.enableInput(true);

      this.ws.send(
        JSON.stringify({
          type: 'attach',
          sessionId: sessionId,
        })
      );
    };

    this.ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        this.handleMessage(data);
      } catch (e) {
        console.error('[Chat] Parse error:', e);
      }
    };

    this.ws.onclose = (event) => {
      console.log('[Chat] Disconnected:', event.code, event.reason);
      this.updateStatus('disconnected');
      this.enableInput(false);

      if (this.sessionId) {
        this.scheduleReconnect();
      }
    };

    this.ws.onerror = (error) => {
      console.error('[Chat] WebSocket error:', error);
      this.updateStatus('disconnected');
    };
  }

  /**
   * Handle incoming WebSocket message
   */
  handleMessage(data) {
    switch (data.type) {
      case 'attached':
        console.log('[Chat] Attached to session:', data.sessionId);
        this.addSystemMessage('Connected to session');
        break;

      case 'output':
      case 'stream':
        if (data.content) {
          this.enableSend(true);
          this.appendStreamChunk(data.content);
        }
        break;

      case 'stream_end':
        this.finalizeStreamMessage();
        break;

      case 'error':
        if (data.error === 'session_not_found') {
          console.log('[Chat] Session not found, creating new one...');
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

      case 'pong':
        break;

      default:
        console.log('[Chat] Unknown message type:', data.type);
    }
  }

  /**
   * Schedule reconnection with exponential backoff
   */
  scheduleReconnect() {
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), this.maxReconnectDelay);
    this.reconnectAttempts++;

    console.log(`[Chat] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);
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

    console.log('[Chat] Sent:', message);
  }

  /**
   * Handle slash commands
   */
  handleCommand(message) {
    const parts = message.slice(1).split(' ');
    const command = parts[0].toLowerCase();
    const args = parts.slice(1).join(' ');

    console.log('[Chat] Command:', command, 'Args:', args);

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
        this.addSystemMessage(
          `Unknown command: /${command}. Type /help for available commands.`,
          'error'
        );
    }
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
      console.error('[Chat] Checkpoint save failed:', error);
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
      console.error('[Chat] Checkpoint load failed:', error);
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

    // Auto-play TTS if enabled
    if (this.ttsEnabled && text) {
      console.log('[TTS] Auto-play enabled, speaking assistant message');
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
            behavior: 'smooth',
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
    }

    if (this.currentStreamEl) {
      this.currentStreamEl.classList.remove('streaming');
      this.currentStreamEl = null;
      this.currentStreamText = '';
      this.streamBuffer = '';
    }
    this.rafPending = false;
    this.enableSend(true);
  }

  // =============================================
  // UI Control
  // =============================================

  /**
   * Update chat status
   */
  updateStatus(status) {
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
        console.error('[Chat] Copy failed:', err);
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
      console.warn('[Voice] SpeechRecognition not supported');
      const micBtn = document.getElementById('chat-mic');
      if (micBtn) {
        micBtn.style.display = 'none';
      }
      return;
    }

    this.speechRecognition = new SpeechRecognition();
    this.speechRecognition.lang = 'ko-KR';
    this.speechRecognition.continuous = true; // Enable continuous recognition for longer phrases
    this.speechRecognition.interimResults = true;
    this.speechRecognition.maxAlternatives = 3; // Get multiple recognition candidates for better accuracy

    this.speechRecognition.onresult = (event) => {
      const input = document.getElementById('chat-input');
      let interimTranscript = '';
      let finalTranscript = '';

      // Build transcript from NEW results only (use resultIndex)
      console.log(
        '[Voice] onresult fired, resultIndex:',
        event.resultIndex,
        'total results:',
        event.results.length
      );

      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        const transcript = result[0].transcript;

        if (result.isFinal) {
          finalTranscript += transcript;
          console.log(
            '[Voice] Final result [' + i + ']:',
            transcript,
            'Confidence:',
            result[0].confidence
          );
        } else {
          interimTranscript += transcript;
          console.log('[Voice] Interim result [' + i + ']:', transcript);
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
        console.log('[Voice] Accumulated transcript:', this.accumulatedTranscript);
      }

      // Handle interim transcripts - show temporarily with accumulated text
      if (interimTranscript) {
        const displayText = this.accumulatedTranscript
          ? this.accumulatedTranscript + ' ' + interimTranscript
          : interimTranscript;
        input.value = displayText;
        input.classList.add('voice-active');
        console.log('[Voice] Showing interim (temp):', displayText);
      }

      autoResizeTextarea(input);

      // Reset silence timer on each result
      clearTimeout(this.silenceTimeout);
      this.silenceTimeout = setTimeout(() => {
        if (this.isRecording) {
          console.log('[Voice] Silence detected, stopping...');
          this.stopVoice();
        }
      }, this.silenceDelay);
    };

    this.speechRecognition.onend = () => {
      console.log('[Voice] Recognition ended');
      this.stopVoice();
    };

    this.speechRecognition.onerror = (event) => {
      console.error('[Voice] Error:', event.error);
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

    console.log('[Voice] SpeechRecognition initialized (lang: ko-KR)');
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

      console.log('[Voice] Recording started (continuous mode)');
      console.log('[Voice] Settings:', {
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
      console.error('[Voice] Failed to start:', err);
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

    console.log('[Voice] Recording stopped');
  }

  // =============================================
  // Text-to-Speech (TTS)
  // =============================================

  /**
   * Initialize Speech Synthesis
   */
  initSpeechSynthesis() {
    if (!this.speechSynthesis) {
      console.warn('[TTS] SpeechSynthesis not supported');
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
        console.log('[TTS] Korean voice selected:', this.ttsVoice.name, this.ttsVoice.lang);
      } else {
        console.warn('[TTS] No Korean voice found, using default');
      }
    };

    // Voices might not be loaded immediately
    if (this.speechSynthesis.getVoices().length > 0) {
      loadVoices();
    } else {
      this.speechSynthesis.onvoiceschanged = loadVoices;
    }

    console.log('[TTS] SpeechSynthesis initialized');
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

    console.log('[TTS] Auto-play:', this.ttsEnabled ? 'ON' : 'OFF');
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

    console.log('[TTS] Hands-free mode:', this.handsFreeMode ? 'ON' : 'OFF');
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
    utterance.lang = 'ko-KR';

    utterance.onstart = () => {
      this.isSpeaking = true;
      console.log('[TTS] Speaking started');
    };

    utterance.onend = () => {
      this.isSpeaking = false;
      console.log('[TTS] Speaking ended');

      // If hands-free mode, start listening after TTS finishes
      if (this.handsFreeMode && !this.isRecording) {
        console.log('[TTS] Hands-free mode: auto-starting voice input');
        setTimeout(() => {
          this.startVoice();
        }, 500); // Small delay for smooth transition
      }
    };

    utterance.onerror = (event) => {
      this.isSpeaking = false;
      console.error('[TTS] Error:', event.error);
    };

    this.speechSynthesis.speak(utterance);
    console.log('[TTS] Speaking:', text.substring(0, 50) + '...');
  }

  /**
   * Stop speaking
   */
  stopSpeaking() {
    if (this.speechSynthesis && this.isSpeaking) {
      this.speechSynthesis.cancel();
      this.isSpeaking = false;
      console.log('[TTS] Speaking stopped');
    }
  }

  /**
   * Set TTS rate (0.5 - 2.0)
   */
  setTTSRate(rate) {
    this.ttsRate = Math.max(0.5, Math.min(2.0, rate));
    console.log('[TTS] Rate set to:', this.ttsRate);
  }

  // =============================================
  // History Management
  // =============================================

  /**
   * Save message to history
   */
  saveToHistory(role, content, timestamp = new Date()) {
    if (!this.sessionId) {
      return;
    }

    this.history.push({
      role,
      content,
      timestamp: timestamp.toISOString(),
    });

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
      console.warn('[Chat] Failed to save history:', e);
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
      console.warn('[Chat] Failed to load history:', e);
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

    scrollToBottom(container);
    showToast('Previous conversation restored');

    return true;
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
      console.warn('[Chat] Failed to clear history:', e);
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

  // =============================================
  // Checkpoint Management
  // =============================================

  /**
   * Initialize auto checkpoint timer
   */
  initAutoCheckpoint() {
    // Reset timer on user activity
    const resetTimer = () => this.resetIdleTimer();

    document.addEventListener('keydown', resetTimer);
    document.addEventListener('click', resetTimer);
    document.addEventListener('touchstart', resetTimer);

    console.log('[Chat] Auto checkpoint initialized (5 min idle)');
  }

  /**
   * Reset idle timer
   */
  resetIdleTimer() {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
    }

    this.idleTimer = setTimeout(() => {
      this.autoSaveCheckpoint();
    }, this.idleDelay);
  }

  /**
   * Auto-save checkpoint when idle
   */
  async autoSaveCheckpoint() {
    // Only save if there's content
    if (this.history.length === 0) {
      console.log('[Chat] No history to save');
      return;
    }

    try {
      const summary = this.generateCheckpointSummary();
      await this.saveCheckpoint(summary);
      showToast('💾 Session auto-saved');
      console.log('[Chat] Auto checkpoint saved');
    } catch (error) {
      console.error('[Chat] Auto checkpoint failed:', error);
      // Silent fail - don't disturb user
    }
  }

  /**
   * Generate checkpoint summary from current session
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
          console.log('[Chat] Resume banner shown');
        }
      }
    } catch (error) {
      // Silent fail - no checkpoint is okay
      console.log('[Chat] No resumable session');
    }
  }
}
