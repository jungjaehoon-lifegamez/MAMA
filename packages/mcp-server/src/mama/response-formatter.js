/**
 * MAMA Response Formatter - Format Search Results
 *
 * Story 2.2: Narrative Search/Expansion
 * Formats decision search results based on mode (full/summary/minimal)
 *
 * @module response-formatter
 * @version 1.0
 * @date 2025-11-25
 */

// eslint-disable-next-line no-unused-vars
const { info } = require('./debug-logger');

/**
 * Response Formatter for search results
 *
 * Formats decisions and links based on requested detail level
 */
class ResponseFormatter {
  /**
   * Format a single decision with links
   *
   * @param {Object} decision - Decision object with all fields
   * @param {Array<Object>} links - Array of link objects
   * @param {string} mode - Format mode: 'full', 'summary', 'minimal'
   * @returns {Object} Formatted response {narrative, links}
   */
  format(decision, links = [], mode = 'full') {
    if (!decision) {
      return { narrative: null, links: [] };
    }

    const narrative = this.formatNarrative(decision, mode);
    const formattedLinks = this.formatLinks(links);

    return {
      narrative,
      links: formattedLinks,
    };
  }

  /**
   * Format multiple decisions with their links
   *
   * @param {Array<Object>} decisions - Array of decision objects
   * @param {Object} linksMap - Map of decisionId -> links array
   * @param {string} mode - Format mode
   * @returns {Array<Object>} Array of formatted responses
   */
  formatMultiple(decisions, linksMap = {}, mode = 'full') {
    return decisions.map((decision) => {
      const links = linksMap[decision.id] || [];
      return this.format(decision, links, mode);
    });
  }

  /**
   * Format a single narrative (decision)
   *
   * @param {Object} decision - Decision object
   * @param {string} mode - Format mode
   * @returns {Object} Formatted narrative
   */
  formatNarrative(decision, mode = 'full') {
    switch (mode) {
      case 'minimal':
        return this._formatMinimal(decision);
      case 'summary':
        return this._formatSummary(decision);
      case 'full':
      default:
        return this._formatFull(decision);
    }
  }

  /**
   * Format links array
   *
   * @param {Array<Object>} links - Array of link objects
   * @returns {Array<Object>} Formatted links
   */
  formatLinks(links) {
    return links.map((link) => ({
      from_id: link.from_id,
      to_id: link.to_id,
      relationship: link.relationship,
      reason: link.reason || null,
      depth: link.depth || 1,
      direction: link.direction || 'outgoing',
      weight: link.weight || 1.0,
      created_by: link.created_by || null,
      approved_by_user: link.approved_by_user === 1,
    }));
  }

  /**
   * Format full narrative (all 5 layers)
   *
   * @private
   * @param {Object} decision - Decision object
   * @returns {Object} Full narrative
   */
  _formatFull(decision) {
    return {
      // Core identification
      id: decision.id,
      topic: decision.topic,

      // 5-layer narrative fields
      decision: decision.decision,
      reasoning: decision.reasoning || null, // 구체성·추론
      evidence: decision.evidence || null, // 증거
      alternatives: decision.alternatives || null, // 긴장 (대안)
      risks: decision.risks || null, // 긴장 (리스크)

      // Metadata
      outcome: decision.outcome || null, // 연속성
      confidence: decision.confidence !== undefined ? decision.confidence : null,
      user_involvement: decision.user_involvement || null,

      // Graph relationships
      supersedes: decision.supersedes || null,
      superseded_by: decision.superseded_by || null,
      refined_from: decision.refined_from || null,

      // Search metadata
      similarity: decision.similarity !== undefined ? decision.similarity : null,
      distance: decision.distance !== undefined ? decision.distance : null,

      // Timestamps
      created_at: decision.created_at,
      updated_at: decision.updated_at,
    };
  }

  /**
   * Format summary narrative (core fields only)
   *
   * @private
   * @param {Object} decision - Decision object
   * @returns {Object} Summary narrative
   */
  _formatSummary(decision) {
    return {
      id: decision.id,
      topic: decision.topic,
      decision: decision.decision,
      reasoning: decision.reasoning || null,
      evidence: decision.evidence || null, // Include evidence for context
      outcome: decision.outcome || null,
      similarity: decision.similarity !== undefined ? decision.similarity : null,
      created_at: decision.created_at,
    };
  }

