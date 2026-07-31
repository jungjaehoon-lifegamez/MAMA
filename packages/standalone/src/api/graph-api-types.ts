/**
 * Type definitions for Graph API
 */

import type { IncomingMessage, ServerResponse } from 'http';

// === Graph Data Types ===

export interface GraphNode {
  id: string;
  topic: string;
  decision?: string;
  reasoning?: string;
  decision_preview?: string;
  outcome: string | null;
  confidence: number | null;
  created_at: number;
}

export interface GraphEdge {
  from: string;
  to: string;
  relationship: string;
  reason: string | null;
}

export interface SimilarityEdge {
  from: string;
  to: string;
  relationship: 'similar';
  similarity: number;
}

export interface CheckpointData {
  id: string;
  timestamp: number;
  summary: string;
  open_files: string[];
  next_steps: string;
  status: string | null;
}

// === Handler Options ===

export interface CodeActResult {
  success: boolean;
  value?: unknown;
  logs?: string[];
  error?: string;
  errorCode?: string;
  terminalCode?: 'CODE_ACT_MUTATION_COMMITTED_AFTER_ABORT' | 'CODE_ACT_MUTATION_OUTCOME_UNKNOWN';
  retryable?: boolean;
  abort?: boolean;
  metrics?: { durationMs: number; hostCallCount: number; memoryUsedBytes: number };
  hostToolExecutions?: Array<{ name: string; success: boolean; code?: string }>;
  hostToolsInvoked?: string[];
}

export interface CodeActExecutionContext {
  contextKey?: string;
  agentId?: string;
  allowedTools?: string[];
  blockedTools?: string[];
}

export interface GraphHandlerOptions {
  getAgentStates?: () => Map<string, string>;
  applyMultiAgentConfig?: (config: Record<string, unknown>) => Promise<void>;
  restartMultiAgentAgent?: (agentId: string) => Promise<void>;
  stopMultiAgentAgent?: (agentId: string) => Promise<void>;
  executeCodeAct?: (code: string, context?: CodeActExecutionContext) => Promise<CodeActResult>;
  healthService?: { compute(windowMs?: number): unknown };
  healthCheckService?: {
    check(): Promise<import('../observability/health-check.js').SystemHealthReport>;
  };
  auditConversation?: (job: {
    conversation: string;
    scopes: Array<{ kind: string; id: string }>;
    candidates?: Array<{ kind: string; topicHint?: string; confidence: number; summary: string }>;
  }) => Promise<{ status: string; action: string; event_ids: string[]; reason?: string }>;
  /** Sessions database for agent version tracking */
  sessionsDb?: import('../sqlite.js').SQLiteDatabase;
  /** UI command queue for bidirectional Agent↔Viewer communication */
  uiCommandQueue?: import('./ui-command-handler.js').UICommandQueue;
}

// === Stats Types ===

export interface MemoryStats {
  total: number;
  thisWeek: number;
  thisMonth: number;
  checkpoints: number;
  outcomes: Record<string, number>;
  topTopics: Array<{ topic: string; count: number }>;
}

export interface SessionStats {
  total: number;
  bySource: Record<string, number>;
  channels: Array<{
    source: string;
    channelId: string;
    channelName: string | null;
    lastActive: number;
    messageCount: number;
  }>;
}

// === Handler function signature ===

export type GraphHandlerFn = (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;
