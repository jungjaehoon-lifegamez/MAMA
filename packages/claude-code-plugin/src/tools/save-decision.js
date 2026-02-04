/**
 * MCP Tool: save_decision
 *
 * Story M1.3: MCP Tool - save_decision (ported from mcp-server)
 * Priority: P1 (Core Feature)
 *
 * Saves decisions and insights to MAMA's memory for future reference.
 *
 * @module save-decision
 */

const mama = require('../core/mama-api.js');

const CONTRACT_TOPIC_PREFIXES = [
  'contract_get_',
  'contract_post_',
  'contract_put_',
  'contract_patch_',
  'contract_delete_',
  'contract_head_',
  'contract_options_',
  'contract_function_',
  'contract_type_',
  'contract_sql_',
  'contract_graphql_',
];

const CONTRACT_HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];

function isContractTopic(topic) {
  if (!topic) {
    return false;
  }
  return CONTRACT_TOPIC_PREFIXES.some((prefix) => topic.startsWith(prefix));
}

function validateContractDecision(topic, decision, reasoning) {
  const issues = [];
  const safeDecision = decision || '';
  const safeReasoning = reasoning || '';
  const decisionUpper = safeDecision.toUpperCase();

  if (safeDecision.trim().length < 10) {
    issues.push('decision too short');
  }

  if (safeReasoning.trim().length < 10) {
    issues.push('reasoning too short');
  }

  if (topic.startsWith('contract_function_')) {
    if (!safeDecision.includes('(') || !safeDecision.includes(')')) {
      issues.push('function signature missing parentheses');
    }
    if (!safeDecision.includes('defined in')) {
      issues.push('function signature missing file context');
    }
  } else if (topic.startsWith('contract_sql_')) {
    if (!decisionUpper.includes('CREATE TABLE') && !decisionUpper.includes('ALTER TABLE')) {
      issues.push('sql schema missing CREATE TABLE or ALTER TABLE');
    }
  } else if (topic.startsWith('contract_type_') || topic.startsWith('contract_graphql_')) {
    if (!safeDecision.includes('{') || !safeDecision.includes('}')) {
      issues.push('type definition missing braces');
    }
  } else if (
    CONTRACT_HTTP_METHODS.some((method) => topic.startsWith(`contract_${method.toLowerCase()}_`))
  ) {
    if (!CONTRACT_HTTP_METHODS.some((method) => decisionUpper.includes(method))) {
      issues.push('api endpoint missing HTTP method');
    }
    if (!safeDecision.includes('/')) {
      issues.push('api endpoint missing path');
    }
  }

  return {
    valid: issues.length === 0,
    issues,
  };
}

function normalizeDecisionText(text) {
  if (!text) {
    return '';
  }
  return text.replace(/\s+/g, ' ').trim().toLowerCase();
}

function extractFileHint(decision, reasoning) {
  const sources = [decision, reasoning].filter(Boolean);
  for (const source of sources) {
    const match = source.match(/defined in\s+([^\s,]+)/i) || source.match(/from\s+([^\s,]+)/i);
    if (match && match[1]) {
      return match[1];
    }
  }
  return null;
}

function buildContractTrustContext(decision, reasoning) {
  const fileHint = extractFileHint(decision, reasoning);
  return {
    source: {
      file: fileHint || 'unknown',
      line: '?',
      author: 'haiku',
      timestamp: Date.now(),
    },
    causality: {
      impact: 'Auto-extracted by LLM from code changes; verify before use.',
    },
    verification: {
      test_file: null,
      result: 'not_verified',
    },
    context_match: {
      user_intent: 'contract extraction',
    },
  };
}

/**
 * Save decision tool definition
 */
