import { describe, expect, it } from 'vitest';
import {
  AuditRunInProgressError,
  CandidateStaleError,
  EmbeddingUnavailableError,
  EntityError,
  EntityLabelMissingError,
  InvalidEntityLabelError,
  MergeTargetStaleError,
  OntologyViolationError,
} from '../../src/entities/errors.js';

describe('Story E1.2: Canonical entity error contracts', () => {
  describe('AC #1: Every entity error extends the shared base contract', () => {
    it('should keep InvalidEntityLabelError on the EntityError inheritance chain', () => {
      const err = new InvalidEntityLabelError({
        input: null,
        reason: 'null_input',
      });

      expect(err).toBeInstanceOf(Error);
      expect(err).toBeInstanceOf(EntityError);
      expect(err.code).toBe('entity.invalid_label');
      expect(err.doc_section).toBe('#invalid-label');
      expect(err.context).toEqual({ input: null, reason: 'null_input' });
      expect(err.hint).toContain('label');
    });

    it('should expose all named entity error classes', () => {
      const variants = [
        new EmbeddingUnavailableError({
          model: 'multilingual-e5-large',
        }),
        new OntologyViolationError({
          entity_kind: 'project',
          attempted_relation: 'works_on',
        }),
        new MergeTargetStaleError({
          target_entity_id: 'entity_project_alpha',
        }),
        new EntityLabelMissingError({
          entity_id: 'entity_project_alpha',
        }),
        new CandidateStaleError({
          candidate_id: 'candidate_1',
        }),
        new AuditRunInProgressError({
          running_run_id: 'audit_run_1',
        }),
      ];

      for (const err of variants) {
        expect(err).toBeInstanceOf(EntityError);
        expect(typeof err.code).toBe('string');
        expect(err.code.startsWith('entity.')).toBe(true);
        expect(typeof err.doc_section).toBe('string');
        expect(err.doc_section.startsWith('#')).toBe(true);
        expect(typeof err.hint).toBe('string');
        expect(err.hint.length).toBeGreaterThan(0);
        expect(err.context).toBeTypeOf('object');
      }
    });
  });

  describe('AC #2: HTTP serialization exposes the approved envelope shape', () => {
    it('should serialize InvalidEntityLabelError into an API-safe envelope', () => {
      const err = new InvalidEntityLabelError({
        input: null,
        reason: 'null_input',
      });

      expect(err.toErrorEnvelope()).toEqual({
        error: {
          code: 'entity.invalid_label',
          message: 'Invalid entity label.',
          hint: 'Provide a non-empty entity label before normalization.',
          doc_url: 'docs/operations/entity-substrate-runbook.md#invalid-label',
        },
      });
    });
  });
});
