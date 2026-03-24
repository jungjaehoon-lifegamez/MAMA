/**
 * mama_add — Auto-extract and save facts from conversation content.
 *
 * Memory extraction is now handled by the memory agent persistent process.
 * In MCP server context (not standalone), this tool returns a message directing
 * users to use mama_save for manual saving.
 */

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

  // mama_add is now handled by the memory agent persistent process.
  // In MCP server context (not standalone), fall back to direct mama.save().
  return {
    success: true,
    message:
      'Content received. Memory agent will extract facts automatically. Use mama_save for manual saving.',
  };
}

module.exports = { TOOL_DEFINITION, execute };
