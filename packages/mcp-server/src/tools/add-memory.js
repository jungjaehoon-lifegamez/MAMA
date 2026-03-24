const mama = require('@jungjaehoon/mama-core/mama-api');

const TOOL_DEFINITION = {
  name: 'mama_add',
  description:
    'Ingest conversation content. MAMA automatically extracts and saves important decisions and facts. Use after completing meaningful tasks. Do NOT use for greetings or trivial chat.',
  inputSchema: {
    type: 'object',
    properties: {
      content: {
        type: 'string',
        description: 'Conversation content or summary to extract facts from',
      },
    },
    required: ['content'],
  },
};

async function execute(input) {
  const { content } = input;
  if (!content || typeof content !== 'string') {
    return { success: false, error: 'content is required and must be a string' };
  }

  const result = await mama.ingestMemory({
    content,
    scopes: [],
    source: {
      package: 'mcp-server',
      source_type: 'mama_add',
    },
  });

  return {
    success: true,
    ...result,
    message: 'Content ingested into memory v2.',
  };
}

module.exports = { TOOL_DEFINITION, execute };
