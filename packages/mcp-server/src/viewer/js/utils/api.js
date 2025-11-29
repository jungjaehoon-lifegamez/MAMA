/**
 * API Utility Functions
 * @module utils/api
 * @version 1.0.0
 */

/* eslint-env browser */

/**
 * API client for MAMA viewer
 */
export class API {
  /**
   * Base URL for API requests (empty for same origin)
   */
  static baseUrl = '';

  /**
   * Perform GET request
   * @param {string} endpoint - API endpoint
   * @param {Object} params - Query parameters
   * @returns {Promise<Object>} Response data
   */
  static async get(endpoint, params = null) {
    const url = new URL(endpoint, window.location.origin);
    if (params) {
      Object.entries(params).forEach(([key, value]) => {
        if (value !== null && value !== undefined) {
          url.searchParams.set(key, value);
        }
      });
    }

    const response = await fetch(url);
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.message || `HTTP ${response.status}`);
    }

    return response.json();
  }

  /**
   * Perform POST request
   * @param {string} endpoint - API endpoint
   * @param {Object} body - Request body
   * @returns {Promise<Object>} Response data
   */
  static async post(endpoint, body) {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.message || `HTTP ${response.status}`);
    }

    return response.json();
  }

  // =============================================
  // Graph API
  // =============================================

  /**
   * Get graph data
   * @param {Object} params - Query parameters
   * @returns {Promise<Object>} Graph data
   */
  static async getGraph(params = {}) {
    return this.get('/graph', { cluster: 'true', ...params });
  }

  /**
   * Get similar decisions for a node
   * @param {string} nodeId - Node ID
   * @returns {Promise<Object>} Similar decisions
   */
  static async getSimilarDecisions(nodeId) {
    return this.get('/graph/similar', { id: nodeId });
  }

  /**
   * Update decision outcome
   * @param {string} id - Decision ID
   * @param {string} outcome - Outcome value
   * @param {string} reason - Optional reason
   * @returns {Promise<Object>} Update result
   */
  static async updateOutcome(id, outcome, reason = null) {
    return this.post('/graph/update', { id, outcome, reason });
  }

  // =============================================
  // Checkpoint API
  // =============================================

  /**
   * Get all checkpoints
   * @returns {Promise<Object>} Checkpoints data
   */
  static async getCheckpoints() {
    return this.get('/checkpoints');
  }

  // =============================================
  // MAMA Memory API
  // =============================================

  /**
   * Search MAMA decisions
   * @param {string} query - Search query
   * @param {number} limit - Maximum results
   * @returns {Promise<Object>} Search results
   */
  static async searchMemory(query, limit = 10) {
    return this.get('/api/mama/search', { q: query, limit });
  }

  /**
   * Save a new decision to MAMA
   * @param {Object} data - Decision data
   * @param {string} data.topic - Decision topic
   * @param {string} data.decision - Decision text
   * @param {string} data.reasoning - Reasoning text
   * @param {number} data.confidence - Confidence (0-1)
   * @returns {Promise<Object>} Save result
   */
  static async saveDecision(data) {
    return this.post('/api/mama/save', data);
  }

  // =============================================
  // Session API
  // =============================================

  /**
   * Create a new chat session
   * @param {string} projectDir - Project directory
   * @returns {Promise<Object>} Session data
   */
  static async createSession(projectDir = '.') {
    return this.post('/api/sessions', { projectDir });
  }
}
