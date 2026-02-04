/**
 * Type definitions for Message Gateway system
 */

/**
 * Supported messenger platforms
 */
export type MessageSource = 'discord' | 'slack' | 'telegram' | 'chatwork' | 'mobile' | 'viewer';

/**
 * Content block for multimodal input (OpenClaw-style)
 */
export interface ContentBlock {
  type: 'text' | 'image';
  text?: string;
  localPath?: string; // For image path reference
  source?: {
    type: 'base64';
    media_type: string;
    data: string;
  };
}

/**
 * Normalized message format for cross-platform handling
 */
export interface NormalizedMessage {
  /** Source messenger platform */
  source: MessageSource;
  /** Channel or DM identifier */
  channelId: string;
  /** Human-readable channel name (e.g., "#general", "DM with User") */
  channelName?: string;
  /** User identifier on the platform */
  userId: string;
  /** Message text content */
  text: string;
  /** Multimodal content blocks (images, etc.) */
  contentBlocks?: ContentBlock[];
  /** Platform-specific metadata */
  metadata?: MessageMetadata;
}

/**
 * Message attachment (image, file, etc.)
 */
export interface MessageAttachment {
  /** Attachment type */
  type: 'image' | 'file';
  /** Original URL */
  url: string;
  /** Local file path (after download) */
  localPath?: string;
  /** File name */
  filename: string;
  /** MIME type */
  contentType?: string;
  /** File size in bytes */
  size?: number;
}

/**
 * Platform-specific metadata
 */
export interface MessageMetadata {
  /** Discord guild ID */
  guildId?: string;
  /** Slack thread timestamp */
  threadTs?: string;
  /** User display name */
  username?: string;
  /** Original message ID */
  messageId?: string;
  /** Message attachments */
  attachments?: MessageAttachment[];
  /** Telegram chat type (private, group, supergroup, channel) */
  chatType?: string;
  /** Channel history context (OpenClaw-style) */
  historyContext?: string;
  /** Session ID (for WebSocket/viewer) */
  sessionId?: string;
  /** OS Agent mode flag */
  osAgentMode?: boolean;
}

/**
 * Session data for messenger conversations
 */
export interface Session {
  /** Unique session ID */
  id: string;
  /** Source platform */
  source: MessageSource;
  /** Channel ID */
  channelId: string;
  /** Human-readable channel name (e.g., "#general", "DM with User") */
  channelName?: string;
  /** User ID (optional, for DMs) */
  userId?: string;
  /** Rolling conversation context (JSON) */
  context: string;
  /** Session creation timestamp */
  createdAt: number;
  /** Last activity timestamp */
  lastActive: number;
}

/**
 * Conversation turn in rolling context
 */
export interface ConversationTurn {
  /** User message */
  user: string;
  /** Bot response (truncated) */
  bot: string;
  /** Timestamp */
  timestamp?: number;
}

/**
 * Decision from MAMA memory for context injection
 */
export interface RelatedDecision {
  /** Decision ID */
  id: string;
  /** Topic identifier */
  topic: string;
  /** Decision text */
  decision: string;
  /** Reasoning */
  reasoning?: string;
  /** Outcome status */
  outcome?: 'success' | 'failed' | 'partial' | 'pending';
  /** Similarity score (0-1) */
  similarity: number;
}

/**
 * Message router configuration
 */
export interface MessageRouterConfig {
  /** Minimum similarity threshold for context injection (default: 0.7) */
  similarityThreshold?: number;
  /** Maximum number of decisions to inject (default: 3) */
  maxDecisions?: number;
  /** Maximum conversation turns to keep (default: 5) */
  maxTurns?: number;
  /** Maximum response length for context storage (default: 200) */
  maxResponseLength?: number;
  /** Target language for auto-translation prompts (default: Korean) */
  translationTargetLanguage?: string;
}

/**
 * Gateway configuration base
 */
export interface GatewayConfig {
  /** Whether the gateway is enabled */
  enabled: boolean;
}

/**
 * Discord gateway configuration
 */
export interface DiscordGatewayConfig extends GatewayConfig {
  /** Discord bot token */
  token: string;
  /** Guild-specific settings */
  guilds?: Record<string, DiscordGuildConfig>;
}

/**
 * Discord guild configuration
 */
export interface DiscordGuildConfig {
  /** Channel-specific settings */
  channels?: Record<string, DiscordChannelConfig>;
  /** Default: require mention to respond */
  requireMention?: boolean;
}

/**
 * Discord channel configuration
 */
