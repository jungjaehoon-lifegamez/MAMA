/**
 * MCP Tools: Quality Metrics & Observability (Epic 4)
 *
 * Tools for measuring coverage, quality, restart metrics, and generating quality reports.
 *
 * @module quality-metrics-tools
 */

const mama = require('@jungjaehoon/mama-core/mama-api');

/**
 * Quality Metrics Error Codes
 */
const ERROR_CODES = {
  REPORT_GENERATION_FAILED: 'QM001',
  RESTART_METRICS_FAILED: 'QM002',
  DATA_ACCESS_ERROR: 'QM003',
  CALCULATION_ERROR: 'QM004',
};

/**
 * Generate Quality Report Tool (Story 4.1)
 */
const generateQualityReportTool = {
  name: 'generate_quality_report',
  description: `Generate a comprehensive quality report with coverage and quality metrics.

  Measures:
  - Narrative coverage: % of decisions with complete narrative fields
  - Link coverage: % of decisions with at least one link
  - Narrative quality: Field completeness for evidence, alternatives, risks
  - Link quality: Rich reason ratio (>50 chars) and approved link ratio

  Returns recommendations when metrics fall below thresholds.`,
  inputSchema: {
    type: 'object',
    properties: {
      format: {
        type: 'string',
        enum: ['json', 'markdown'],
        description: 'Output format: "json" (default) or "markdown"',
        default: 'json',
      },
      thresholds: {
        type: 'object',
        description: 'Optional custom thresholds (0-1 scale)',
        properties: {
          narrativeCoverage: {
            type: 'number',
            description: 'Narrative coverage threshold (default: 0.8)',
          },
          linkCoverage: {
            type: 'number',
            description: 'Link coverage threshold (default: 0.7)',
          },
          richReasonRatio: {
            type: 'number',
            description: 'Rich reason ratio threshold (default: 0.7)',
          },
        },
      },
    },
  },
  handler: async (args) => {
    try {
      const report = mama.generateQualityReport(args);

      // Format response based on output format
      if (args.format === 'markdown') {
        return {
          content: [
            {
              type: 'text',
              text: report,
            },
          ],
        };
      }

      // JSON format (default)
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(report, null, 2),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `❌ [${ERROR_CODES.REPORT_GENERATION_FAILED}] Failed to generate quality report: ${error.message}`,
          },
        ],
      };
    }
  },
};

/**
 * Get Restart Metrics Tool (Story 4.2)
 */
const getRestartMetricsTool = {
  name: 'get_restart_metrics',
  description: `Get restart success rate and latency metrics for zero-context restart feature.

  Measures:
  - Success rate: % of successful restart attempts (target: 95%+)
  - Latency percentiles (p50, p95, p99): Response time for full/summary modes
    - Full mode target: p95 < 2500ms (narrative + link expansion)
    - Summary mode target: p95 < 1000ms (summary only)

  Returns metrics for a specified period (24h, 7d, or 30d).`,
  inputSchema: {
    type: 'object',
    properties: {
      period: {
        type: 'string',
        enum: ['24h', '7d', '30d'],
        description: 'Time period for metrics: "24h", "7d" (default), or "30d"',
        default: '7d',
      },
      include_latency: {
        type: 'boolean',
        description: 'Include latency percentiles in response (default: true)',
        default: true,
      },
    },
  },
  handler: async (args) => {
    try {
      const { period = '7d', include_latency = true } = args;

      const metrics = mama.getRestartMetrics(period, include_latency);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(metrics, null, 2),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `❌ [${ERROR_CODES.RESTART_METRICS_FAILED}] Failed to get restart metrics: ${error.message}`,
          },
        ],
      };
    }
  },
};

module.exports = {
  generateQualityReportTool,
  getRestartMetricsTool,
};
