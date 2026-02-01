/**
 * Gateway Module for MAMA Standalone
 *
 * Provides unified message handling across multiple messenger platforms.
 *
 * Components:
 * - MessageRouter: Central routing hub
 * - SessionStore: Conversation session management
 * - ContextInjector: Proactive decision retrieval
 * - DiscordGateway: Discord bot integration
 * - MessageSplitter: Message chunking utilities
 * - Types: Shared type definitions
 */

// Core components
export { MessageRouter, createMockAgentLoop } from './message-router.js';
export type { AgentLoopClient, AgentLoopOptions, ProcessingResult } from './message-router.js';

export { SessionStore } from './session-store.js';

export { ContextInjector, createMockMamaApi } from './context-injector.js';
export type { MamaApiClient, SearchResult, InjectedContext } from './context-injector.js';

// Platform gateways
export { DiscordGateway } from './discord.js';
export type { DiscordGatewayOptions } from './discord.js';

export { SlackGateway } from './slack.js';
export type { SlackGatewayOptions } from './slack.js';

// Message utilities
export {
  splitMessage,
  splitForDiscord,
  splitForSlack,
  splitWithCodeBlocks,
  truncateWithEllipsis,
  estimateChunks,
  DEFAULT_MAX_LENGTH,
} from './message-splitter.js';
export type { SplitOptions } from './message-splitter.js';

// Channel history (for message context)
export { ChannelHistory, getChannelHistory, setChannelHistory } from './channel-history.js';
export type { HistoryEntry, ChannelHistoryConfig } from './channel-history.js';

// Plugin system
export { PluginLoader, createPluginLoader } from './plugin-loader.js';
export type { PluginLoaderConfig } from './plugin-loader.js';

// Types
export type {
  // Message types
  MessageSource,
  NormalizedMessage,
  MessageMetadata,
  MessageAttachment,

  // Session types
  Session,
  ConversationTurn,

  // Decision types
  RelatedDecision,

  // Configuration types
  MessageRouterConfig,
  GatewayConfig,
  DiscordGatewayConfig,
  DiscordGuildConfig,
  DiscordChannelConfig,
  SlackGatewayConfig,
  SlackChannelConfig,
  ChatworkGatewayConfig,

  // Event types
  GatewayEventType,
  GatewayEvent,
  GatewayEventHandler,
  Gateway,

  // Plugin types
  PluginManifest,
  PluginApi,
  PluginLogger,
  AgentLoopInterface,
  ContentBlock,
  MessageHandler,
  GatewayPluginRegister,
  GatewayPluginModule,
  LoadedPlugin,
} from './types.js';