export interface DiscordChannelConfig {
  /** Whether mention is required (overrides guild setting) */
  requireMention?: boolean;
}

/**
 * Slack gateway configuration
 */
export interface SlackGatewayConfig extends GatewayConfig {
  /** Slack bot token */
  botToken: string;
  /** Slack app token (for Socket Mode) */
  appToken: string;
  /** Channel-specific settings */
  channels?: Record<string, SlackChannelConfig>;
}

/**
 * Slack channel configuration
 */
export interface SlackChannelConfig {
  /** Whether mention is required */
  requireMention?: boolean;
}

/**
 * Chatwork gateway configuration
 */
export interface ChatworkGatewayConfig extends GatewayConfig {
  /** Chatwork API token */
  apiToken: string;
  /** Room IDs to monitor */
  roomIds?: string[];
  /** Polling interval in milliseconds */
  pollInterval?: number;
  /** Whether mention is required */
  mentionRequired?: boolean;
}

/**
 * Gateway event types
 */
export type GatewayEventType =
  | 'connected'
  | 'disconnected'
  | 'message_received'
  | 'message_sent'
  | 'error';

/**
 * Gateway event
 */
export interface GatewayEvent {
  type: GatewayEventType;
  source: MessageSource;
  timestamp: Date;
  data?: unknown;
  error?: Error;
}

/**
 * Gateway event handler
 */
export type GatewayEventHandler = (event: GatewayEvent) => void;

/**
 * Gateway interface that all platform gateways must implement
 */
export interface Gateway {
  /** Platform identifier */
  readonly source: MessageSource;
  /** Start the gateway */
  start(): Promise<void>;
  /** Stop the gateway */
  stop(): Promise<void>;
  /** Check if gateway is connected */
  isConnected(): boolean;
  /** Register event handler */
  onEvent(handler: GatewayEventHandler): void;
}

// ============================================
// Gateway Plugin System Types
// ============================================

/**
 * Plugin manifest (plugin.json)
 */
export interface PluginManifest {
  /** Unique plugin ID */
  id: string;
  /** Display name */
  name: string;
  /** Plugin version */
  version: string;
  /** Description */
  description?: string;
  /** Entry point (relative to plugin directory) */
  main: string;
  /** Plugin type */
  type: 'gateway';
  /** Gateway-specific metadata */
  gateway?: {
    /** Gateway source ID (e.g., 'discord', 'slack') */
    sourceId: string;
    /** Display label */
    label: string;
    /** Config schema (JSON Schema) */
    configSchema?: Record<string, unknown>;
  };
  /** Required dependencies */
  dependencies?: Record<string, string>;
}

/**
 * Plugin API provided to plugins
 */
export interface PluginApi {
  /** Logger */
  logger: PluginLogger;
  /** Get config for this plugin */
  getConfig<T = unknown>(): T | undefined;
  /** Get agent loop for processing messages */
  getAgentLoop(): AgentLoopInterface;
  /** Register a message handler */
  onMessage(handler: MessageHandler): void;
  /** Send a response to a channel */
  sendResponse(channelId: string, text: string, metadata?: MessageMetadata): Promise<void>;
}

/**
 * Plugin logger interface
 */
export interface PluginLogger {
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
  debug(message: string, ...args: unknown[]): void;
}

/**
 * Agent loop interface for plugins
 */
export interface AgentLoopInterface {
  run(prompt: string): Promise<{ response: string }>;
  runWithContent(content: ContentBlock[]): Promise<{ response: string }>;
}

/**
 * Content block for multimodal messages
 */
export interface ContentBlock {
  type: 'text' | 'image';
  text?: string;
  localPath?: string; // For image path reference
  source?: {
    type: 'base64';
    media_type: string;
    data: string;
  };
}

/**
 * Message handler function type
 */
export type MessageHandler = (message: NormalizedMessage) => Promise<void>;

/**
 * Gateway plugin registration function
 */
export type GatewayPluginRegister = (api: PluginApi) => Gateway | Promise<Gateway>;

/**
 * Gateway plugin module export
 */
export interface GatewayPluginModule {
  /** Plugin ID (optional, uses manifest id if not provided) */
  id?: string;
  /** Plugin display name */
  name?: string;
  /** Registration function */
  register: GatewayPluginRegister;
}

/**
 * Loaded plugin info
 */
export interface LoadedPlugin {
  /** Plugin manifest */
  manifest: PluginManifest;
  /** Plugin directory path */
  path: string;
  /** Gateway instance (after registration) */
  gateway?: Gateway;
  /** Is plugin enabled */
  enabled: boolean;
}
