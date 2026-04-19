import { EntityLabelMissingError } from './errors.js';
import type { EntityAlias, EntityNode, EntityTimelineEvent } from './types.js';
import type { MemoryRecord } from '../memory/types.js';

interface ProjectionOptions {
  nodeLookup?: Record<string, EntityNode>;
}

function formatTimelineEventForRecall(latestEvent: EntityTimelineEvent | null): string | null {
  if (!latestEvent) {
    return null;
  }

  const parts: string[] = [];
  const eventType = latestEvent.event_type.trim();
  const summary = latestEvent.summary.trim();
  const details = latestEvent.details?.trim() ?? '';

  if (eventType.length > 0) {
    parts.push(eventType);
  }
  if (summary.length > 0) {
    parts.push(summary);
  }

  if (details.length > 0 && details !== summary) {
    try {
      const parsed = JSON.parse(details) as unknown;
      if (parsed && typeof parsed === 'object') {
        parts.push(JSON.stringify(parsed));
      } else {
        parts.push(details);
      }
    } catch {
      parts.push(details);
    }
  }

  return parts.length > 0 ? parts.join('\n') : null;
}

function assertNoCircularMerge(node: EntityNode, options?: ProjectionOptions): void {
  if (!options?.nodeLookup) {
    return;
  }

  const seen = new Set<string>();
  let current: EntityNode | undefined = options.nodeLookup[node.id] ?? node;
  while (current?.merged_into) {
    if (seen.has(current.id)) {
      throw new EntityLabelMissingError({
        entity_id: node.id,
        reason: 'circular_merged_into_chain',
      });
    }
    seen.add(current.id);
    current = options.nodeLookup[current.merged_into];
  }
}

export function projectEntityToRecallSummary(
  node: EntityNode,
  aliases: EntityAlias[],
  latestEvent: EntityTimelineEvent | null,
  options?: ProjectionOptions
): MemoryRecord {
  if (!node.preferred_label.trim()) {
    throw new EntityLabelMissingError({
      entity_id: node.id,
      reason: 'missing_preferred_label',
    });
  }

  assertNoCircularMerge(node, options);

  const aliasText = aliases.map((alias) => alias.label).join(', ');
  const detailParts = [formatTimelineEventForRecall(latestEvent), aliasText].filter(
    (value): value is string => Boolean(value)
  );
  const scopeKind = node.scope_kind ?? 'global';
  const scopeId = node.scope_kind === null ? 'global' : (node.scope_id ?? 'global');

  return {
    id: node.id,
    topic: `entity/${node.id}`,
    kind: 'fact',
    summary: node.preferred_label,
    details: detailParts.join('\n'),
    confidence: 0.9,
    status: 'active',
    scopes: [{ kind: scopeKind, id: scopeId }],
    source: {
      package: 'mama-core',
      source_type: 'entity_canonical',
      project_id: node.scope_id ?? undefined,
    },
    created_at: node.created_at,
    updated_at: node.updated_at,
  };
}
