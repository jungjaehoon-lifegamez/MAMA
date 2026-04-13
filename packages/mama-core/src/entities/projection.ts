import { EntityLabelMissingError } from './errors.js';
import type { EntityAlias, EntityNode, EntityTimelineEvent } from './types.js';
import type { MemoryRecord } from '../memory/types.js';

interface ProjectionOptions {
  nodeLookup?: Record<string, EntityNode>;
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
  const detailParts = [latestEvent?.summary, latestEvent?.details, aliasText].filter(
    (value): value is string => Boolean(value)
  );

  return {
    id: node.id,
    topic: `entity/${node.id}`,
    kind: 'fact',
    summary: node.preferred_label,
    details: detailParts.join('\n'),
    confidence: 0.9,
    status: 'active',
    scopes: [{ kind: node.scope_kind, id: node.scope_id ?? 'global' }],
    source: {
      package: 'mama-core',
      source_type: 'entity_canonical',
      project_id: node.scope_id ?? undefined,
    },
    created_at: node.created_at,
    updated_at: node.updated_at,
  };
}
