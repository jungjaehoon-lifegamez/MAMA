/**
 * MCP Tool: case_timeline_range
 *
 * Thin MCP wrapper around mama-core caseTimelineRange().
 */

const { caseTimelineRange } = require('@jungjaehoon/mama-core');
const { initDB, getAdapter } = require('@jungjaehoon/mama-core/db-manager');

let adapterOverrideForTest = null;

const caseTimelineRangeTool = {
  name: 'case_timeline_range',
  description:
    'Return a bounded, chronological timeline for a case. Includes decision, event, observation, and artifact memberships resolved through canonical case chains.',
  inputSchema: {
    type: 'object',
    properties: {
      case_id: {
        type: 'string',
        description: 'Case UUID to read. Merged cases resolve through their canonical case chain.',
      },
      from: {
        oneOf: [{ type: 'string' }, { type: 'number' }],
        description: 'Optional inclusive lower date bound. ISO 8601 string or epoch milliseconds.',
      },
      to: {
        oneOf: [{ type: 'string' }, { type: 'number' }],
        description: 'Optional inclusive upper date bound. ISO 8601 string or epoch milliseconds.',
      },
      order: {
        type: 'string',
        enum: ['asc', 'desc'],
        description: "Timeline order. Default: 'asc'.",
      },
      limit: {
        type: 'number',
        minimum: 0,
        maximum: 500,
        description: 'Maximum items to return. Default: 100. Maximum: 500.',
      },
      include_connector_enrichments: {
        type: 'boolean',
        description: 'Include connector event snapshots for observations/artifacts when available.',
      },
    },
    required: ['case_id'],
  },

  async handler(args) {
    const adapter = await getCaseTimelineRangeAdapter();
    return caseTimelineRange(adapter, args || {});
  },
};

async function getCaseTimelineRangeAdapter() {
  if (adapterOverrideForTest) {
    return adapterOverrideForTest;
  }

  await initDB();
  return getAdapter();
}

function setCaseTimelineRangeAdapterForTest(adapter) {
  adapterOverrideForTest = adapter;
}

function resetCaseTimelineRangeAdapterForTest() {
  adapterOverrideForTest = null;
}

module.exports = {
  caseTimelineRangeTool,
  setCaseTimelineRangeAdapterForTest,
  resetCaseTimelineRangeAdapterForTest,
};
