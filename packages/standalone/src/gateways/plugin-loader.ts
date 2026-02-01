/**
 * Gateway Plugin Loader
 *
 * Discovers and loads gateway plugins from ~/.mama/plugins/
 * Each plugin is a directory with:
 * - plugin.json (manifest)
 * - index.ts or index.js (entry point)
 */

import { existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { pathToFileURL } from 'url';
import type {
  PluginManifest,
  PluginApi,
  PluginLogger,
  LoadedPlugin,
  Gateway,
  GatewayPluginModule,
  MessageHandler,
  AgentLoopInterface,
  MessageSource,
} from './types.js';

/**
 * Plugin loader configuration
 */
export interface PluginLoaderConfig {
  /** Plugin directory (default: ~/.mama/plugins) */
  pluginsDir?: string;
  /** Gateway configurations from main config */
  gatewayConfigs?: Record<string, unknown>;
  /** Agent loop instance */
  agentLoop?: AgentLoopInterface;
}

/**
 * Plugin Loader class
 */
export class PluginLoader {
  private readonly pluginsDir: string;
  private readonly gatewayConfigs: Record<string, unknown>;
  private readonly agentLoop?: AgentLoopInterface;
  private readonly plugins: Map<string, LoadedPlugin> = new Map();
  private readonly messageHandlers: Map<string, MessageHandler[]> = new Map();

  constructor(config: PluginLoaderConfig = {}) {
    const homeDir = process.env.HOME || process.env.USERPROFILE || '';
    this.pluginsDir = config.pluginsDir || join(homeDir, '.mama', 'plugins');
    this.gatewayConfigs = config.gatewayConfigs || {};
    this.agentLoop = config.agentLoop;
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

    const entryPath = join(plugin.path, plugin.manifest.main);
    if (!existsSync(entryPath)) {
      console.error(`[PluginLoader] Entry point not found: ${entryPath}`);
      return null;
    }

    try {
      // Create plugin API
      const api = this.createPluginApi(pluginId);

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
  private createPluginApi(pluginId: string): PluginApi {
    // Note: plugin info is available via this.plugins.get(pluginId)
    const handlers: MessageHandler[] = [];
    this.messageHandlers.set(pluginId, handlers);

    const logger = this.createLogger(pluginId);

    return {
      logger,

      getConfig: <T = unknown>(): T | undefined => {
        return this.gatewayConfigs[pluginId] as T | undefined;
      },

      getAgentLoop: (): AgentLoopInterface => {
        if (!this.agentLoop) {
          throw new Error('Agent loop not available');
        }
        return this.agentLoop;
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
export function createPluginLoader(config?: PluginLoaderConfig): PluginLoader {
  return new PluginLoader(config);
}
