import { loadConfig, saveConfig } from '../cli/config/config-manager.js';

interface SetupTool {
  name: string;
  description: string;
  input_schema: {
    type: 'object';
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    properties: Record<string, any>;
    required: string[];
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handler: (input: any) => Promise<any>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function createSetupTools(clientInfo: any): SetupTool[] {
  return [
    {
      name: 'update_config',
      description: 'Update MAMA configuration file (config.yaml)',
      input_schema: {
        type: 'object',
        properties: {
          key: {
            type: 'string',
            description: 'Configuration key (dot notation, e.g., "discord.token")',
          },
          value: {
            description: 'Value to set (string, number, boolean, etc.)',
          },
        },
        required: ['key', 'value'],
      },
      handler: async (input) => {
        const { key, value } = input;

        const config = await loadConfig();

        const keys = key.split('.');
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let current: any = config;

        for (let i = 0; i < keys.length - 1; i++) {
          if (!current[keys[i]]) {
            current[keys[i]] = {};
          }
          current = current[keys[i]];
        }

        current[keys[keys.length - 1]] = value;

        await saveConfig(config);

        clientInfo.ws.send(
          JSON.stringify({
            type: 'config_updated',
            key,
            value,
          })
        );

        return { success: true, key, value };
      },
    },

    {
      name: 'validate_discord_token',
      description: 'Validate a Discord bot token and get client ID',
      input_schema: {
        type: 'object',
        properties: {
          token: {
            type: 'string',
            description: 'Discord bot token to validate',
          },
        },
        required: ['token'],
      },
      handler: async (input) => {
        const { token } = input;

        try {
          const response = await fetch('https://discord.com/api/v10/users/@me', {
            headers: {
              Authorization: `Bot ${token}`,
            },
          });

          if (!response.ok) {
            return {
              valid: false,
              error: `Invalid token (HTTP ${response.status})`,
            };
          }

          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const data: any = await response.json();

          return {
            valid: true,
            client_id: data.id as string,
            username: data.username as string,
          };
        } catch (error) {
          return {
            valid: false,
            error: error instanceof Error ? error.message : 'Network error',
          };
        }
      },
    },

    {
      name: 'mark_setup_complete',
      description: 'Mark setup as complete and close the wizard',
      input_schema: {
        type: 'object',
        properties: {},
        required: [],
      },
      handler: async () => {
        clientInfo.ws.send(
          JSON.stringify({
            type: 'setup_complete',
          })
        );

        return { success: true };
      },
    },
  ];
}
