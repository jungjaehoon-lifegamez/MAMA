export const MEMORY_SCOPE_KINDS = ['global', 'user', 'channel', 'project'] as const;
export type MemoryScopeKind = (typeof MEMORY_SCOPE_KINDS)[number];

export const MEMORY_KINDS = ['decision', 'preference', 'constraint', 'lesson', 'fact'] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];

export const MEMORY_STATUSES = ['active', 'superseded', 'contradicted', 'stale'] as const;
export type MemoryStatus = (typeof MEMORY_STATUSES)[number];

export const MEMORY_EDGE_TYPES = ['supersedes', 'builds_on', 'synthesizes', 'contradicts'] as const;
export type MemoryEdgeType = (typeof MEMORY_EDGE_TYPES)[number];

export interface MemoryScopeRef {
  kind: MemoryScopeKind;
  id: string;
}

export interface MemoryRecord {
  id: string;
  topic: string;
  kind: MemoryKind;
  summary: string;
  details: string;
  confidence: number;
  status: MemoryStatus;
  scopes: MemoryScopeRef[];
  source: {
    package: 'mama-core' | 'mcp-server' | 'standalone' | 'claude-code-plugin';
    source_type: string;
    user_id?: string;
    channel_id?: string;
    project_id?: string;
  };
  created_at: number | string;
  updated_at: number | string;
}

export interface MemoryEdge {
  from_id: string;
  to_id: string;
  type: MemoryEdgeType;
  reason?: string;
}

export interface ProfileSnapshot {
  static: MemoryRecord[];
  dynamic: MemoryRecord[];
  evidence: Array<{
    memory_id: string;
    topic: string;
    why_included: string;
  }>;
}

export interface RecallBundle {
  profile: ProfileSnapshot;
  memories: MemoryRecord[];
  graph_context: {
    primary: MemoryRecord[];
    expanded: MemoryRecord[];
    edges: MemoryEdge[];
  };
  search_meta: {
    query: string;
    scope_order: MemoryScopeKind[];
    retrieval_sources: string[];
  };
}

export function createEmptyRecallBundle(query: string): RecallBundle {
  return {
    profile: {
      static: [],
      dynamic: [],
      evidence: [],
    },
    memories: [],
    graph_context: {
      primary: [],
      expanded: [],
      edges: [],
    },
    search_meta: {
      query,
      scope_order: ['project'],
      retrieval_sources: ['vector'],
    },
  };
}
