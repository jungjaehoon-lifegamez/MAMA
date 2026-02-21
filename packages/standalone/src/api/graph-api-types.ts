/**
 * Type definitions for Graph API
 */

import type { IncomingMessage, ServerResponse } from 'http';

// === Graph Data Types ===

export interface GraphNode {
  id: string;
  topic: string;
  decision: string;
  reasoning: string;
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

export interface DelegationHistoryEntry {
  id: string;
  fromAgentId: string;
  toAgentId: string;
  task: string;
  background: boolean;
  status: 'active' | 'completed' | 'failed';
  startedAt: string;
  completedAt: string | null;
  duration: number | null;
  error: string | null;
}

export interface CodeActResult {
  success: boolean;
  value?: unknown;
  logs?: string[];
  error?: string;
  metrics?: { durationMs: number; hostCallCount: number; memoryUsedBytes: number };
}

export interface GraphHandlerOptions {
  getAgentStates?: () => Map<string, string>;
  getSwarmTasks?: (limit: number) => SwarmTask[];
  getRecentDelegations?: (limit: number) => DelegationHistoryEntry[];
  applyMultiAgentConfig?: (config: Record<string, unknown>) => Promise<void>;
  restartMultiAgentAgent?: (agentId: string) => Promise<void>;
  executeCodeAct?: (code: string) => Promise<CodeActResult>;
}

export interface SwarmTask {
  id: string;
  description: string;
  category: string;
  wave: number;
  status: string;
  claimed_by: string | null;
  claimed_at: number | null;
  completed_at: number | null;
  result: string | null;
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
