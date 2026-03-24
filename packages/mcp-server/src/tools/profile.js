const mama = require('@jungjaehoon/mama-core/mama-api');

const TOOL_DEFINITION = {
  name: 'mama_profile',
  description:
    'Get user profile summary for memory v2. Returns static profile, dynamic profile, and evidence.',
  inputSchema: {
    type: 'object',
    properties: {
      limit: { type: 'number', description: 'Max results. Default: 10' },
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
    },
  },
};

async function execute(input) {
  const limit = input?.limit || 10;
  const scopes = input?.scopes || [];
  try {
    const profile = await mama.buildProfile(scopes);

    return {
      success: true,
      count: profile.static.length + profile.dynamic.length,
      profile: {
        static: profile.static.slice(0, limit),
        dynamic: profile.dynamic.slice(0, limit),
        evidence: profile.evidence.slice(0, limit),
      },
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

module.exports = { TOOL_DEFINITION, execute };
