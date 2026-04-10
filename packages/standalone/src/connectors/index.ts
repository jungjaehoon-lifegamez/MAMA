export * from './framework/index.js';

export const AVAILABLE_CONNECTORS = [
  'slack',
  'telegram',
  'discord',
  'chatwork',
  'gmail',
  'calendar',
  'notion',
  'obsidian',
  'kagemusha',
  'sheets',
  'trello',
  'drive',
  'imessage',
  'claude-code',
] as const;

export type AvailableConnector = (typeof AVAILABLE_CONNECTORS)[number];

/**
 * Dynamic connector loader — avoids importing all connector deps at startup.
 * Optionally accepts a ConnectorConfig; if omitted, a minimal disabled config is used
 * (useful for CLI introspection like healthCheck or getAuthRequirements).
 */
export async function loadConnector(
  name: string,
  config?: import('./framework/types.js').ConnectorConfig
): Promise<import('./framework/types.js').IConnector> {
  const mod = await import(`./${name}/index.js`);
  // Find the export that ends with 'Connector'
  const connectorKey = Object.keys(mod).find((k) => k.endsWith('Connector'));
  if (!connectorKey) throw new Error(`No connector class found in module: ${name}`);

  const effectiveConfig: import('./framework/types.js').ConnectorConfig = config ?? {
    enabled: false,
    pollIntervalMinutes: 5,
    channels: {},
    auth: { type: 'none' },
  };

  return new mod[connectorKey](effectiveConfig);
}
