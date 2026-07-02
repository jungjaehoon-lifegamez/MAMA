import type { ContextRef } from '../context-compile/types.js';

export const STRICT_SOURCE_REF_KINDS = [
  'memory',
  'raw',
  'entity',
  'case',
  'decision',
  'os_task',
  'agent_situation_packet',
  'report_slot',
  'context_packet',
  'model_run',
  'tool_trace',
  'wiki_page',
  'report',
] as const;

export type StrictSourceRefKind = (typeof STRICT_SOURCE_REF_KINDS)[number];
type NonRawStrictSourceRefKind = Exclude<StrictSourceRefKind, 'raw'>;

export const LEGACY_SOURCE_REF_KINDS = ['message', 'conversation', 'raw_memory'] as const;

export type LegacySourceRefKind = (typeof LEGACY_SOURCE_REF_KINDS)[number];

export type SourceRef =
  | { kind: Exclude<StrictSourceRefKind, 'raw'>; id: string }
  | {
      kind: 'raw';
      id: string;
      connector: string;
      source_id?: string;
      channel_id?: string | null;
    }
  | { kind: 'legacy'; legacy_kind: LegacySourceRefKind; id: string };

const STRICT_SOURCE_REF_KIND_SET = new Set<string>(STRICT_SOURCE_REF_KINDS);
const LEGACY_SOURCE_REF_KIND_SET = new Set<string>(LEGACY_SOURCE_REF_KINDS);
const VERIFY_ARTIFACT_KIND_SET = new Set<string>([
  'decision',
  'os_task',
  'agent_situation_packet',
  'report_slot',
  'context_packet',
  'model_run',
  'tool_trace',
]);

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new Error(`Source ref ${field} must be a string`);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error(`Source ref ${field} must not be empty`);
  }
  return trimmed;
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return requiredString(value, field);
}

function optionalNullableString(value: unknown, field: string): string | null | undefined {
  if (value === null) {
    return null;
  }
  return optionalString(value, field);
}

function assertStrictSourceRefKind(kind: string): asserts kind is StrictSourceRefKind {
  if (!STRICT_SOURCE_REF_KIND_SET.has(kind)) {
    throw new Error(`Unsupported source ref kind: ${kind}`);
  }
}

function assertLegacySourceRefKind(kind: string): asserts kind is LegacySourceRefKind {
  if (!LEGACY_SOURCE_REF_KIND_SET.has(kind)) {
    throw new Error(`Unsupported legacy source ref kind: ${kind}`);
  }
}

export function fromContextRef(ref: ContextRef): SourceRef {
  if (ref.kind === 'raw') {
    const normalized: SourceRef = {
      kind: 'raw',
      id: requiredString(ref.raw_id, 'raw_id'),
      connector: requiredString(ref.connector, 'connector'),
    };
    const sourceId = optionalString(ref.source_id, 'source_id');
    const channelId = optionalNullableString(ref.channel_id, 'channel_id');
    if (sourceId !== undefined) {
      normalized.source_id = sourceId;
    }
    if (channelId !== undefined) {
      normalized.channel_id = channelId;
    }
    return normalized;
  }

  return {
    kind: ref.kind,
    id: requiredString(ref.id, 'id'),
  };
}

export function toContextRef(ref: SourceRef): ContextRef | null {
  switch (ref.kind) {
    case 'memory':
    case 'entity':
    case 'case':
      return {
        kind: ref.kind,
        id: requiredString(ref.id, 'id'),
      };
    case 'raw': {
      const normalized: ContextRef = {
        kind: 'raw',
        raw_id: requiredString(ref.id, 'id'),
        connector: requiredString(ref.connector, 'connector'),
      };
      const sourceId = optionalString(ref.source_id, 'source_id');
      const channelId = optionalNullableString(ref.channel_id, 'channel_id');
      if (sourceId !== undefined) {
        normalized.source_id = sourceId;
      }
      if (channelId !== undefined) {
        normalized.channel_id = channelId;
      }
      return normalized;
    }
    default:
      return null;
  }
}

export function fromVerifyArtifact(artifact: { type: string; id: string }): SourceRef {
  const kind = requiredString(artifact.type, 'type');
  if (!VERIFY_ARTIFACT_KIND_SET.has(kind)) {
    throw new Error(`Unsupported verify artifact source ref kind: ${kind}`);
  }
  assertStrictSourceRefKind(kind);
  if (kind === 'raw') {
    throw new Error('Verify artifact source refs cannot use raw kind');
  }
  return {
    kind,
    id: requiredString(artifact.id, 'id'),
  };
}

export function parseSourceRefString(value: string): SourceRef {
  const rawValue = requiredString(value, 'value');
  const parts = rawValue.split(':');
  const kind = requiredString(parts[0], 'kind');

  if (kind === 'raw') {
    const connector = requiredString(parts[1], 'connector');
    const id = requiredString(parts.slice(2).join(':'), 'id');
    return { kind: 'raw', connector, id };
  }

  if (LEGACY_SOURCE_REF_KIND_SET.has(kind)) {
    assertLegacySourceRefKind(kind);
    return {
      kind: 'legacy',
      legacy_kind: kind,
      id: requiredString(parts.slice(1).join(':'), 'id'),
    };
  }

  assertStrictSourceRefKind(kind);
  if (kind === 'raw') {
    throw new Error('Raw source refs must include connector and id');
  }
  const sourceKind: NonRawStrictSourceRefKind = kind;
  return {
    kind: sourceKind,
    id: requiredString(parts.slice(1).join(':'), 'id'),
  };
}

export function serializeSourceRef(ref: SourceRef): string {
  switch (ref.kind) {
    case 'raw':
      return `raw:${requiredString(ref.connector, 'connector')}:${requiredString(ref.id, 'id')}`;
    case 'legacy':
      assertLegacySourceRefKind(ref.legacy_kind);
      return `${ref.legacy_kind}:${requiredString(ref.id, 'id')}`;
    default: {
      assertStrictSourceRefKind(ref.kind);
      return `${ref.kind}:${requiredString(ref.id, 'id')}`;
    }
  }
}

export function assertNonEmptySourceRefs(refs: readonly SourceRef[]): void {
  if (!Array.isArray(refs) || refs.length === 0) {
    throw new Error('Source refs must not be empty');
  }
  for (const ref of refs) {
    serializeSourceRef(ref);
  }
}
