/**
 * MAMA Link Expander - Graph Traversal for Decision Links
 *
 * Story 2.2: Narrative Search/Expansion
 * Implements BFS-based link expansion with depth control and approval filtering
 *
 * @module link-expander
 * @version 1.0
 * @date 2025-11-25
 */

const { info, error: logError } = require('@jungjaehoon/mama-core/debug-logger');
const { getAdapter } = require('@jungjaehoon/mama-core/db-manager');

/**
 * Link Expander for decision graph traversal
 *
 * Expands links from a given decision with configurable depth
 * and filters for approved links only
 */
class LinkExpander {
  /**
   * Expand links from a decision
   *
   * @param {string} decisionId - Root decision ID
   * @param {number} depth - Expansion depth (0=no links, 1=direct, 2=2-hop, etc.)
   * @param {boolean} approvedOnly - Filter for approved links only (default: true)
   * @returns {Array<Object>} Array of links with depth information
   */
  expand(decisionId, depth = 1, approvedOnly = true) {
    try {
      if (!decisionId || typeof decisionId !== 'string') {
        throw new Error('decisionId must be a non-empty string');
      }

      if (depth < 0) {
        throw new Error('depth must be >= 0');
      }

      if (depth === 0) {
        info(`[LinkExpander] depth=0, returning empty links`);
        return [];
      }

      info(
        `[LinkExpander] Expanding links for ${decisionId} (depth: ${depth}, approvedOnly: ${approvedOnly})`
      );

      const adapter = getAdapter();
      const visited = new Set();
      const allLinks = [];

      // BFS queue: {id, currentDepth}
      const queue = [{ id: decisionId, currentDepth: 0 }];
      visited.add(decisionId);

      while (queue.length > 0) {
        const { id, currentDepth } = queue.shift();

        // Stop if we've reached the depth limit
        if (currentDepth >= depth) {
          continue;
        }

        // Get outgoing links from this decision
        const outgoingLinks = this._getLinks(adapter, id, 'outgoing', approvedOnly);
        // Get incoming links to this decision
        const incomingLinks = this._getLinks(adapter, id, 'incoming', approvedOnly);

        // Process outgoing links
        for (const link of outgoingLinks) {
          allLinks.push({
            ...link,
            depth: currentDepth + 1,
            direction: 'outgoing',
          });

          // Add to queue if not visited and within depth limit
          if (!visited.has(link.to_id) && currentDepth + 1 < depth) {
            visited.add(link.to_id);
            queue.push({ id: link.to_id, currentDepth: currentDepth + 1 });
          }
        }

        // Process incoming links
        for (const link of incomingLinks) {
          allLinks.push({
            ...link,
            depth: currentDepth + 1,
            direction: 'incoming',
          });

          // Add to queue if not visited and within depth limit
          if (!visited.has(link.from_id) && currentDepth + 1 < depth) {
            visited.add(link.from_id);
            queue.push({ id: link.from_id, currentDepth: currentDepth + 1 });
          }
        }
      }

      info(`[LinkExpander] Found ${allLinks.length} links (visited ${visited.size} nodes)`);

      return allLinks;
    } catch (error) {
      logError(`[LinkExpander] Expansion failed: ${error.message}`);
      throw error;
    }
  }

  /**
   * Get links for a decision (outgoing or incoming)
   *
   * @private
   * @param {Object} adapter - Database adapter
   * @param {string} decisionId - Decision ID
   * @param {string} direction - 'outgoing' or 'incoming'
   * @param {boolean} approvedOnly - Filter for approved links
   * @returns {Array<Object>} Array of links
   */
  _getLinks(adapter, decisionId, direction, approvedOnly) {
    try {
      let query;
      let params;

      if (direction === 'outgoing') {
        // Links FROM this decision TO others
        query = `
          SELECT from_id, to_id, relationship, reason, weight,
                 created_by, approved_by_user, decision_id, evidence, created_at
          FROM decision_edges
          WHERE from_id = ?
        `;
        params = [decisionId];
      } else {
        // Links TO this decision FROM others
        query = `
          SELECT from_id, to_id, relationship, reason, weight,
                 created_by, approved_by_user, decision_id, evidence, created_at
          FROM decision_edges
          WHERE to_id = ?
        `;
        params = [decisionId];
      }

      // Add approval filter
      if (approvedOnly) {
        query += ' AND approved_by_user = 1';
      }

      query += ' ORDER BY created_at DESC';

      const stmt = adapter.prepare(query);
      const links = stmt.all(...params);

      return links;
    } catch (error) {
      logError(`[LinkExpander] Failed to get ${direction} links: ${error.message}`);
      return [];
    }
  }

  /**
   * Get direct links only (depth = 1 convenience method)
   *
   * @param {string} decisionId - Decision ID
   * @param {boolean} approvedOnly - Filter for approved links
   * @returns {Array<Object>} Array of direct links
   */
  getDirectLinks(decisionId, approvedOnly = true) {
    return this.expand(decisionId, 1, approvedOnly);
  }

  /**
   * Count total links for a decision
   *
   * @param {string} decisionId - Decision ID
   * @param {boolean} approvedOnly - Filter for approved links
   * @returns {Object} {outgoing: number, incoming: number, total: number}
   */
  countLinks(decisionId, approvedOnly = true) {
    try {
      const adapter = getAdapter();

      let outgoingQuery = 'SELECT COUNT(*) as count FROM decision_edges WHERE from_id = ?';
      let incomingQuery = 'SELECT COUNT(*) as count FROM decision_edges WHERE to_id = ?';

      if (approvedOnly) {
        outgoingQuery += ' AND approved_by_user = 1';
        incomingQuery += ' AND approved_by_user = 1';
      }

      const outgoingStmt = adapter.prepare(outgoingQuery);
      const incomingStmt = adapter.prepare(incomingQuery);

      const outgoingCount = outgoingStmt.get(decisionId).count;
      const incomingCount = incomingStmt.get(decisionId).count;

      return {
        outgoing: outgoingCount,
        incoming: incomingCount,
        total: outgoingCount + incomingCount,
      };
    } catch (error) {
      logError(`[LinkExpander] Failed to count links: ${error.message}`);
      return { outgoing: 0, incoming: 0, total: 0 };
    }
  }
}

// Singleton instance
const linkExpander = new LinkExpander();

module.exports = {
  LinkExpander,
  linkExpander,
  // Convenience functions
  expand: (decisionId, depth, approvedOnly) => linkExpander.expand(decisionId, depth, approvedOnly),
  getDirectLinks: (decisionId, approvedOnly) =>
    linkExpander.getDirectLinks(decisionId, approvedOnly),
  countLinks: (decisionId, approvedOnly) => linkExpander.countLinks(decisionId, approvedOnly),
};
