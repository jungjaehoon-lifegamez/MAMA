import type {
  MemoryEventRecord,
  MemoryWriteProvenance,
  PublicIngestConversationInput,
  PublicIngestMemoryInput,
  PublicSaveMemoryInput,
} from './types.js';

const issuedCapabilities = new WeakSet<object>();

const ALLOWED_PROVENANCE_FIELDS = new Set<keyof MemoryWriteProvenance>([
  'actor',
  'agent_id',
  'model_run_id',
  'envelope_hash',
  'tool_name',
  'gateway_call_id',
  'source_turn_id',
  'source_message_ref',
  'source_refs',
]);

export interface TrustedProvenanceCapability {
  readonly __trustedProvenanceCapability: 'mama-core';
}

export interface TrustedMemoryWriteOptions {
  provenance: MemoryWriteProvenance;
  capability: TrustedProvenanceCapability;
}

export interface NormalizedMemoryProvenance {
  actor: MemoryEventRecord['actor'];
  agent_id: string | null;
  model_run_id: string | null;
  envelope_hash: string | null;
  tool_name: string | null;
  gateway_call_id: string | null;
  source_turn_id: string | null;
  source_message_ref: string | null;
  source_refs: string[];
  provenance: Record<string, unknown>;
}

export function createTrustedProvenanceCapability(): TrustedProvenanceCapability {
  const capability = Object.freeze({
    __trustedProvenanceCapability: 'mama-core' as const,
  });
  issuedCapabilities.add(capability);
  return capability;
}

export function assertTrustedProvenanceCapability(
  capability: TrustedProvenanceCapability | undefined
): asserts capability is TrustedProvenanceCapability {
  if (!capability || typeof capability !== 'object' || !issuedCapabilities.has(capability)) {
    throw new Error('Invalid trusted provenance capability');
  }
}

export function stripCallerProvenance<T extends Record<string, unknown>>(input: T): T {
  if (!Object.prototype.hasOwnProperty.call(input, 'provenance')) {
    return input;
  }
  const { provenance: _provenance, ...rest } = input;
  return rest as T;
}

export function sanitizePublicSaveMemoryInput(input: PublicSaveMemoryInput): PublicSaveMemoryInput {
  return stripCallerProvenance(input as PublicSaveMemoryInput & Record<string, unknown>);
}

export function sanitizePublicIngestMemoryInput(
  input: PublicIngestMemoryInput
): PublicIngestMemoryInput {
  return stripCallerProvenance(input as PublicIngestMemoryInput & Record<string, unknown>);
}

export function sanitizePublicIngestConversationInput(
  input: PublicIngestConversationInput
): PublicIngestConversationInput {
  return stripCallerProvenance(input as PublicIngestConversationInput & Record<string, unknown>);
}

export function normalizeMemoryWriteProvenance(
  options?: TrustedMemoryWriteOptions
): NormalizedMemoryProvenance {
  if (!options) {
    return buildFallbackProvenance();
  }

  assertTrustedProvenanceCapability(options.capability);
  const provenance = options.provenance ?? {};
  const actor = provenance.actor ?? 'main_agent';
  const sourceRefs = normalizeStringArray(provenance.source_refs);
  const compact: Record<string, unknown> = {
    actor,
  };

  for (const [key, value] of Object.entries(provenance as Record<string, unknown>)) {
    if (!ALLOWED_PROVENANCE_FIELDS.has(key as keyof MemoryWriteProvenance)) {
      continue;
    }
    if (key === 'source_refs') {
      compact.source_refs = sourceRefs;
      continue;
    }
    if (isCompactValue(value)) {
      compact[key] = value;
    }
  }

  return {
    actor,
    agent_id: normalizeNullableString(provenance.agent_id),
    model_run_id: normalizeNullableString(provenance.model_run_id),
    envelope_hash: normalizeNullableString(provenance.envelope_hash),
    tool_name: normalizeNullableString(provenance.tool_name),
    gateway_call_id: normalizeNullableString(provenance.gateway_call_id),
    source_turn_id: normalizeNullableString(provenance.source_turn_id),
    source_message_ref: normalizeNullableString(provenance.source_message_ref),
    source_refs: sourceRefs,
    provenance: compact,
  };
}

export function appendProvenanceSourceRefs(
  options: TrustedMemoryWriteOptions | undefined,
  refs: string[]
): TrustedMemoryWriteOptions | undefined {
  if (!options) {
    return undefined;
  }
  assertTrustedProvenanceCapability(options.capability);
  return {
    capability: options.capability,
    provenance: {
      ...options.provenance,
      source_refs: [...(options.provenance.source_refs ?? []), ...refs],
    },
  };
}

function buildFallbackProvenance(): NormalizedMemoryProvenance {
  const actor: MemoryEventRecord['actor'] = 'actor:direct_client';
  return {
    actor,
    agent_id: null,
    model_run_id: null,
    envelope_hash: null,
    tool_name: null,
    gateway_call_id: null,
    source_turn_id: null,
    source_message_ref: null,
    source_refs: [],
    provenance: {
      actor,
      source_type: 'direct_client',
    },
  };
}

function normalizeNullableString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === 'string' && item.length > 0);
}

function isCompactValue(value: unknown): boolean {
  if (value === null) {
    return true;
  }
  if (['string', 'number', 'boolean'].includes(typeof value)) {
    return true;
  }
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}
