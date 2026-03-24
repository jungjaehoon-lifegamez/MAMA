const mama = require('@jungjaehoon/mama-core/mama-api');

const TOOL_DEFINITION = {
  name: 'mama_ingest',
  description:
    'Ingest raw content into MAMA memory v2. Use for conversations, summaries, and other unstructured input that should become scoped memory.',
  inputSchema: {
    type: 'object',
    properties: {
      content: {
        type: 'string',
        description: 'Raw content to ingest into memory.',
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
        description: 'Optional memory scopes such as project, channel, user, or global.',
      },
      source: {
        type: 'object',
        description: 'Optional source metadata.',
      },
    },
    required: ['content'],
  },
};

async function execute(input = {}) {
  const { content, scopes = [], source = {} } = input;
  if (!content || typeof content !== 'string') {
    return { success: false, error: 'content is required and must be a string' };
  }

  const result = await mama.ingestMemory({
    content,
    scopes,
    source: {
      package: 'mcp-server',
      source_type: 'mama_ingest',
      ...source,
    },
  });

  return {
    success: true,
    ...result,
  };
}

module.exports = { TOOL_DEFINITION, execute };
