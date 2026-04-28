/**
 * Envelope schema per spec v2.3 section 4.4.
 * Every worker instance is bound to one envelope at spawn.
 */

export type EnvelopeSource =
  | 'telegram'
  | 'slack'
  | 'chatwork'
  | 'discord'
  | 'viewer'
  | 'cron'
  | 'delegate'
  | 'watch';

export interface ProjectRef {
  kind: 'project';
  id: string;
}

export interface MemoryScope {
  kind: 'global' | 'user' | 'channel' | 'project';
  id: string;
}

export interface DestinationRef {
  kind: 'telegram' | 'slack' | 'chatwork' | 'discord' | 'webchat' | 'obsidian' | 'dashboard_slot';
  id: string;
}

export interface TriggerContext {
  user_text?: string;
  scheduled_at?: string;
  watch_event?: { type: string; raw_id?: string; [key: string]: unknown };
  parent_task?: string;
}

export interface EnvelopeBudget {
  wall_seconds: number;
  token_limit?: number;
  cost_cap?: number;
}

export interface EnvelopeSignature {
  hmac: string;
  key_id: string;
  key_version: number;
}

export interface Envelope {
  agent_id: string;
  instance_id: string;
  parent_instance_id?: string;
  source: EnvelopeSource;
  channel_id?: string;
  trigger_context: TriggerContext;
  scope: {
    project_refs: ProjectRef[];
    raw_connectors: string[];
    memory_scopes: MemoryScope[];
    allowed_destinations: DestinationRef[];
    as_of?: string;
    eval_privileged?: boolean;
  };
  tier: 1 | 2 | 3;
  budget: EnvelopeBudget;
  expires_at: string;
  envelope_hash: string;
  signature?: EnvelopeSignature;
}

export const ENVELOPE_HASH_EXCLUDED_FIELDS = ['envelope_hash', 'signature'] as const;
