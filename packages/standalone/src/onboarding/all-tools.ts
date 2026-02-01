import { AUTONOMOUS_DISCOVERY_TOOLS } from './autonomous-discovery-tools.js';
import { PHASE_5_TOOL } from './phase-5-summary.js';
import { PHASE_6_TOOL } from './phase-6-security.js';
import { PHASE_7_TOOL, SAVE_INTEGRATION_TOKEN_TOOL } from './phase-7-integrations.js';
import { PHASE_8_TOOL } from './phase-8-demo.js';
import { PHASE_9_TOOL, createPhase9Tool } from './phase-9-finalization.js';
import { loadConfig, saveConfig } from '../cli/config/config-manager.js';
import { writeFile } from 'node:fs/promises';
import { expandPath } from '../cli/config/config-manager.js';
import { completePhase, recordFileCreated } from './onboarding-state.js';

/**
 * Tool definitions only (for reference/documentation)
 * These are used when no handlers are needed
 */
export const ALL_ONBOARDING_TOOLS = [
  ...AUTONOMOUS_DISCOVERY_TOOLS,
  PHASE_5_TOOL,
  PHASE_6_TOOL,
  PHASE_7_TOOL,
  SAVE_INTEGRATION_TOKEN_TOOL,
  PHASE_8_TOOL,
  PHASE_9_TOOL,
];

/**
 * Create all onboarding tools with handlers
 * Used by WebSocket handler to execute tools
 */
export function createAllOnboardingToolsWithHandlers(callbacks?: {
  onOnboardingComplete?: () => void;
}): Array<{
  name: string;
  description: string;
  input_schema: any;
  handler: (input: any) => Promise<any>;
}> {
  const toolsWithHandlers: Array<{
    name: string;
    description: string;
    input_schema: any;
    handler: (input: any) => Promise<any>;
  }> = [];

  // Add discovery tools (already have handlers)
  for (const tool of AUTONOMOUS_DISCOVERY_TOOLS) {
    toolsWithHandlers.push(tool as any);
  }

  // Add phase 5 tool (already has handler)
  toolsWithHandlers.push(PHASE_5_TOOL as any);

  // Add phase 6 tool (already has handler)
  toolsWithHandlers.push(PHASE_6_TOOL as any);

  // Add phase 7 tool with handler
  toolsWithHandlers.push({
    ...PHASE_7_TOOL,
    handler: async (input: any) => {
      const mamaHome = expandPath('~/.mama');
      const integrationsPath = `${mamaHome}/integrations.md`;

      // Generate integrations guide based on role
      const role = input.role || 'custom';
      const selectedIntegrations = (input.selected_integrations || 'discord')
        .split(',')
        .map((s: string) => s.trim());

      let guide = `# Integration Setup Guide\n\n`;
      guide += `*Generated for role: ${role}*\n\n`;
      guide += `## Selected Integrations\n\n`;

      for (const integration of selectedIntegrations) {
        guide += `- ${integration.charAt(0).toUpperCase() + integration.slice(1)}\n`;
      }

      guide += `\n## Setup Instructions\n\n`;
      guide += `See config.yaml for configuration options.\n`;

      await writeFile(integrationsPath, guide, 'utf-8');
      completePhase(7);
      recordFileCreated('integrations.md');

      return {
        success: true,
        message: `Integration guide saved to ${integrationsPath}`,
        role,
        selected_integrations: selectedIntegrations,
      };
    },
  });

  // Add save_integration_token tool with handler
  toolsWithHandlers.push({
    ...SAVE_INTEGRATION_TOKEN_TOOL,
    handler: async (input: any) => {
      const { platform, token, guild_id, chat_id } = input;

      if (!platform || !token) {
        return { success: false, error: 'platform and token are required' };
      }

      try {
        const config = await loadConfig();

        if (platform === 'discord') {
          config.discord = {
            enabled: true,
            token,
            ...(guild_id && { default_guild_id: guild_id }),
          };
        } else if (platform === 'slack') {
          config.slack = {
            enabled: true,
            bot_token: token,
          };
        } else if (platform === 'telegram') {
          config.telegram = {
            enabled: true,
            token,
            ...(chat_id && { allowed_chats: [chat_id] }),
          };
        }

        await saveConfig(config);

        return {
          success: true,
          message: `${platform} token saved to config.yaml`,
          platform,
          enabled: true,
        };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to save token',
        };
      }
    },
  });

  // Add phase 8 tool with handler
  toolsWithHandlers.push({
    ...PHASE_8_TOOL,
    handler: async (input: any) => {
      const { demo_type, skip_demo } = input;

      if (skip_demo) {
        completePhase(8);
        return {
          success: true,
          message: 'Demo phase skipped',
          skipped: true,
        };
      }

      // Demo capabilities - just acknowledge for now
      completePhase(8);
      return {
        success: true,
        message: `Demo ${demo_type || 'general'} capability demonstrated`,
        demo_type: demo_type || 'general',
      };
    },
  });

  // Add phase 9 tool with handler and callback
  const phase9Tool = createPhase9Tool(() => {
    if (callbacks?.onOnboardingComplete) {
      callbacks.onOnboardingComplete();
    }
  });
  toolsWithHandlers.push(phase9Tool);

  return toolsWithHandlers;
}
