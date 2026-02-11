/**
 * Multi-Agent Discord Chat System
 *
 * Enables multiple AI agents (personas) to interact in Discord channels,
 * with automatic conversation flow and loop prevention.
 *
 * @module multi-agent
 */

// Types
export type {
  AgentPersonaConfig,
  MultiAgentConfig,
  LoopPreventionConfig,
  ChainState,
  AgentSelectionResult,
  MessageContext,
  AgentResponseRecord,
  CategoryConfig,
  UltraWorkConfig,
  TaskContinuationConfig,
  DelegationRule,
} from './types.js';

export { DEFAULT_LOOP_PREVENTION, DEFAULT_MULTI_AGENT_CONFIG } from './types.js';

// Orchestrator
export { MultiAgentOrchestrator } from './orchestrator.js';

// Process Manager
export { AgentProcessManager } from './agent-process-manager.js';

// Shared Context
export type { SharedMessage, ChannelContext } from './shared-context.js';
export {
  SharedContextManager,
  getSharedContextManager,
  resetSharedContextManager,
} from './shared-context.js';

// Base Handler
export type { AgentResponse, MultiAgentResponse } from './multi-agent-base.js';
export { MultiAgentHandlerBase, AGENT_TIMEOUT_MS } from './multi-agent-base.js';

// Discord Integration
export { MultiAgentDiscordHandler } from './multi-agent-discord.js';

// Multi-Bot Manager
export { MultiBotManager } from './multi-bot-manager.js';

// Tool Permission Manager
export type { ToolPermissions } from './tool-permission-manager.js';
export { ToolPermissionManager } from './tool-permission-manager.js';

// Category Router
export type { CategoryMatchResult } from './category-router.js';
export { CategoryRouter } from './category-router.js';

// Task Continuation
export type { ContinuationResult } from './task-continuation.js';
export { TaskContinuationEnforcer } from './task-continuation.js';

// Delegation Manager
export type {
  DelegationRequest,
  DelegationResult,
  DelegationNotifyCallback,
  DelegationExecuteCallback,
} from './delegation-manager.js';
export { DelegationManager } from './delegation-manager.js';

// UltraWork Manager
export type { UltraWorkSession, UltraWorkStep } from './ultrawork.js';
export { UltraWorkManager } from './ultrawork.js';

// Delegation Format Validator
export type { DelegationValidation } from './delegation-format-validator.js';
export { validateDelegationFormat, isDelegationAttempt } from './delegation-format-validator.js';

// Work Tracker
export type { ActiveWork } from './work-tracker.js';
export { WorkTracker } from './work-tracker.js';
