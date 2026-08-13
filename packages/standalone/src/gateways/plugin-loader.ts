/**
 * Gateway Plugin Loader
 *
 * Discovers and loads gateway plugins from ~/.mama/plugins/
 * Each plugin is a directory with:
 * - plugin.json (manifest)
 * - index.ts or index.js (entry point)
 */

import { existsSync, readdirSync, readFileSync } from 'fs';
import { join, resolve, sep } from 'path';
import { pathToFileURL } from 'url';
import type {
  PluginManifest,
  PluginApi,
  PluginLogger,
  LoadedPlugin,
  Gateway,
  GatewayPluginModule,
  MessageHandler,
  MessageSource,
  PluginInboundInput,
  PluginInboundResult,
} from './types.js';
import type { TurnProcessor } from './turn-contract.js';
import { resolveConnectorPrincipal } from './principal.js';

const PLUGIN_MESSAGE_SOURCES: ReadonlySet<string> = new Set<MessageSource>([
  'discord',
  'slack',
  'telegram',
  'chatwork',
  'mobile',
  'viewer',
  'system',
]);

function isMessageSource(value: unknown): value is MessageSource {
  return typeof value === 'string' && PLUGIN_MESSAGE_SOURCES.has(value);
}

function assertInboundInput(input: PluginInboundInput): void {
  if (!input || typeof input !== 'object') {
    throw new Error('Plugin processInbound input must be an object');
  }
  if (typeof input.channelId !== 'string' || input.channelId.length === 0) {
    throw new Error('Plugin processInbound channelId must be a non-empty string');
  }
  if (typeof input.userId !== 'string' || input.userId.length === 0) {
    throw new Error('Plugin processInbound userId must be a non-empty string');
  }
  if (typeof input.text !== 'string') {
    throw new Error('Plugin processInbound text must be a string');
  }
  if (input.contentBlocks !== undefined && !Array.isArray(input.contentBlocks)) {
    throw new Error('Plugin processInbound contentBlocks must be an array');
  }
  if (
    input.metadata !== undefined &&
    (typeof input.metadata !== 'object' || input.metadata === null || Array.isArray(input.metadata))
  ) {
    throw new Error('Plugin processInbound metadata must be an object');
  }
}

/**
 * Plugin loader configuration
 */
export interface PluginLoaderConfig {
  /** Plugin directory (default: ~/.mama/plugins) */
  pluginsDir?: string;
  /** Gateway configurations from main config */
  gatewayConfigs?: Record<string, unknown>;
  /** Host-owned turn processor. Never exposed directly to plugins. */
  turnProcessor: TurnProcessor;
  /** Owner IDs resolved from host connector configuration, keyed by manifest source ID. */
  ownerUserIdsBySource?: Readonly<Partial<Record<MessageSource, string | undefined>>>;
}

/**
 * Plugin Loader class
 */
export class PluginLoader {
  private readonly pluginsDir: string;
  private readonly gatewayConfigs: Record<string, unknown>;
  private readonly turnProcessor: TurnProcessor;
  private readonly ownerUserIdsBySource: Readonly<
    Partial<Record<MessageSource, string | undefined>>
  >;
  private readonly plugins: Map<string, LoadedPlugin> = new Map();
  private readonly messageHandlers: Map<string, MessageHandler[]> = new Map();

  constructor(config: PluginLoaderConfig) {
    const homeDir = process.env.HOME || process.env.USERPROFILE || '';
    this.pluginsDir = config.pluginsDir || join(homeDir, '.mama', 'plugins');
    this.gatewayConfigs = config.gatewayConfigs || {};
    this.turnProcessor = config.turnProcessor;
    this.ownerUserIdsBySource = config.ownerUserIdsBySource ?? {};
  }

