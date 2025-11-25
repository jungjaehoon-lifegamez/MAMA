/**
 * MAMA Memory Tools
 *
 * Story M1.3: MCP Tool Surface Port
 * Story M1.5: update_outcome tool added
 * Story 4.1: generate_quality_report tool added
 * MCP tool wrappers for MAMA's memory system
 *
 * Tools:
 * - save_decision: Save decisions/insights to memory ✅
 * - recall_decision: Retrieve decision history by topic ✅
 * - suggest_decision: Semantic search for relevant decisions ✅
 * - list_decisions: List recent decisions chronologically ✅
 * - update_outcome: Update decision outcome ✅
 * - search_narrative: Semantic search with link expansion ✅
 * - generate_quality_report: Generate coverage and quality metrics report ✅
 * - get_restart_metrics: Get restart success rate and latency metrics ✅
 *
 * @module tools
 */

const { saveDecisionTool } = require('./save-decision.js');
const { recallDecisionTool } = require('./recall-decision.js');
const { suggestDecisionTool } = require('./suggest-decision.js');
const { listDecisionsTool } = require('./list-decisions.js');
const { updateOutcomeTool } = require('./update-outcome.js');
const { saveCheckpointTool, loadCheckpointTool } = require('./checkpoint-tools.js');
const { searchNarrativeTool } = require('./search-narrative.js');
const { generateQualityReportTool, getRestartMetricsTool } = require('./quality-metrics-tools.js');

/**
 * Create all MAMA memory tools
 *
 * Database location: ~/.claude/mama-memory.db (or MAMA_DB_PATH env var)
 *
 * @returns Object with tool definitions
 */
function createMemoryTools() {
  return {
    save_decision: saveDecisionTool,
    recall_decision: recallDecisionTool,
    suggest_decision: suggestDecisionTool,
    list_decisions: listDecisionsTool,
    update_outcome: updateOutcomeTool,
    save_checkpoint: saveCheckpointTool,
    load_checkpoint: loadCheckpointTool,
    search_narrative: searchNarrativeTool,
    generate_quality_report: generateQualityReportTool,
    get_restart_metrics: getRestartMetricsTool,
  };
}

// Export individual tool creators for testing
module.exports = {
  createMemoryTools,
  saveDecisionTool,
  recallDecisionTool,
  suggestDecisionTool,
  listDecisionsTool,
  updateOutcomeTool,
  saveCheckpointTool,
  loadCheckpointTool,
  searchNarrativeTool,
  generateQualityReportTool,
  getRestartMetricsTool,
};
