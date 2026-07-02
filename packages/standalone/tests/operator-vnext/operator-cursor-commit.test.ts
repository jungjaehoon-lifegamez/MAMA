import { describe, expect, it } from 'vitest';

process.env.MAMA_FORCE_TIER_3 ||= 'true';

import {
  buildConnectorIdempotencyKey,
  commitOperatorCursor,
} from '../../src/operator-vnext/operator-cursor-commit.js';
import { countRows, makeOperatorVNextDb } from './fixtures.js';

describe('STORY-VNEXT-PR2-CURSOR-COMMIT: atomic cursor commits', () => {
  describe('AC: cursor and durable commit move together', () => {
    it('commits changed refs and advances the cursor in one transaction', () => {
      const db = makeOperatorVNextDb();

      const result = commitOperatorCursor(db, {
        commitId: 'commit-1',
        cursorName: 'connector:slack',
        firstChangeSeq: 1,
        lastChangeSeq: 2,
        idempotencyKey: buildConnectorIdempotencyKey('slack', 1, 2),
        status: 'changed',
        changedRefs: [{ kind: 'os_task', id: 'task-1' }],
        sourceRefs: [{ kind: 'raw', connector: 'slack', id: 'event-1' }],
        nowMs: 1710000000000,
      });

      expect(result.outcome).toBe('committed');
      expect(result.cursorAdvanced).toBe(true);
      expect(
        db.prepare('SELECT last_change_seq, last_idempotency_key FROM vnext_operator_cursors').get()
      ).toEqual({
        last_change_seq: 2,
        last_idempotency_key: 'connector:slack:seq:1-2',
      });
      expect(
        db
          .prepare('SELECT status, changed_refs_json, source_refs_json FROM vnext_operator_commits')
          .get()
      ).toEqual({
        status: 'changed',
        changed_refs_json: '["os_task:task-1"]',
        source_refs_json: '["raw:slack:event-1"]',
      });

      db.close();
    });

    it('commits no-update rows and advances the cursor atomically', () => {
      const db = makeOperatorVNextDb();

      const result = commitOperatorCursor(db, {
        commitId: 'commit-no-update-1',
        cursorName: 'connector:slack',
        firstChangeSeq: 1,
        lastChangeSeq: 1,
        idempotencyKey: buildConnectorIdempotencyKey('slack', 1, 1),
        status: 'no_update',
        noUpdate: {
          noUpdateId: 'no-update-1',
          scopeKey: 'connector:slack',
          reason: 'event did not change canonical state',
        },
        sourceRefs: [{ kind: 'raw', connector: 'slack', id: 'event-1' }],
        nowMs: 1710000000000,
      });

      expect(result.outcome).toBe('committed');
      expect(countRows(db, 'vnext_operator_commits')).toBe(1);
      expect(countRows(db, 'operator_no_updates')).toBe(1);
      expect(
        db
          .prepare('SELECT last_change_seq FROM vnext_operator_cursors WHERE cursor_name = ?')
          .get('connector:slack')
      ).toEqual({ last_change_seq: 1 });

      db.close();
    });

    it('rejects no-update scopes that do not match the cursor', () => {
      const db = makeOperatorVNextDb();

      expect(() =>
        commitOperatorCursor(db, {
          commitId: 'commit-no-update-wrong-scope',
          cursorName: 'connector:slack',
          firstChangeSeq: 1,
          lastChangeSeq: 1,
          idempotencyKey: buildConnectorIdempotencyKey('slack', 1, 1),
          status: 'no_update',
          noUpdate: {
            noUpdateId: 'no-update-wrong-scope',
            scopeKey: 'connector:discord',
            reason: 'event did not change canonical state',
          },
          sourceRefs: [{ kind: 'raw', connector: 'slack', id: 'event-1' }],
          nowMs: 1710000000000,
        })
      ).toThrow(/scopeKey/i);
      expect(countRows(db, 'vnext_operator_commits')).toBe(0);
      expect(countRows(db, 'operator_no_updates')).toBe(0);

      db.close();
    });

    it('rejects non-contiguous commits without advancing the cursor', () => {
      const db = makeOperatorVNextDb();

      expect(() =>
        commitOperatorCursor(db, {
          commitId: 'commit-gap',
          cursorName: 'connector:slack',
          firstChangeSeq: 2,
          lastChangeSeq: 2,
          idempotencyKey: buildConnectorIdempotencyKey('slack', 2, 2),
          status: 'changed',
          changedRefs: [{ kind: 'os_task', id: 'task-2' }],
          sourceRefs: [{ kind: 'raw', connector: 'slack', id: 'event-2' }],
          nowMs: 1710000000000,
        })
      ).toThrow(/contiguous/i);
      expect(
        db
          .prepare('SELECT last_change_seq FROM vnext_operator_cursors WHERE cursor_name = ?')
          .get('connector:slack')
      ).toBeUndefined();
      expect(countRows(db, 'vnext_operator_commits')).toBe(0);

      db.close();
    });

    it('rejects invalid runtime statuses without inserting commits', () => {
      const db = makeOperatorVNextDb();

      expect(() =>
        commitOperatorCursor(db, {
          commitId: 'commit-invalid-status',
          cursorName: 'connector:slack',
          firstChangeSeq: 1,
          lastChangeSeq: 1,
          idempotencyKey: buildConnectorIdempotencyKey('slack', 1, 1),
          status: 'invalid' as never,
          changedRefs: [{ kind: 'os_task', id: 'task-1' }],
          sourceRefs: [{ kind: 'raw', connector: 'slack', id: 'event-1' }],
          nowMs: 1710000000000,
        })
      ).toThrow(/status/i);
      expect(countRows(db, 'vnext_operator_commits')).toBe(0);
      expect(countRows(db, 'vnext_operator_cursors')).toBe(0);

      db.close();
    });

    it('rejects changed commits without changed refs using a clear error', () => {
      const db = makeOperatorVNextDb();

      expect(() =>
        commitOperatorCursor(db, {
          commitId: 'commit-empty-changed-refs',
          cursorName: 'connector:slack',
          firstChangeSeq: 1,
          lastChangeSeq: 1,
          idempotencyKey: buildConnectorIdempotencyKey('slack', 1, 1),
          status: 'changed',
          changedRefs: [],
          sourceRefs: [{ kind: 'raw', connector: 'slack', id: 'event-1' }],
          nowMs: 1710000000000,
        })
      ).toThrow(/changedRefs must not be empty/i);
      expect(countRows(db, 'vnext_operator_commits')).toBe(0);
      expect(countRows(db, 'vnext_operator_cursors')).toBe(0);

      db.close();
    });

    it('rolls back commit rows when the no-update ledger insert fails', () => {
      const db = makeOperatorVNextDb();
      db.prepare(
        `INSERT INTO operator_no_updates (
          no_update_id, scope_key, reason, source_refs_json, idempotency_key, created_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?)`
      ).run(
        'no-update-duplicate',
        'connector:slack',
        'preexisting no-update',
        '["raw:slack:event-0"]',
        'connector:slack:seq:0-0',
        1710000000000
      );

      expect(() =>
        commitOperatorCursor(db, {
          commitId: 'commit-no-update-duplicate',
          cursorName: 'connector:slack',
          firstChangeSeq: 1,
          lastChangeSeq: 1,
          idempotencyKey: buildConnectorIdempotencyKey('slack', 1, 1),
          status: 'no_update',
          noUpdate: {
            noUpdateId: 'no-update-duplicate',
            scopeKey: 'connector:slack',
            reason: 'event did not change canonical state',
          },
          sourceRefs: [{ kind: 'raw', connector: 'slack', id: 'event-1' }],
          nowMs: 1710000000001,
        })
      ).toThrow(/UNIQUE constraint/i);

      expect(countRows(db, 'vnext_operator_commits')).toBe(0);
      expect(countRows(db, 'operator_no_updates')).toBe(1);
      expect(
        db
          .prepare('SELECT last_change_seq FROM vnext_operator_cursors WHERE cursor_name = ?')
          .get('connector:slack')
      ).toBeUndefined();

      db.close();
    });
  });

  describe('AC: idempotency recovers crash boundaries', () => {
    it('rejects idempotency keys with inverted change ranges', () => {
      expect(() => buildConnectorIdempotencyKey('slack', 3, 2)).toThrow(/lastChangeSeq/i);
    });

    it('recovers a cursor when a commit row exists but cursor was not advanced', () => {
      const db = makeOperatorVNextDb();
      db.prepare(
        `INSERT INTO vnext_operator_cursors (
          cursor_name, last_change_seq, last_idempotency_key, updated_at_ms
        ) VALUES (?, ?, ?, ?)`
      ).run('connector:slack', 0, null, 1710000000000);
      db.prepare(
        `INSERT INTO vnext_operator_commits (
          commit_id, cursor_name, idempotency_key, first_change_seq, last_change_seq,
          status, changed_refs_json, source_refs_json, created_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        'commit-orphaned',
        'connector:slack',
        'connector:slack:seq:1-1',
        1,
        1,
        'changed',
        '["os_task:task-1"]',
        '["raw:slack:event-1"]',
        1710000000000
      );

      const result = commitOperatorCursor(db, {
        commitId: 'commit-orphaned',
        cursorName: 'connector:slack',
        firstChangeSeq: 1,
        lastChangeSeq: 1,
        idempotencyKey: buildConnectorIdempotencyKey('slack', 1, 1),
        status: 'changed',
        changedRefs: [{ kind: 'os_task', id: 'task-1' }],
        sourceRefs: [{ kind: 'raw', connector: 'slack', id: 'event-1' }],
        nowMs: 1710000000001,
      });

      expect(result.outcome).toBe('recovered');
      expect(result.cursorAdvanced).toBe(true);
      expect(countRows(db, 'vnext_operator_commits')).toBe(1);
      expect(
        db.prepare('SELECT last_change_seq, last_idempotency_key FROM vnext_operator_cursors').get()
      ).toEqual({
        last_change_seq: 1,
        last_idempotency_key: 'connector:slack:seq:1-1',
      });

      db.close();
    });

    it('does not duplicate commits after the cursor already advanced', () => {
      const db = makeOperatorVNextDb();
      const input = {
        commitId: 'commit-once',
        cursorName: 'connector:slack',
        firstChangeSeq: 1,
        lastChangeSeq: 1,
        idempotencyKey: buildConnectorIdempotencyKey('slack', 1, 1),
        status: 'changed' as const,
        changedRefs: [{ kind: 'os_task' as const, id: 'task-1' }],
        sourceRefs: [{ kind: 'raw' as const, connector: 'slack', id: 'event-1' }],
        nowMs: 1710000000000,
      };

      expect(commitOperatorCursor(db, input).outcome).toBe('committed');
      expect(commitOperatorCursor(db, input).outcome).toBe('already_committed');
      expect(countRows(db, 'vnext_operator_commits')).toBe(1);

      db.close();
    });

    it('rejects idempotency-key reuse across different cursors without advancing the new cursor', () => {
      const db = makeOperatorVNextDb();
      const idempotencyKey = buildConnectorIdempotencyKey('slack', 1, 1);

      expect(
        commitOperatorCursor(db, {
          commitId: 'commit-slack',
          cursorName: 'connector:slack',
          firstChangeSeq: 1,
          lastChangeSeq: 1,
          idempotencyKey,
          status: 'changed',
          changedRefs: [{ kind: 'os_task', id: 'task-1' }],
          sourceRefs: [{ kind: 'raw', connector: 'slack', id: 'event-1' }],
          nowMs: 1710000000000,
        }).outcome
      ).toBe('committed');

      expect(() =>
        commitOperatorCursor(db, {
          commitId: 'commit-discord',
          cursorName: 'connector:discord',
          firstChangeSeq: 1,
          lastChangeSeq: 1,
          idempotencyKey,
          status: 'changed',
          changedRefs: [{ kind: 'os_task', id: 'task-2' }],
          sourceRefs: [{ kind: 'raw', connector: 'discord', id: 'event-1' }],
          nowMs: 1710000000001,
        })
      ).toThrow(/different cursor/i);

      expect(countRows(db, 'vnext_operator_commits')).toBe(1);
      expect(
        db
          .prepare('SELECT last_change_seq FROM vnext_operator_cursors WHERE cursor_name = ?')
          .get('connector:discord')
      ).toBeUndefined();

      db.close();
    });

    it('rejects divergent idempotency-key replays for the same cursor', () => {
      const db = makeOperatorVNextDb();
      const idempotencyKey = buildConnectorIdempotencyKey('slack', 1, 1);

      expect(
        commitOperatorCursor(db, {
          commitId: 'commit-original',
          cursorName: 'connector:slack',
          firstChangeSeq: 1,
          lastChangeSeq: 1,
          idempotencyKey,
          status: 'changed',
          changedRefs: [{ kind: 'os_task', id: 'task-1' }],
          sourceRefs: [{ kind: 'raw', connector: 'slack', id: 'event-1' }],
          nowMs: 1710000000000,
        }).outcome
      ).toBe('committed');

      expect(() =>
        commitOperatorCursor(db, {
          commitId: 'commit-replay',
          cursorName: 'connector:slack',
          firstChangeSeq: 1,
          lastChangeSeq: 1,
          idempotencyKey,
          status: 'changed',
          changedRefs: [{ kind: 'os_task', id: 'task-2' }],
          sourceRefs: [{ kind: 'raw', connector: 'slack', id: 'event-1' }],
          nowMs: 1710000000001,
        })
      ).toThrow(/Idempotency key replay/i);

      expect(countRows(db, 'vnext_operator_commits')).toBe(1);

      db.close();
    });

    it('normalizes no-update details before comparing idempotent replays', () => {
      const db = makeOperatorVNextDb();
      const input = {
        commitId: 'commit-no-update-trimmed',
        cursorName: 'connector:slack',
        firstChangeSeq: 1,
        lastChangeSeq: 1,
        idempotencyKey: buildConnectorIdempotencyKey('slack', 1, 1),
        status: 'no_update' as const,
        noUpdate: {
          noUpdateId: ' no-update-trimmed ',
          scopeKey: ' connector:slack ',
          reason: ' unchanged ',
        },
        sourceRefs: [{ kind: 'raw' as const, connector: 'slack', id: 'event-1' }],
        nowMs: 1710000000000,
      };

      expect(commitOperatorCursor(db, input).outcome).toBe('committed');
      expect(commitOperatorCursor(db, input).outcome).toBe('already_committed');
      expect(
        db.prepare('SELECT no_update_id, scope_key, reason FROM operator_no_updates').get()
      ).toEqual({
        no_update_id: 'no-update-trimmed',
        scope_key: 'connector:slack',
        reason: 'unchanged',
      });

      db.close();
    });

    it('rejects divergent no-update ids on idempotent replays', () => {
      const db = makeOperatorVNextDb();
      const idempotencyKey = buildConnectorIdempotencyKey('slack', 1, 1);

      expect(
        commitOperatorCursor(db, {
          commitId: 'commit-no-update-original',
          cursorName: 'connector:slack',
          firstChangeSeq: 1,
          lastChangeSeq: 1,
          idempotencyKey,
          status: 'no_update',
          noUpdate: {
            noUpdateId: 'no-update-original',
            scopeKey: 'connector:slack',
            reason: 'unchanged',
          },
          sourceRefs: [{ kind: 'raw', connector: 'slack', id: 'event-1' }],
          nowMs: 1710000000000,
        }).outcome
      ).toBe('committed');

      expect(() =>
        commitOperatorCursor(db, {
          commitId: 'commit-no-update-replay',
          cursorName: 'connector:slack',
          firstChangeSeq: 1,
          lastChangeSeq: 1,
          idempotencyKey,
          status: 'no_update',
          noUpdate: {
            noUpdateId: 'no-update-different',
            scopeKey: 'connector:slack',
            reason: 'unchanged',
          },
          sourceRefs: [{ kind: 'raw', connector: 'slack', id: 'event-1' }],
          nowMs: 1710000000001,
        })
      ).toThrow(/Idempotency key replay/i);

      expect(countRows(db, 'operator_no_updates')).toBe(1);

      db.close();
    });

    it('rejects divergent no-update details on idempotent replays', () => {
      const db = makeOperatorVNextDb();
      const idempotencyKey = buildConnectorIdempotencyKey('slack', 1, 1);

      expect(
        commitOperatorCursor(db, {
          commitId: 'commit-no-update-original',
          cursorName: 'connector:slack',
          firstChangeSeq: 1,
          lastChangeSeq: 1,
          idempotencyKey,
          status: 'no_update',
          noUpdate: {
            noUpdateId: 'no-update-original',
            scopeKey: 'connector:slack',
            reason: 'unchanged',
          },
          sourceRefs: [{ kind: 'raw', connector: 'slack', id: 'event-1' }],
          nowMs: 1710000000000,
        }).outcome
      ).toBe('committed');

      expect(() =>
        commitOperatorCursor(db, {
          commitId: 'commit-no-update-reason-replay',
          cursorName: 'connector:slack',
          firstChangeSeq: 1,
          lastChangeSeq: 1,
          idempotencyKey,
          status: 'no_update',
          noUpdate: {
            noUpdateId: 'no-update-original',
            scopeKey: 'connector:slack',
            reason: 'different reason',
          },
          sourceRefs: [{ kind: 'raw', connector: 'slack', id: 'event-1' }],
          nowMs: 1710000000001,
        })
      ).toThrow(/Idempotency key replay/i);

      expect(() =>
        commitOperatorCursor(db, {
          commitId: 'commit-no-update-source-replay',
          cursorName: 'connector:slack',
          firstChangeSeq: 1,
          lastChangeSeq: 1,
          idempotencyKey,
          status: 'no_update',
          noUpdate: {
            noUpdateId: 'no-update-original',
            scopeKey: 'connector:slack',
            reason: 'unchanged',
          },
          sourceRefs: [{ kind: 'raw', connector: 'slack', id: 'event-2' }],
          nowMs: 1710000000002,
        })
      ).toThrow(/Idempotency key replay/i);

      expect(countRows(db, 'operator_no_updates')).toBe(1);

      db.close();
    });
  });
});