  /**
   * Discover all plugins in the plugins directory
   */
  async discover(): Promise<PluginManifest[]> {
    const manifests: PluginManifest[] = [];

    if (!existsSync(this.pluginsDir)) {
      console.log(`[PluginLoader] Plugins directory not found: ${this.pluginsDir}`);
      return manifests;
    }

    const entries = readdirSync(this.pluginsDir, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const pluginDir = join(this.pluginsDir, entry.name);
      const manifestPath = join(pluginDir, 'plugin.json');

      if (!existsSync(manifestPath)) {
        console.warn(`[PluginLoader] No plugin.json in ${entry.name}, skipping`);
        continue;
      }

      try {
        const manifestContent = readFileSync(manifestPath, 'utf-8');
        const manifest = JSON.parse(manifestContent) as PluginManifest;

        // Validate required fields
        if (!manifest.id || !manifest.name || !manifest.main) {
          console.warn(`[PluginLoader] Invalid manifest in ${entry.name}: missing required fields`);
          continue;
        }

        // Validate plugin ID to prevent path traversal via crafted IDs
        if (!/^[a-zA-Z0-9_-]+$/.test(manifest.id)) {
          console.warn(
            `[PluginLoader] Invalid plugin id "${manifest.id}" in ${entry.name}: must match /^[a-zA-Z0-9_-]+$/`
          );
          continue;
        }

        manifests.push(manifest);

        // Store plugin info
        this.plugins.set(manifest.id, {
          manifest,
          path: pluginDir,
          enabled: this.isPluginEnabled(manifest.id),
        });

        console.log(`[PluginLoader] Discovered plugin: ${manifest.name} (${manifest.id})`);
      } catch (err) {
        console.error(`[PluginLoader] Failed to load manifest from ${entry.name}:`, err);
      }
    }

    return manifests;
  }

  /**
   * Check if a plugin is enabled in config
   */
  private isPluginEnabled(pluginId: string): boolean {
    const config = this.gatewayConfigs[pluginId] as { enabled?: boolean } | undefined;
    return config?.enabled !== false; // Enabled by default
  }

  /**
   * Load and register a plugin
   */
  async loadPlugin(pluginId: string): Promise<Gateway | null> {
    const plugin = this.plugins.get(pluginId);
    if (!plugin) {
      console.error(`[PluginLoader] Plugin not found: ${pluginId}`);
      return null;
    }

    if (!plugin.enabled) {
      console.log(`[PluginLoader] Plugin disabled: ${pluginId}`);
      return null;
    }

    if (!Number.isInteger(plugin.manifest.apiVersion) || plugin.manifest.apiVersion < 2) {
      throw new Error(
        `Plugin ${pluginId} requires manifest apiVersion >= 2; received ${String(plugin.manifest.apiVersion)}`
      );
    }

    const sourceId = plugin.manifest.gateway?.sourceId;
    if (!isMessageSource(sourceId)) {
      throw new Error(`Plugin ${pluginId} has an unsupported gateway sourceId: ${String(sourceId)}`);
    }

    const entryPath = join(plugin.path, plugin.manifest.main);

    // Prevent path traversal: ensure entryPath stays within the plugin directory
    const resolvedEntry = resolve(entryPath);
    const resolvedPluginDir = resolve(plugin.path) + sep;
    if (!resolvedEntry.startsWith(resolvedPluginDir)) {
      console.error(
        `[PluginLoader] Path traversal detected in plugin ${pluginId}: ${plugin.manifest.main}`
      );
      return null;
    }

    if (!existsSync(entryPath)) {
      console.error(`[PluginLoader] Entry point not found: ${entryPath}`);
      return null;
    }

    try {
      // Create plugin API
      const api = this.createPluginApi(pluginId, sourceId);

      // Dynamic import of plugin module
      const moduleUrl = pathToFileURL(entryPath).href;
      const module = (await import(moduleUrl)) as {
        default?: GatewayPluginModule;
      } & GatewayPluginModule;

      // Get the plugin module (handle both default export and named export)
      const pluginModule = module.default || module;

      if (!pluginModule.register || typeof pluginModule.register !== 'function') {
        console.error(`[PluginLoader] Plugin ${pluginId} has no register function`);
        return null;
      }

      // Register the plugin and get gateway instance
      const gateway = await pluginModule.register(api);
      plugin.gateway = gateway;

      console.log(`[PluginLoader] Loaded plugin: ${plugin.manifest.name}`);
      return gateway;
    } catch (err) {
      console.error(`[PluginLoader] Failed to load plugin ${pluginId}:`, err);
      return null;
    }
  }