const saveDecisionTool = {
  name: 'save_decision',
  description:
    "Save a decision or insight to MAMA's memory for future reference. Use this when the user explicitly wants to remember something important (e.g., architectural decisions, parameter choices, lessons learned). The decision will be stored with semantic embeddings for later retrieval.\n\n⚡ IMPORTANT - Graph Connectivity: Reuse the SAME topic name for related decisions to create decision graphs (supersedes/refines/contradicts edges). Example: Use 'auth_strategy' for all authentication decisions, not 'auth_strategy_v1', 'auth_strategy_v2'. This enables Learn/Unlearn/Relearn workflows.",
  inputSchema: {
    type: 'object',
    properties: {
      topic: {
        type: 'string',
        description:
          "Decision topic identifier (e.g., 'auth_strategy', 'mesh_detail_choice'). Use lowercase with underscores. Max 200 characters.\n\n⚡ REUSE SAME TOPIC for related decisions to create supersedes edges.",
      },
      decision: {
        type: 'string',
        description:
          "The decision made (e.g., 'Use JWT with refresh tokens'). Max 2000 characters.",
      },
      reasoning: {
        type: 'string',
        description:
          'Why this decision was made. This is REQUIRED - never leave empty. Explain the context, alternatives considered, and rationale. Max 5000 characters.',
      },
      confidence: {
        type: 'number',
        description:
          'Confidence score 0.0-1.0. Use 0.9 for high confidence, 0.8 for medium, 0.5 for experimental. Default: 0.5',
        minimum: 0,
        maximum: 1,
      },
      type: {
        type: 'string',
        enum: ['user_decision', 'assistant_insight'],
        description:
          "'user_decision' if user explicitly decided, 'assistant_insight' if this is Claude's suggestion. Default: 'user_decision'",
      },
      outcome: {
        type: 'string',
        enum: ['pending', 'success', 'failure', 'partial', 'superseded'],
        description:
          "Decision outcome status. Use 'pending' for new decisions (default), 'success' when confirmed working, 'failure' when approach failed.",
      },
    },
    required: ['topic', 'decision', 'reasoning'],
  },

  async handler(params, _context) {
    const {
      topic,
      decision,
      reasoning,
      confidence = 0.5,
      type = 'user_decision',
      outcome = 'pending',
    } = params || {};

    try {
      // Validation
      if (!topic || !decision || !reasoning) {
        return {
          success: false,
          message: '❌ Validation error: topic, decision, and reasoning are required',
        };
      }

      if (topic.length > 200 || decision.length > 2000 || reasoning.length > 5000) {
        return {
          success: false,
          message:
            '❌ Validation error: Field length exceeded (topic≤200, decision≤2000, reasoning≤5000)',
        };
      }

      let contractWarning = null;
      let contractSkipId = null;
      let trustContext = null;

      if (isContractTopic(topic)) {
        const validation = validateContractDecision(topic, decision, reasoning);
        if (!validation.valid) {
          return {
            success: false,
            message: `❌ Validation error: contract decision seems malformed (${validation.issues.join(
              ', '
            )})`,
          };
        }

        trustContext = buildContractTrustContext(decision, reasoning);

        try {
          const recallResult = await mama.recall(topic);
          const existing = recallResult?.supersedes_chain?.[0];
          if (existing?.decision) {
            const incoming = normalizeDecisionText(decision);
            const current = normalizeDecisionText(existing.decision);
            if (incoming && incoming === current) {
              contractSkipId = existing.id;
              contractWarning = 'Duplicate contract detected; skipping save.';
            } else if (incoming && current) {
              contractWarning =
                'Existing contract with same topic differs; verify this is an intentional update.';
            }
          }
        } catch (error) {
          // Non-fatal: proceed without dedupe if recall fails
        }
      }

      if (contractSkipId) {
        return {
          success: true,
          decision_id: contractSkipId,
          topic: topic,
          message: `⚠️ Duplicate contract detected; skipping save (ID: ${contractSkipId})`,
          recall_command: `To recall: mama.recall('${topic}')`,
          warning: contractWarning,
        };
      }

      // Call MAMA API (mama.save returns decision ID as string, not object)
      const decisionId = await mama.save({
        topic,
        decision,
        reasoning,
        confidence,
        type, // Pass type instead of user_involvement
        outcome,
        trust_context: trustContext,
      });

      return {
        success: true,
        decision_id: decisionId,
        topic: topic,
        message: `✅ Decision saved successfully (ID: ${decisionId})`,
        recall_command: `To recall: mama.recall('${topic}')`,
        ...(contractWarning && { warning: contractWarning }),
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
      return {
        success: false,
        message: `❌ Failed to save decision: ${errorMessage}`,
      };
    }
  },
};

module.exports = { saveDecisionTool };
