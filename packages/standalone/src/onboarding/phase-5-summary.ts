/**
 * Phase 5: Discovery Summary Tool
 *
 * Aggregates insights from previous onboarding phases and presents
 * findings to the user. Acts as a MANDATORY gate before Phase 6.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { expandPath } from '../cli/config/config-manager.js';
import { completePhase, recordFileCreated } from './onboarding-state.js';

interface SummaryToolInput {
  confirmed?: boolean;
  additional_notes?: string;
}

interface Tool {
  name: string;
  description: string;
  input_schema: {
    type: 'object';
    properties: Record<string, any>;
    required: string[];
  };
  handler: (input: any) => Promise<any>;
}

async function aggregateInsights(): Promise<{
  identity?: string;
  user?: string;
  soul?: string;
  bootstrap?: string;
  files: string[];
}> {
  const insights: any = { files: [] };
  const mamaHome = expandPath('~/.mama');

  const profileFiles = [
    { key: 'identity', file: 'IDENTITY.md' },
    { key: 'user', file: 'USER.md' },
    { key: 'soul', file: 'SOUL.md' },
    { key: 'bootstrap', file: 'BOOTSTRAP.md' },
  ];

  for (const { key, file } of profileFiles) {
    const filePath = `${mamaHome}/${file}`;
    if (existsSync(filePath)) {
      try {
        const content = await readFile(filePath, 'utf-8');
        insights[key] = content;
        insights.files.push(file);
      } catch (error) {
        console.error(`Failed to read ${file}:`, error);
      }
    }
  }

  return insights;
}

function formatSummary(insights: any): string {
  const { identity, user, soul, bootstrap, files } = insights;

  let summary = `# 🎯 Discovery Summary\n\n`;
  summary += `Based on your previous responses, here's what we've learned:\n\n`;

  summary += `## 📂 Profile Files Found\n\n`;
  if (files.length === 0) {
    summary += `No profile files found yet. This is the first time we're creating your profile.\n\n`;
  } else {
    summary += files.map((f: string) => `- ✅ ${f}`).join('\n') + '\n\n';
  }

  if (identity) {
    summary += `## 🪪 Identity\n\n`;
    summary += `${identity.substring(0, 500)}${identity.length > 500 ? '...' : ''}\n\n`;
  }

  if (user) {
    summary += `## 👤 User Profile\n\n`;
    summary += `${user.substring(0, 500)}${user.length > 500 ? '...' : ''}\n\n`;
  }

  if (soul) {
    summary += `## ✨ Soul/Personality\n\n`;
    summary += `${soul.substring(0, 500)}${soul.length > 500 ? '...' : ''}\n\n`;
  }

  if (bootstrap) {
    summary += `## 🌱 Bootstrap Context\n\n`;
    summary += `${bootstrap.substring(0, 500)}${bootstrap.length > 500 ? '...' : ''}\n\n`;
  }

  summary += `---\n\n`;
  summary += `**Next Steps:**\n`;
  summary += `1. Review the summary above\n`;
  summary += `2. Confirm if everything looks correct\n`;
  summary += `3. Add any additional notes if needed\n`;
  summary += `4. Proceed to Phase 6\n\n`;
  summary += `**To confirm and save:** Call this tool again with \`confirmed: true\`\n`;

  return summary;
}

async function saveSummary(insights: any, additionalNotes?: string): Promise<void> {
  const mamaHome = expandPath('~/.mama');
  const summaryPath = `${mamaHome}/summary.md`;

  let content = `# Discovery Summary\n\n`;
  content += `*Generated: ${new Date().toISOString()}*\n\n`;

  content += `## Profile Completion Status\n\n`;
  content += `Files created during onboarding:\n\n`;
  content += insights.files.map((f: string) => `- ${f}`).join('\n') + '\n\n';

  if (insights.identity) {
    content += `## Identity\n\n${insights.identity}\n\n`;
  }

  if (insights.user) {
    content += `## User Profile\n\n${insights.user}\n\n`;
  }

  if (insights.soul) {
    content += `## Personality/Soul\n\n${insights.soul}\n\n`;
  }

  if (additionalNotes) {
    content += `## Additional Notes\n\n${additionalNotes}\n\n`;
  }

  content += `---\n\n`;
  content += `*This summary represents the completion of onboarding phases 1-5.*\n`;
  content += `*Ready to proceed to Phase 6.*\n`;

  await writeFile(summaryPath, content, 'utf-8');
}

/**
 * Phase 5 Tool: Present Discovery Summary
 */
export const PHASE_5_TOOL: Tool = {
  name: 'present_discovery_summary',
  description:
    'Aggregate insights from previous onboarding phases, present findings to user, and save summary. MANDATORY gate before Phase 6.',
  input_schema: {
    type: 'object',
    properties: {
      confirmed: {
        type: 'boolean',
        description: 'Set to true to confirm the summary and save to disk',
      },
      additional_notes: {
        type: 'string',
        description: 'Optional additional notes to include in the saved summary',
      },
    },
    required: [],
  },
  handler: async (input: SummaryToolInput) => {
    try {
      const insights = await aggregateInsights();

      if (!input.confirmed) {
        const presentation = formatSummary(insights);
        return {
          success: true,
          message: presentation,
          requires_confirmation: true,
          files_found: insights.files,
        };
      }

      await saveSummary(insights, input.additional_notes);

      // Update onboarding state
      completePhase(5);
      recordFileCreated('summary.md');

      return {
        success: true,
        message: 'Summary saved to ~/.mama/summary.md',
        summary_path: expandPath('~/.mama/summary.md'),
        phase_5_complete: true,
        ready_for_phase_6: true,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error during summary generation',
      };
    }
  },
};