  /**
   * Load all discovered plugins
   */
  async loadAll(): Promise<Gateway[]> {
    const gateways: Gateway[] = [];

    for (const [pluginId] of this.plugins) {
      const gateway = await this.loadPlugin(pluginId);
      if (gateway) {
        gateways.push(gateway);
      }
    }

    return gateways;
  }

  /**
   * Create the API object for a plugin
   */
  private createPluginApi(pluginId: string, sourceId: MessageSource): PluginApi {
    // Note: plugin info is available via this.plugins.get(pluginId)
    const handlers: MessageHandler[] = [];
    this.messageHandlers.set(pluginId, handlers);

    const logger = this.createLogger(pluginId);

    return {
      logger,

      getConfig: <T = unknown>(): T | undefined => {
        return this.gatewayConfigs[pluginId] as T | undefined;
      },

      processInbound: async (input: PluginInboundInput): Promise<PluginInboundResult> => {
        assertInboundInput(input);
        const principal = resolveConnectorPrincipal({
          connector: sourceId,
          namespace: input.channelId,
          userId: input.userId,
          ownerUserId: this.ownerUserIdsBySource[sourceId],
          isDirectMessage: false,
        });
        if (principal.lane === 'divert') {
          return {};
        }

        const result = await this.turnProcessor.processTurn({
          source: sourceId,
          channelId: input.channelId,
          userId: input.userId,
          text: input.text,
          principal: Object.freeze({ ...principal, consoleEligible: false }),
          ...(input.contentBlocks === undefined ? {} : { contentBlocks: input.contentBlocks }),
          ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
        });
        return result.outcome === 'external_divert' ? {} : { response: result.response };
      },

      onMessage: (handler: MessageHandler): void => {
        handlers.push(handler);
      },

      sendResponse: async (_channelId: string, _text: string, _metadata?): Promise<void> => {
        // This will be overridden by the gateway implementation
        logger.warn(`sendResponse not implemented for ${pluginId}`);
      },
    };
  }

  /**
   * Create a logger for a plugin
   */
  private createLogger(pluginId: string): PluginLogger {
    const prefix = `[${pluginId}]`;
    return {
      info: (message: string, ...args: unknown[]) => console.log(prefix, message, ...args),
      warn: (message: string, ...args: unknown[]) => console.warn(prefix, message, ...args),
      error: (message: string, ...args: unknown[]) => console.error(prefix, message, ...args),
      debug: (message: string, ...args: unknown[]) => console.debug(prefix, message, ...args),
    };
  }

  /**
   * Get all loaded gateways
   */
  getGateways(): Gateway[] {
    const gateways: Gateway[] = [];
    for (const plugin of this.plugins.values()) {
      if (plugin.gateway) {
        gateways.push(plugin.gateway);
      }
    }
    return gateways;
  }

  /**
   * Get a specific gateway by source ID
   */
  getGateway(source: MessageSource): Gateway | undefined {
    for (const plugin of this.plugins.values()) {
      if (plugin.gateway?.source === source) {
        return plugin.gateway;
      }
    }
    return undefined;
  }

  /**
   * Get all discovered plugins
   */
  getPlugins(): LoadedPlugin[] {
    return Array.from(this.plugins.values());
  }

  /**
   * Stop all gateways
   */
  async stopAll(): Promise<void> {
    for (const plugin of this.plugins.values()) {
      if (plugin.gateway?.isConnected()) {
        await plugin.gateway.stop();
      }
    }
  }
}

/**
 * Create a plugin loader instance
 */
export function createPluginLoader(config: PluginLoaderConfig): PluginLoader {
  return new PluginLoader(config);
}
