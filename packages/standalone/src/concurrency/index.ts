/**
 * Lane-based Concurrency System
 *
 * Provides queue-based concurrent task execution with:
 * - Session lanes: Ensure same-session messages are processed in order
 * - Global lane: Limit total concurrent API calls (rate limit protection)
 * - 2-stage queueing: Session lane → Global lane
 */

export { LaneManager, getGlobalLaneManager, resetGlobalLaneManager } from './lane-manager.js';

export { buildSessionKey, buildChannelSessionKey, parseSessionKey } from './session-key.js';

export type {
  LaneState,
  QueueEntry,
  LaneManagerConfig,
  EnqueueOptions,
  LaneLogger,
} from './types.js';

export { defaultLogger } from './types.js';
