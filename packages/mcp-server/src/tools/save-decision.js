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

const mama = require('../mama/mama-api.js');

/**
 * Create save decision tool with dependencies
 * @param {Object} mamaApi - MAMA API instance
 */
const createSaveDecisionTool = (mamaApi) => ({
  name: 'save_decision',
  description: `Save your architectural decisions, lessons learned, or insights to MAMA's shared memory.

**WHY USE THIS:**
You are not just an AI assistant; you are a partner in this project. Your insights and reasoning are valuable assets. By saving them here, you allow future agents (including yourself in later sessions) to:
1. Understand *WHY* a decision was made (Reasoning), not just *WHAT* was done.
2. Avoid repeating the same mistakes (Lessons Learned).
3. Build a connected graph of knowledge.

**WHEN TO USE (Be Proactive!):**
- **Decisions**: Whenever you make a significant choice (e.g., "Use SQLite instead of JSON"), save it. Don't wait for the user to ask. If you thought hard about it, it's worth saving.
- **Insights**: If you discover something new ("Ah, this library conflicts with that one"), save it.
- **Requests**: If the user says "Remember this" or "Note that", use this tool immediately.

**EXAMPLES:**
✓ User: "Let's use token bucket" → save(topic="rate_limiter", decision="Token bucket", reasoning="...")
✓ You discover: "Library X conflicts with Y" → save(topic="lib_conflict", decision="Avoid X+Y", reasoning="...")

**COLLABORATION MODES:**
When you find similar past decisions (returned in similar_decisions), choose your approach:
- **build_on**: Extend the existing decision with new insights. Use same topic to create supersedes edge.
- **debate**: Present a counter-argument with evidence. Explain why the prior decision may be wrong.
- **synthesize**: Merge multiple decisions into a new unified approach.

**5-LAYER REASONING (CoT Guide):**
Structure your reasoning with these layers for maximum value:
1. **Context**: What problem/situation prompted this decision?
2. **Evidence**: What proves this works? (tests, benchmarks, prior experience)
3. **Alternatives**: What other options were considered and why rejected?
4. **Risks**: Known limitations or failure modes
5. **Rationale**: Final reasoning that ties it all together

**INSTRUCTIONS:**
1. **Search First**: Before saving, try to search for related past decisions.
2. **Link**: If you find a related decision, mention its ID or topic in the 'reasoning' field to create a mental link.
3. **Reasoning**: Explain your logic clearly so future agents can "empathize" with your decision.`,
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
          'Why this decision was made. This is REQUIRED - never leave empty. Explain the context, alternatives considered, and rationale. IMPORTANT: Use English for better semantic search and relationship detection (e.g., use "instead of", "contrary to", "replaces" for conflicting decisions). Max 5000 characters.',
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
        description: "Outcome status. Default: 'pending'",
      },
      evidence: {
        type: 'array',
        items: { type: 'string' },
        description: 'Evidence supporting the decision (e.g., file paths, logs, metrics).',
      },
      alternatives: {
        type: 'array',
        items: { type: 'string' },
        description: 'Alternative options considered but rejected (Tension layer).',
      },
      risks: {
        type: 'string',
        description: 'Potential risks or downsides (Tension layer).',
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
      evidence,
      alternatives,
      risks,
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

      // Call MAMA API (mama.save will handle outcome mapping to DB format)
      // Story 1.1/1.2: save() now returns enhanced response object
      const result = await mamaApi.save({
        topic,
        decision,
        reasoning,
        confidence,
        type,
        outcome,
        evidence,
        alternatives,
        risks,
      });

      // Story 1.2: Return enhanced response with collaborative fields
      return {
        success: result.success,
        decision_id: result.id,
        topic: topic,
        message: `✅ Decision saved successfully (ID: ${result.id})`,
        recall_command: `To recall: mama.recall('${topic}')`,
        // Story 1.1/1.2: Collaborative fields (optional)
        ...(result.similar_decisions && { similar_decisions: result.similar_decisions }),
        ...(result.warning && { warning: result.warning }),
        ...(result.collaboration_hint && { collaboration_hint: result.collaboration_hint }),
        ...(result.reasoning_graph && { reasoning_graph: result.reasoning_graph }),
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
      return {
        success: false,
        message: `❌ Failed to save decision: ${errorMessage}`,
      };
    }
  },
});

// Default instance with real dependency
const saveDecisionTool = createSaveDecisionTool(mama);

module.exports = { saveDecisionTool, createSaveDecisionTool };