  /**
   * Format minimal narrative (topic and decision only)
   *
   * @private
   * @param {Object} decision - Decision object
   * @returns {Object} Minimal narrative
   */
  _formatMinimal(decision) {
    return {
      id: decision.id,
      topic: decision.topic,
      decision: decision.decision,
      similarity: decision.similarity !== undefined ? decision.similarity : null,
    };
  }

  /**
   * Format restart response (checkpoint + narrative + links + nextSteps)
   *
   * Story 2.3: Zero-Context Restart
   * Formats the complete restart response with all context needed to resume work
   *
   * @param {Object} checkpoint - Checkpoint object
   * @param {Array<Object>} narrative - Array of related decisions
   * @param {Array<Object>} links - Array of expanded links
   * @returns {Object} Formatted restart response
   */
  formatRestart(checkpoint, narrative = [], links = []) {
    if (!checkpoint) {
      return {
        data: null,
        error: {
          code: 'NO_CHECKPOINT',
          message: 'No checkpoint found',
          details: {},
        },
      };
    }

    // Extract unfinished tasks and risks from narrative
    const unfinished = [];
    const risks = [];

    narrative.forEach((decision) => {
      // Extract unfinished items from evidence or risks field
      if (decision.risks) {
        try {
          const risksArray = Array.isArray(decision.risks)
            ? decision.risks
            : JSON.parse(decision.risks);
          risks.push(...risksArray.map((r) => (typeof r === 'string' ? r : r.description || r)));
        } catch (e) {
          // risks is a string, add directly
          risks.push(decision.risks);
        }
      }

      // Extract unfinished from evidence (if it contains TODO or incomplete markers)
      if (decision.evidence) {
        try {
          const evidenceArray = Array.isArray(decision.evidence)
            ? decision.evidence
            : JSON.parse(decision.evidence);
          evidenceArray.forEach((e) => {
            const text = typeof e === 'string' ? e : e.description || '';
            if (text.includes('TODO') || text.includes('[ ]') || text.includes('incomplete')) {
              unfinished.push(text);
            }
          });
        } catch (e) {
          // Continue without parsing
        }
      }
    });

    // Parse checkpoint next_steps into list format
    let nextStepsList = [];
    if (checkpoint.next_steps) {
      // Split by newlines and filter out empty lines
      nextStepsList = checkpoint.next_steps
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
    }

    // Format narrative with 5 layers
    const formattedNarrative = narrative.map((decision) => this.formatNarrative(decision, 'full'));

    // Format links
    const formattedLinks = this.formatLinks(links);

    return {
      data: {
        checkpoint: {
          id: checkpoint.id,
          summary: checkpoint.summary,
          timestamp: checkpoint.timestamp,
          open_files: checkpoint.open_files || [],
          status: checkpoint.status,
        },
        narrative: formattedNarrative,
        links: formattedLinks,
        nextSteps: {
          unfinished: unfinished.length > 0 ? unfinished : ['No unfinished items tracked'],
          recommendations:
            nextStepsList.length > 0
              ? nextStepsList
              : ['Review checkpoint summary and continue work'],
          risks: risks.length > 0 ? risks : [],
        },
      },
    };
  }
}

// Singleton instance
const responseFormatter = new ResponseFormatter();

module.exports = {
  ResponseFormatter,
  responseFormatter,
  // Convenience functions
  format: (decision, links, mode) => responseFormatter.format(decision, links, mode),
  formatMultiple: (decisions, linksMap, mode) =>
    responseFormatter.formatMultiple(decisions, linksMap, mode),
  formatNarrative: (decision, mode) => responseFormatter.formatNarrative(decision, mode),
  formatLinks: (links) => responseFormatter.formatLinks(links),
  formatRestart: (checkpoint, narrative, links) =>
    responseFormatter.formatRestart(checkpoint, narrative, links),
};
