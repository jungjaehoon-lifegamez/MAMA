const mama = require('@jungjaehoon/mama-core/mama-api');

const TOOL_DEFINITION = {
  name: 'mama_recall',
  description:
    'Recall memory v2 context bundle including scoped memories, graph context, and optional profile information.',
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Query string for relevant memory recall.',
      },
      scopes: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            kind: { type: 'string' },
            id: { type: 'string' },
          },
          required: ['kind', 'id'],
        },
        description: 'Optional scope list.',
      },
      includeProfile: {
        type: 'boolean',
        description: 'Whether to include profile data in the recall bundle.',
      },
      limit: {
        type: 'number',
        description: 'Reserved compatibility option.',
      },
    },
    required: ['query'],
  },
};

async function execute(input = {}) {
  const { query, scopes = [], includeProfile = true } = input;
  if (!query || typeof query !== 'string') {
    return { success: false, error: 'query is required and must be a string' };
  }

  const bundle = await mama.recallMemory(query, {
    scopes,
    includeProfile,
  });

  return {
    success: true,
    bundle,
  };
}

module.exports = { TOOL_DEFINITION, execute };
