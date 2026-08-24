/**
 * Fix E deliverable (b): the delta gate on the 30-minute full-board producer.
 *
 * Synthetic rows only; in-memory sqlite. Nothing here touches ~/.mama.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import Database, { type SQLiteDatabase } from '../../src/sqlite.js';
import {
  agentNoticeTerm,
  composeBoardInputWatermark,
  connectorObservationTerm,
  memoryRecencyTerm,
  evaluateBoardFullDelta,
  BOARD_DELTA_WATERMARK_MAX_LENGTH,
  DEFAULT_BOARD_FULL_MAX_STALENESS_MS,
} from '../../src/operator/board-delta-gate.js';

function createBoardInputTables(db: SQLiteDatabase): void {
  // The columns the watermark reads. The real schemas are wider; the gate
  // deliberately depends on these only.
  db.exec(`
    CREATE TABLE connector_event_index (
      event_index_id TEXT PRIMARY KEY,
      source_connector TEXT NOT NULL,
      channel TEXT,
      operator_observation_seq INTEGER
    );
    CREATE TABLE decisions (
      id TEXT PRIMARY KEY,
      topic TEXT,
      created_at TEXT
    );
  `);
}

function insertEvent(db: SQLiteDatabase, id: string, connector: string, seq: number | null): void {
  db.prepare(
    `INSERT INTO connector_event_index
       (event_index_id, source_connector, channel, operator_observation_seq)
     VALUES (?, ?, ?, ?)`
  ).run(id, connector, 'room-a', seq);
}

describe('board input watermark terms', () => {
  let db: SQLiteDatabase;

  beforeEach(() => {
    db = new Database(':memory:');
    createBoardInputTables(db);
  });

  describe('connectorObservationTerm', () => {
    it('is stable for an unchanged index', () => {
      insertEvent(db, 'e1', 'alpha', 1);
      insertEvent(db, 'e2', 'alpha', 2);
      insertEvent(db, 'e3', 'beta', 7);

      expect(connectorObservationTerm(db)).toBe(connectorObservationTerm(db));
    });

    it('is canonically ordered regardless of insert order', () => {
      insertEvent(db, 'e1', 'beta', 7);
      insertEvent(db, 'e2', 'alpha', 2);
      const forward = connectorObservationTerm(db);

      const other = new Database(':memory:');
      createBoardInputTables(other);
      insertEvent(other, 'e2', 'alpha', 2);
      insertEvent(other, 'e1', 'beta', 7);

      expect(connectorObservationTerm(other)).toBe(forward);
    });

    it('advances when a connector observes a new event', () => {
      insertEvent(db, 'e1', 'alpha', 1);
      const before = connectorObservationTerm(db);
      insertEvent(db, 'e2', 'alpha', 2);
      expect(connectorObservationTerm(db)).not.toBe(before);
    });

    it('advances when an existing event is re-sequenced after a content change', () => {
      insertEvent(db, 'e1', 'alpha', 1);
      const before = connectorObservationTerm(db);
      // A content change nulls operator_observation_seq, which the DB trigger
      // reassigns above the connector's high-water mark (migration 062).
      db.prepare(
        `UPDATE connector_event_index SET operator_observation_seq = 9 WHERE event_index_id = ?`
      ).run('e1');
      expect(connectorObservationTerm(db)).not.toBe(before);
    });

    it('does not advance for a re-poll that changes nothing', () => {
      insertEvent(db, 'e1', 'alpha', 1);
      const before = connectorObservationTerm(db);
      // A no-op upsert bumps updated_at but leaves the observation seq intact,
      // which is why the term reads the seq and not a timestamp.
      db.prepare(
        `UPDATE connector_event_index SET channel = 'room-a' WHERE event_index_id = ?`
      ).run('e1');
      expect(connectorObservationTerm(db)).toBe(before);
    });

    it('throws when the index is unavailable (caller decides, never silent)', () => {
      expect(() => connectorObservationTerm(new Database(':memory:'))).toThrow();
    });
  });

  describe('memoryRecencyTerm', () => {
    it('advances when a decision is saved', () => {
      const before = memoryRecencyTerm(db);
      db.prepare(`INSERT INTO decisions (id, topic, created_at) VALUES ('d1', 't', 'now')`).run();
      expect(memoryRecencyTerm(db)).not.toBe(before);
    });

    it('throws when the decisions table is unavailable', () => {
      expect(() => memoryRecencyTerm(new Database(':memory:'))).toThrow();
    });
  });

  describe('agentNoticeTerm', () => {
    it('advances when a new notice is emitted and is stable otherwise', () => {
      const notices = [{ timestamp: 1000 }];
      const before = agentNoticeTerm(notices);
      expect(agentNoticeTerm([{ timestamp: 1000 }])).toBe(before);
      expect(agentNoticeTerm([{ timestamp: 2000 }, { timestamp: 1000 }])).not.toBe(before);
    });

    it('reads an empty ring without throwing', () => {
      expect(agentNoticeTerm([]).length).toBeGreaterThan(0);
    });
  });

  describe('composeBoardInputWatermark', () => {
    it('changes when ANY term changes', () => {
      const base = composeBoardInputWatermark(['a', 'b', 'c']);
      expect(composeBoardInputWatermark(['a', 'b', 'c'])).toBe(base);
      expect(composeBoardInputWatermark(['a2', 'b', 'c'])).not.toBe(base);
      expect(composeBoardInputWatermark(['a', 'b2', 'c'])).not.toBe(base);
      expect(composeBoardInputWatermark(['a', 'b', 'c2'])).not.toBe(base);
    });

    it('stays inside the workorder payload bound', () => {
      const huge = Array.from({ length: 400 }, (_, index) => `term-${index}-${'x'.repeat(50)}`);
      const composed = composeBoardInputWatermark(huge);
      expect(composed.length).toBeLessThanOrEqual(BOARD_DELTA_WATERMARK_MAX_LENGTH);
      expect(composed.length).toBeGreaterThan(0);
    });
  });
});

describe('evaluateBoardFullDelta', () => {
  const publishedBaseline = (watermark: string | null) => ({
    watermark,
    createdAt: 1_000,
    completedAt: 2_000,
  });
  const base = {
    now: () => 3_000,
    readBoardPublishedAt: () => 1_500,
  };

  it('enqueues when no completed full run has recorded a baseline yet', () => {
    const decision = evaluateBoardFullDelta({
      ...base,
      readWatermark: () => 'w1',
      readBaseline: () => null,
    });

    expect(decision).toMatchObject({ enqueue: true, watermark: 'w1', reason: 'no-baseline' });
    expect(decision.warning).toBeNull();
  });

  it('enqueues when the last completed full run recorded no watermark', () => {
    const decision = evaluateBoardFullDelta({
      ...base,
      readWatermark: () => 'w1',
      readBaseline: () => publishedBaseline(null),
    });

    expect(decision.enqueue).toBe(true);
    expect(decision.reason).toBe('no-baseline');
  });

  it('skips when nothing the board reads has moved since the last completed full run', () => {
    const decision = evaluateBoardFullDelta({
      ...base,
      readWatermark: () => 'w1',
      readBaseline: () => publishedBaseline('w1'),
    });

    expect(decision).toMatchObject({ enqueue: false, reason: 'no-delta', warning: null });
  });

  it('enqueues when the watermark moved', () => {
    const decision = evaluateBoardFullDelta({
      ...base,
      readWatermark: () => 'w2',
      readBaseline: () => publishedBaseline('w1'),
    });

    expect(decision).toMatchObject({ enqueue: true, watermark: 'w2', reason: 'delta' });
  });

  it('enqueues when the last completed full run left no board behind (unverified run)', () => {
    // A run that reached done without publishing is not evidence of a rebuilt
    // board, so its watermark must not license a skip.
    const decision = evaluateBoardFullDelta({
      ...base,
      readBoardPublishedAt: () => 500, // older than the run's enqueue time
      readWatermark: () => 'w1',
      readBaseline: () => publishedBaseline('w1'),
    });

    expect(decision).toMatchObject({ enqueue: true, reason: 'unpublished' });
  });

  it('enqueues once the last completed full run passes the staleness bound', () => {
    const decision = evaluateBoardFullDelta({
      readWatermark: () => 'w1',
      readBaseline: () => publishedBaseline('w1'),
      readBoardPublishedAt: () => 1_500,
      now: () => 2_000 + DEFAULT_BOARD_FULL_MAX_STALENESS_MS,
    });

    expect(decision).toMatchObject({ enqueue: true, reason: 'stale' });
  });

  it('still skips just inside the staleness bound', () => {
    const decision = evaluateBoardFullDelta({
      readWatermark: () => 'w1',
      readBaseline: () => publishedBaseline('w1'),
      readBoardPublishedAt: () => 1_500,
      now: () => 2_000 + DEFAULT_BOARD_FULL_MAX_STALENESS_MS - 1,
    });

    expect(decision.enqueue).toBe(false);
  });

  it('enqueues and warns when any signal is unavailable', () => {
    for (const broken of ['watermark', 'baseline', 'published'] as const) {
      const decision = evaluateBoardFullDelta({
        ...base,
        readWatermark: () => {
          if (broken === 'watermark') throw new Error('no such table: connector_event_index');
          return 'w1';
        },
        readBaseline: () => {
          if (broken === 'baseline') throw new Error('ledger closed');
          return publishedBaseline('w1');
        },
        readBoardPublishedAt: () => {
          if (broken === 'published') throw new Error('report store closed');
          return 1_500;
        },
      });

      expect(decision.enqueue).toBe(true);
      expect(decision.watermark).toBeNull();
      expect(decision.reason).toBe('signal-unavailable');
      expect(decision.warning).toBeTruthy();
    }
  });
});
