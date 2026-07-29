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

export function serializeSourceRef(ref: SourceRef): string {
  if (ref === null || ref === undefined) {
    throw new Error('Source ref must not be null or undefined');
  }

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
