import { describe, expect, it } from 'vitest';
import { EntityLabelMissingError } from '../../src/entities/errors.js';
import { projectEntityToRecallSummary } from '../../src/entities/projection.js';
import type { EntityAlias, EntityNode, EntityTimelineEvent } from '../../src/entities/types.js';

describe('Story E1.7: Canonical entity projection', () => {
  const baseNode: EntityNode = {
    id: 'entity_project_alpha',
    kind: 'project',
    preferred_label: 'Project Alpha',
    status: 'active',
    scope_kind: 'project',
    scope_id: 'scope-alpha',
    merged_into: null,
    created_at: 1710000000000,
    updated_at: 1710000001000,
  };

  const aliases: EntityAlias[] = [
    {
      id: 'alias_ja',
      entity_id: 'entity_project_alpha',
      label: '\u30D7\u30ED\u30B8\u30A7\u30AF\u30C8\u30A2\u30EB\u30D5\u30A1',
      normalized_label: '\u30D7\u30ED\u30B8\u30A7\u30AF\u30C8\u30A2\u30EB\u30D5\u30A1',
      lang: 'ja',
      script: 'Jpan',
      label_type: 'alt',
      source_type: 'slack',
      source_ref: 'slack:C123',
      confidence: 0.9,
      status: 'active',
      created_at: 1710000002000,
    },
  ];

  const latestEvent: EntityTimelineEvent = {
    id: 'timeline_1',
    entity_id: 'entity_project_alpha',
    event_type: 'status_update',
    valid_from: 1710000003000,
    valid_to: null,
    observed_at: 1710000003000,
    source_ref: 'slack:C123:1710000000.000100',
    summary: 'Launch status updated',
    details: 'Moved from planning to active execution.',
    created_at: 1710000003000,
  };

  it('projects a canonical entity into a recall-shaped record', () => {
    const record = projectEntityToRecallSummary(baseNode, aliases, latestEvent);

    expect(record.id).toBe('entity_project_alpha');
    expect(record.summary).toBe('Project Alpha');
    expect(record.source.source_type).toBe('entity_canonical');
    expect(record.details).toContain('Launch status updated');
    expect(record.details).toContain(
      '\u30D7\u30ED\u30B8\u30A7\u30AF\u30C8\u30A2\u30EB\u30D5\u30A1'
    );
  });

  it('fails loudly when the preferred label is missing', () => {
    expect(() =>
      projectEntityToRecallSummary(
        {
          ...baseNode,
          preferred_label: '',
        },
        aliases,
        latestEvent
      )
    ).toThrow(EntityLabelMissingError);
  });

  it('detects circular merged_into chains before projecting', () => {
    expect(() =>
      projectEntityToRecallSummary(baseNode, aliases, latestEvent, {
        nodeLookup: {
          entity_project_alpha: { ...baseNode, merged_into: 'entity_project_beta' },
          entity_project_beta: {
            ...baseNode,
            id: 'entity_project_beta',
            merged_into: 'entity_project_alpha',
          },
        },
      })
    ).toThrow(EntityLabelMissingError);
  });
});
