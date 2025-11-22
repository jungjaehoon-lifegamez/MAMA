const { saveCheckpoint, loadCheckpoint } = require('../mama/mama-api');

const saveCheckpointTool = {
  name: 'save_checkpoint',
  description: 'Save the current session state (checkpoint) to MAMA memory. Use this when ending a session or reaching a major milestone so work can be resumed later.',
  inputSchema: {
    type: 'object',
    properties: {
      summary: {
        type: 'string',
        description: 'Summary of the current session state, what was accomplished, and what is pending.',
      },
      open_files: {
        type: 'array',
        items: { type: 'string' },
        description: 'List of currently relevant or open files.',
      },
      next_steps: {
        type: 'string',
        description: 'Clear instructions for the next session on what to do next.',
      },
    },
    required: ['summary'],
  },
  handler: async (args) => {
    const { summary, open_files, next_steps } = args;
    const id = await saveCheckpoint(summary, open_files, next_steps);
    return {
      content: [
        {
          type: 'text',
          text: `✅ Checkpoint saved (ID: ${id})\nSummary: ${summary}`,
        },
      ],
    };
  },
};

const loadCheckpointTool = {
  name: 'load_checkpoint',
  description: 'Load the latest active session checkpoint. Use this at the start of a new session to resume work seamlessly.',
  inputSchema: {
    type: 'object',
    properties: {},
  },
  handler: async () => {
    const checkpoint = await loadCheckpoint();
    if (!checkpoint) {
      return {
        content: [
          {
            type: 'text',
            text: 'ℹ️ No active checkpoint found.',
          },
        ],
      };
    }
    
    return {
      content: [
        {
          type: 'text',
          text: `🔄 Resuming Session (from ${new Date(checkpoint.timestamp).toLocaleString()})\n\n` +
                `📝 Summary: ${checkpoint.summary}\n` +
                `📂 Files: ${JSON.stringify(checkpoint.open_files)}\n` +
                `👉 Next Steps: ${checkpoint.next_steps || 'None'}`,
        },
      ],
    };
  },
};

module.exports = {
  saveCheckpointTool,
  loadCheckpointTool,
};
