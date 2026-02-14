/**
 * Memory Module - MAMA Memory Integration
 * @module modules/memory
 * @version 1.0.0
 *
 * Handles Memory tab functionality including:
 * - Semantic search of MAMA decisions
 * - Related decision suggestions for chat messages
 * - Save decision form modal
 */

/* eslint-env browser */
/* global lucide */

import { escapeHtml, debounce, showToast, getElementByIdOrNull } from '../utils/dom.js';
import { formatRelativeTime, truncateText } from '../utils/format.js';
import { API, type MemorySearchItem } from '../utils/api.js';

/**
 * Memory Module Class
 */
export class MemoryModule {
  searchData: MemorySearchItem[] = [];
  debouncedSearch = debounce(() => this.performSearch(), 300);
  currentQuery = '';

  constructor() {
    // Initialize event listeners
    this.initEventListeners();
  }

  /**
   * Initialize all event listeners
   */
  initEventListeners(): void {
    // Modal click outside to close
    document.addEventListener('click', (e: MouseEvent) => {
      const modal = getElementByIdOrNull<HTMLDivElement>('save-decision-modal');
      if (modal && e.target === modal) {
        this.hideSaveForm();
      }
    });

    // Escape key to close modal
    document.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        const modal = getElementByIdOrNull<HTMLDivElement>('save-decision-modal');
        if (modal && modal.classList.contains('visible')) {
          this.hideSaveForm();
        }
      }
    });
  }

  /**
   * Handle memory search input event
   * @param {KeyboardEvent} event - Keyboard event
   */
  handleSearchInput(event: KeyboardEvent): void {
    if (event.key === 'Enter') {
      this.search();
    } else {
      this.debouncedSearch();
    }
  }

  /**
   * Perform search (internal, debounced)
   */
  async performSearch(): Promise<void> {
    const input = getElementByIdOrNull<HTMLInputElement>('memory-search-input');
    if (!input) {
      return;
    }
    const query = input.value.trim();

    if (!query) {
      this.showPlaceholder();
      return;
    }

    await this.search();
  }

  /**
   * Search memory decisions via API
   */
  async search(): Promise<void> {
    const input = getElementByIdOrNull<HTMLInputElement>('memory-search-input');
    if (!input) {
      return;
    }
    const query = input.value.trim();

    if (!query) {
      this.showPlaceholder();
      return;
    }

    this.setStatus('Searching...', 'loading');

    try {
      const data = await API.searchMemory(query, 10);
      this.searchData = data.results || [];
      this.renderResults(this.searchData, query);
      this.setStatus(`Found ${this.searchData.length} decision(s)`, '');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[Memory] Search error:', message);
      this.setStatus(`Error: ${message}`, 'error');
    }
  }

  /**
   * Search for related decisions (called automatically for chat messages)
   * @param {string} message - Chat message text
   * @returns {Promise<Array>} Related decisions
   */
  async searchRelated(message: string): Promise<MemorySearchItem[]> {
    if (!message || message.length < 3) {
      return [];
    }

    try {
      const data = await API.searchMemory(message, 5);
      return data.results || [];
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[Memory] Related search error:', message);
      return [];
    }
  }

  /**
   * Show related decisions for a chat message
   * @param {string} message - Chat message text
   */
  async showRelatedForMessage(message: string): Promise<void> {
    const results = await this.searchRelated(message);

    if (results.length > 0) {
      this.searchData = results;

      // Update search input with the query (if element exists)
      const input = getElementByIdOrNull<HTMLInputElement>('memory-search-input');
      if (input) {
        input.value = message.substring(0, 50) + (message.length > 50 ? '...' : '');
      }

      // Render results
      this.renderResults(results, message);
      this.setStatus(`${results.length} related decision(s) found`, '');

      // Show notification
      showToast(`🧠 ${results.length} related MAMA decision(s) found`);
    }
  }

  /**
   * Render search results
   * @param {Array} results - Search results
   * @param {string} query - Search query
   */
  renderResults(results: MemorySearchItem[], query: string): void {
    const container = getElementByIdOrNull<HTMLElement>('memory-results');

    // Guard: element may not exist if not on Memory tab
    if (!container) {
      return;
    }

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
        <div class="memory-card" onclick="window.memoryModule.toggleCard(${idx})">
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

  /**
   * Toggle memory card expand/collapse
   * @param {number} idx - Card index
   */
  toggleCard(idx: number): void {
    const cards = document.querySelectorAll<HTMLElement>('.memory-card');
    cards.forEach((card, i) => {
      if (i === idx) {
        card.classList.toggle('expanded');
      } else {
        card.classList.remove('expanded');
      }
    });
  }

  /**
   * Show memory placeholder
   */
  showPlaceholder(): void {
    const container = getElementByIdOrNull<HTMLElement>('memory-results');
    if (!container) {
      return;
    }
    container.innerHTML = `
      <div class="memory-placeholder">
        <p><i data-lucide="brain"></i> Search your MAMA decisions</p>
        <p class="memory-hint">Type a keyword or send a chat message to see related decisions</p>
      </div>
    `;
    this.setStatus('', '');
    // Reinitialize Lucide icons for dynamic content
    if (typeof lucide !== 'undefined' && typeof window.lucideConfig !== 'undefined') {
      lucide.createIcons(window.lucideConfig);
    }
  }

  /**
   * Set memory status message
   * @param {string} message - Status message
   * @param {string} type - Status type (loading, error, success, '')
   */
  setStatus(message: string, type: 'loading' | 'error' | 'success' | '' = ''): void {
    const status = getElementByIdOrNull<HTMLElement>('memory-status');
    if (!status) {
      return;
    } // Guard: element may not exist if not on Memory tab
    status.textContent = message;
    status.className = 'memory-status ' + (type || '');
  }

  /**
   * Show save decision form modal
   */
  showSaveForm(): void {
    const modal = getElementByIdOrNull<HTMLDivElement>('save-decision-modal');
    if (!modal) {
      return;
    }
    modal.classList.add('visible');

    // Clear form
    const topicInput = getElementByIdOrNull<HTMLInputElement>('save-topic');
    const decisionInput = getElementByIdOrNull<HTMLTextAreaElement>('save-decision');
    const reasoningInput = getElementByIdOrNull<HTMLTextAreaElement>('save-reasoning');
    const confidenceInput = getElementByIdOrNull<HTMLInputElement>('save-confidence');
    const statusEl = getElementByIdOrNull<HTMLElement>('save-form-status');
    if (topicInput) {
      topicInput.value = '';
    }
    if (decisionInput) {
      decisionInput.value = '';
    }
    if (reasoningInput) {
      reasoningInput.value = '';
    }
    if (confidenceInput) {
      confidenceInput.value = '0.8';
    }
    if (statusEl) {
      statusEl.textContent = '';
      statusEl.className = 'save-form-status';
    }

    // Focus on topic field
    setTimeout(() => {
      const focusTarget = getElementByIdOrNull<HTMLInputElement>('save-topic');
      focusTarget?.focus();
    }, 100);
  }

  /**
   * Show save form with pre-filled text (for /save command)
   */
  showSaveFormWithText(text: string): void {
    const modal = getElementByIdOrNull<HTMLDivElement>('save-decision-modal');
    if (!modal) {
      return;
    }
    modal.classList.add('visible');

    // Pre-fill decision field
    const topicInput = getElementByIdOrNull<HTMLInputElement>('save-topic');
    const decisionInput = getElementByIdOrNull<HTMLTextAreaElement>('save-decision');
    const reasoningInput = getElementByIdOrNull<HTMLTextAreaElement>('save-reasoning');
    const confidenceInput = getElementByIdOrNull<HTMLInputElement>('save-confidence');
    const statusEl = getElementByIdOrNull<HTMLElement>('save-form-status');
    if (topicInput) {
      topicInput.value = '';
    }
    if (decisionInput) {
      decisionInput.value = text;
    }
    if (reasoningInput) {
      reasoningInput.value = '';
    }
    if (confidenceInput) {
      confidenceInput.value = '0.8';
    }
    if (statusEl) {
      statusEl.textContent = '';
      statusEl.className = 'save-form-status';
    }

    // Focus on topic field
    setTimeout(() => {
      const focusTarget = getElementByIdOrNull<HTMLInputElement>('save-topic');
      focusTarget?.focus();
    }, 100);
  }

  /**
   * Hide save decision form modal
   */
  hideSaveForm(): void {
    const modal = getElementByIdOrNull<HTMLDivElement>('save-decision-modal');
    if (!modal) {
      return;
    }
    modal.classList.remove('visible');
  }

  /**
   * Execute search with query (for /search command)
   */
  async searchWithQuery(query: string): Promise<void> {
    const searchInput = getElementByIdOrNull<HTMLInputElement>('memory-search-input');
    if (searchInput) {
      searchInput.value = query;
    }
    this.currentQuery = query;
    await this.search();
  }

  /**
   * Submit save decision form
   */
  async submitSaveForm(): Promise<void> {
    const topicInput = getElementByIdOrNull<HTMLInputElement>('save-topic');
    const decisionInput = getElementByIdOrNull<HTMLTextAreaElement>('save-decision');
    const reasoningInput = getElementByIdOrNull<HTMLTextAreaElement>('save-reasoning');
    const confidenceInput = getElementByIdOrNull<HTMLInputElement>('save-confidence');
    const statusEl = getElementByIdOrNull<HTMLElement>('save-form-status');
    const submitBtn = document.querySelector<HTMLButtonElement>('.save-form-submit');
    if (
      !topicInput ||
      !decisionInput ||
      !reasoningInput ||
      !confidenceInput ||
      !statusEl ||
      !submitBtn
    ) {
      return;
    }

    const topic = topicInput.value.trim();
    const decision = decisionInput.value.trim();
    const reasoning = reasoningInput.value.trim();
    const confidence = parseFloat(confidenceInput.value);

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
        this.hideSaveForm();

        // Refresh memory search if there's a query
        const searchInput = getElementByIdOrNull<HTMLInputElement>('memory-search-input');
        if (searchInput?.value.trim()) {
          this.search();
        }
      }, 1500);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[Memory] Save error:', message);
      statusEl.textContent = `Error: ${message}`;
      statusEl.className = 'save-form-status error';
    } finally {
      submitBtn.disabled = false;
    }
  }
}
