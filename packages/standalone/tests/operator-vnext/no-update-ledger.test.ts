import { describe, expect, it } from 'vitest';

import { recordNoUpdate } from '../../src/operator-vnext/no-update-ledger.js';
import { makeOperatorVNextDb } from './fixtures.js';

describe('STORY-VNEXT-PR2-NO-UPDATE-LEDGER: no-update ledger writes', () => {
  describe('AC: no-update rows require source refs and idempotency', () => {
    it('records no-update decisions with serialized source refs', () => {
      const db = makeOperatorVNextDb();

      const row = recordNoUpdate(db, {
        noUpdateId: 'no-update-1',
        scopeKey: 'connector:slack',
        reason: 'no durable state changed',
        sourceRefs: [{ kind: 'raw', connector: 'slack', id: 'event-1' }],
        idempotencyKey: 'connector:slack:seq:1-1',
        nowMs: 1710000000000,
      });

      expect(row).toEqual({
        noUpdateId: 'no-update-1',
        scopeKey: 'connector:slack',
        reason: 'no durable state changed',
        sourceRefs: ['raw:slack:event-1'],
        idempotencyKey: 'connector:slack:seq:1-1',
        createdAtMs: 1710000000000,
      });
      expect(
        db
          .prepare('SELECT source_refs_json FROM operator_no_updates WHERE no_update_id = ?')
          .get('no-update-1')
      ).toEqual({ source_refs_json: '["raw:slack:event-1"]' });

      db.close();
    });

    it('rejects empty source refs before inserting no-update rows', () => {
      const db = makeOperatorVNextDb();

      expect(() =>
        recordNoUpdate(db, {
          noUpdateId: 'no-update-empty',
          scopeKey: 'connector:slack',
          reason: 'unchanged',
          sourceRefs: [],
          idempotencyKey: 'connector:slack:seq:1-1',
          nowMs: 1710000000000,
        })
      ).toThrow(/source refs/i);
      expect(db.prepare('SELECT COUNT(*) AS count FROM operator_no_updates').get()).toEqual({
        count: 0,
      });

      db.close();
    });
  });
});
