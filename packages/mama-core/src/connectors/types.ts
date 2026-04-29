import type { Buffer } from 'node:buffer';
import type { MemoryScopeRef } from '../memory/types.js';

export interface ConnectorEventIndexRecord {
  event_index_id: string;
  source_connector: string;
  source_type: string;
  source_id: string;
  source_locator: string | null;
  channel: string | null;
  author: string | null;
  title: string | null;
  content: string;
  event_datetime: number | null;
  event_date: string | null;
  source_timestamp_ms: number;
  source_cursor: string | null;
  tenant_id: string | null;
  project_id: string | null;
  memory_scope_kind: string | null;
  memory_scope_id: string | null;
  metadata_json: string | null;
  artifact_locator: string | null;
  artifact_title: string | null;
  content_hash: Buffer;
  indexed_at: string;
  updated_at: string;
  expires_at: string | null;
}

export interface UpsertConnectorEventIndexInput {
  source_connector: string;
  source_type: string;
  source_id: string;
  source_locator?: string | null;
  channel?: string | null;
  author?: string | null;
  title?: string | null;
  content: string;
  event_datetime?: number | null;
  event_date?: string | null;
  source_timestamp_ms?: number | null;
  source_cursor?: string | null;
  tenant_id?: string | null;
  project_id?: string | null;
  memory_scope_kind?: string | null;
  memory_scope_id?: string | null;
  metadata_json?: string | null;
  metadata?: unknown;
  artifact_locator?: string | null;
  artifact_title?: string | null;
  content_hash?: Buffer | Uint8Array | null;
  indexed_at?: string;
  updated_at?: string;
  expires_at?: string | null;
}

export interface ConnectorEventIndexCursorRecord {
  connector_name: string;
  last_seen_timestamp_ms: number;
  last_seen_source_id: string;
  last_sweep_at: string | null;
  last_success_at: string | null;
  last_error: string | null;
  last_error_at: string | null;
  indexed_count: number;
}

export interface UpsertConnectorEventIndexCursorInput {
  connector_name: string;
  last_seen_timestamp_ms?: number;
  last_seen_source_id?: string;
  last_sweep_at?: string | null;
  last_success_at?: string | null;
  last_error?: string | null;
  last_error_at?: string | null;
  indexed_count?: number;
}

export interface ConnectorEventSearchHit extends ConnectorEventIndexRecord {
  rank: number;
  score: number;
}

export interface RawSearchScopeFilter {
  kind: MemoryScopeRef['kind'];
  id: string;
}

export interface RawSearchInput {
  query: string;
  connectors?: string[];
  scopes?: RawSearchScopeFilter[];
  fromMs?: number;
  toMs?: number;
  cursor?: string;
  limit?: number;
}

export interface RawSearchHit {
  raw_id: string;
  connector: string;
  source_id: string;
  channel_id: string | null;
  author_label: string | null;
  created_at: string | null;
  content_preview: string;
  score: number;
  source_ref: string | null;
  metadata: Record<string, unknown>;
}

export interface RawSearchResult {
  hits: RawSearchHit[];
  next_cursor: string | null;
}

export type ConnectorEventStalenessStatus =
  | 'healthy'
  | 'stale-but-warming'
  | 'warn'
  | 'unhealthy'
  | 'never_swept';
