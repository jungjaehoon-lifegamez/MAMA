import { describe, expect, it } from 'vitest';
import { EntityError, InvalidEntityLabelError } from '../../src/entities/errors.js';

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
