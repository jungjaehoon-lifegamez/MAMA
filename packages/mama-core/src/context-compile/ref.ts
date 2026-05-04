import type { TwinRef } from '../edges/types.js';
import type { ContextRef } from './types.js';

const SUPPORTED_KINDS = new Set(['memory', 'raw', 'entity', 'case']);
const UNSUPPORTED_KINDS = new Set(['decision', 'wiki_page', 'context_packet', 'report']);

function asRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Context ref must be an object with a kind field');
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new Error(`Context ref ${field} must be a string`);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error(`Context ref ${field} must not be empty`);
  }
  return trimmed;
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw new Error(`Context ref ${field} must be a string`);
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function optionalNullableString(value: unknown, field: string): string | null | undefined {
  if (value === null) {
    return null;
  }
  return optionalString(value, field);
}

export function normalizeContextRef(input: unknown): ContextRef {
  const record = asRecord(input);
  const kind = record.kind;
  if (typeof kind !== 'string') {
    throw new Error('Context ref kind must be a string');
  }
  if (UNSUPPORTED_KINDS.has(kind) || !SUPPORTED_KINDS.has(kind)) {
    throw new Error(`Unsupported V0 context ref kind: ${kind}`);
  }

  switch (kind) {
    case 'raw': {
      const normalized: ContextRef = {
        kind,
        raw_id: requiredString(record.raw_id, 'raw_id'),
        connector: requiredString(record.connector, 'connector'),
      };
      const sourceId = optionalString(record.source_id, 'source_id');
      const channelId = optionalNullableString(record.channel_id, 'channel_id');
      if (sourceId !== undefined) {
        normalized.source_id = sourceId;
      }
      if (channelId !== undefined) {
        normalized.channel_id = channelId;
      }
      return normalized;
    }
    case 'memory':
    case 'entity':
    case 'case':
      return {
        kind,
        id: requiredString(record.id, 'id'),
      };
    default:
      throw new Error(`Unsupported V0 context ref kind: ${kind}`);
  }
}

export function normalizeContextRefs(refs: readonly unknown[] | undefined): ContextRef[] {
  if (!Array.isArray(refs)) {
    return [];
  }
  return refs.map((ref) => normalizeContextRef(ref));
}

export function serializeContextRefForProvenance(ref: ContextRef): string {
  if (ref.kind === 'raw') {
    return `raw:${ref.connector}:${ref.raw_id}`;
  }
  return `${ref.kind}:${ref.id}`;
}

export function toTwinRef(ref: ContextRef): TwinRef {
  if (ref.kind === 'raw') {
    return {
      kind: 'raw',
      id: ref.raw_id,
    };
  }
  return {
    kind: ref.kind,
    id: ref.id,
  };
}
