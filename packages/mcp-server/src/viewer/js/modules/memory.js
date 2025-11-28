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

import { escapeHtml, debounce, showToast } from '../utils/dom.js';
import { formatRelativeTime, truncateText } from '../utils/format.js';
import { API } from '../utils/api.js';

/**
 * Memory Module Class
 */
export class MemoryModule {
  constructor() {
    // State
    this.searchData = [];
    this.debouncedSearch = debounce(() => this.performSearch(), 300);

    // Initialize event listeners
    this.initEventListeners();
  }

  /**
   * Initialize all event listeners
   */
  initEventListeners() {
    // Modal click outside to close
    document.addEventListener('click', (e) => {
      const modal = document.getElementById('save-decision-modal');
      if (modal && e.target === modal) {
        this.hideSaveForm();
      }
    });

    // Escape key to close modal
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        const modal = document.getElementById('save-decision-modal');
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
  handleSearchInput(event) {
    if (event.key === 'Enter') {
      this.search();
    } else {
      this.debouncedSearch();
    }
  }

  /**
   * Perform search (internal, debounced)
   */
  async performSearch() {
    const input = document.getElementById('memory-search-input');
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
  async search() {
    const input = document.getElementById('memory-search-input');
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
      console.error('[Memory] Search error:', error);
      this.setStatus(`Error: ${error.message}`, 'error');
    }
  }

  /**
   * Search for related decisions (called automatically for chat messages)
   * @param {string} message - Chat message text
   * @returns {Promise<Array>} Related decisions
   */
  async searchRelated(message) {
    if (!message || message.length < 3) {
      return [];
    }

    try {
      const data = await API.searchMemory(message, 5);
      return data.results || [];
    } catch (error) {
      console.error('[Memory] Related search error:', error);
      return [];
    }
  }

  /**
   * Show related decisions for a chat message
   * @param {string} message - Chat message text
   */
  async showRelatedForMessage(message) {
    const results = await this.searchRelated(message);

    if (results.length > 0) {
      this.searchData = results;

      // Update search input with the query
      const input = document.getElementById('memory-search-input');
      input.value = message.substring(0, 50) + (message.length > 50 ? '...' : '');

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
  renderResults(results, query) {
    const container = document.getElementById('memory-results');

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
  toggleCard(idx) {
    const cards = document.querySelectorAll('.memory-card');
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
  showPlaceholder() {
    const container = document.getElementById('memory-results');
    container.innerHTML = `
      <div class="memory-placeholder">
        <p>🧠 Search your MAMA decisions</p>
        <p class="memory-hint">Type a keyword or send a chat message to see related decisions</p>
      </div>
    `;
    this.setStatus('', '');
  }

  /**
   * Set memory status message
   * @param {string} message - Status message
   * @param {string} type - Status type (loading, error, success, '')
   */
  setStatus(message, type) {
    const status = document.getElementById('memory-status');
    status.textContent = message;
    status.className = 'memory-status ' + (type || '');
  }

  /**
   * Show save decision form modal
   */
  showSaveForm() {
    const modal = document.getElementById('save-decision-modal');
    modal.classList.add('visible');

    // Clear form
    document.getElementById('save-topic').value = '';
    document.getElementById('save-decision').value = '';
    document.getElementById('save-reasoning').value = '';
    document.getElementById('save-confidence').value = '0.8';
    document.getElementById('save-form-status').textContent = '';
    document.getElementById('save-form-status').className = 'save-form-status';

    // Focus on topic field
    setTimeout(() => {
      document.getElementById('save-topic').focus();
    }, 100);
  }

  /**
   * Hide save decision form modal
   */
  hideSaveForm() {
    const modal = document.getElementById('save-decision-modal');
    modal.classList.remove('visible');
  }

  /**
   * Submit save decision form
   */
  async submitSaveForm() {
    const topic = document.getElementById('save-topic').value.trim();
    const decision = document.getElementById('save-decision').value.trim();
    const reasoning = document.getElementById('save-reasoning').value.trim();
    const confidence = parseFloat(document.getElementById('save-confidence').value);

    const statusEl = document.getElementById('save-form-status');
    const submitBtn = document.querySelector('.save-form-submit');

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
        const searchInput = document.getElementById('memory-search-input');
        if (searchInput.value.trim()) {
          this.search();
        }
      }, 1500);
    } catch (error) {
      console.error('[Memory] Save error:', error);
      statusEl.textContent = `Error: ${error.message}`;
      statusEl.className = 'save-form-status error';
    } finally {
      submitBtn.disabled = false;
    }
  }
}
