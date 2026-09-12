import { describe, expect, it } from 'vitest';

import {
  canonicalOwnerActionJson,
  ownerActionOriginMatch,
  verifyOwnerActionContext,
} from '../../src/operations/owner-action-effects.js';

describe('Story PR3A: owner action effect policy', () => {
  describe('Acceptance Criteria', () => {
    it('requires one truthful execution origin', () => {
      expect(() =>
        verifyOwnerActionContext({
          ownerScope: 'owner:synthetic',
          occurrenceKey: 'occurrence:1',
          envelopeHash: 'envelope:1',
        })
      ).toThrow(/modelRunId or operationId/);
    });

    it('gives operation origin precedence over causal model provenance', () => {
      const verified = verifyOwnerActionContext({
        ownerScope: 'owner:synthetic',
        occurrenceKey: 'occurrence:1',
        modelRunId: 'run:causal',
        operationId: 'operation:executor',
        envelopeHash: 'envelope:1',
      });
      expect(ownerActionOriginMatch(verified)).toEqual({
        clause: 'origin_operation_id = ?',
        params: ['operation:executor'],
      });
    });

    it('canonicalizes intent object keys without changing array order', () => {
      expect(canonicalOwnerActionJson({ z: 1, a: ['second', 'first'] })).toBe(
        '{"a":["second","first"],"z":1}'
      );
    });
  });
});
