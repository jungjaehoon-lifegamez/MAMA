/**
 * mama_profile — Get user profile: long-term preferences, tech stack, role.
 * Returns all is_static=1, superseded_by IS NULL decisions.
 */

const TOOL_DEFINITION = {
  name: 'mama_profile',
  description:
    'Get user profile summary: long-term preferences, tech stack, role, coding style. Returns decisions marked as static (long-term) preferences.',
  inputSchema: {
    type: 'object',
    properties: {
      limit: { type: 'number', description: 'Max results. Default: 10' },
    },
  },
};

async function execute(input) {
  const limit = input?.limit || 10;
  try {
    const { getAdapter } = require('@jungjaehoon/mama-core/db-manager');
    const adapter = getAdapter();
    const results = adapter
      .prepare(
        `
      SELECT id, topic, decision, reasoning, confidence, created_at
      FROM decisions
      WHERE is_static = 1 AND superseded_by IS NULL
      ORDER BY confidence DESC, created_at DESC
      LIMIT ?
    `
      )
      .all(limit);

    return {
      success: true,
      count: results.length,
      profile: results,
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

module.exports = { TOOL_DEFINITION, execute };
