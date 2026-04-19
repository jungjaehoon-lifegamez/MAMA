
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  evaluateAgainstBaselines,
  RANKER_QUALITY_FIXTURES,
  seedQualityFixtureFeedback,
  trainOfflineRanker,
  type RankerTrainerAdapter,
} from '../../src/search/ranker-trainer.js';

import { applyMigrationsThrough } from '../../src/test-utils.js';
describe('Phase 3 Task 12: ranker quality fixtures', () => {
  let db: Database.Database;
  let adapter: RankerTrainerAdapter;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    applyMigrationsThrough(db, 30);
    adapter = db as unknown as RankerTrainerAdapter;
  });

  afterEach(() => {
    db.close();
  });

  it('trains on seeded fixtures and beats baselines by the activation margin', async () => {
    seedQualityFixtureFeedback(adapter);

    const training = await trainOfflineRanker({
      adapter,
      minFeedbackRows: 8,
      minDistinctQueries: 8,
      since: '2026-04-17T00:00:00.000Z',
      until: '2026-04-19T00:00:00.000Z',
    });

    expect(training.status).toBe('trained');
    expect(RANKER_QUALITY_FIXTURES).toHaveLength(8);

    const evaluation = await evaluateAgainstBaselines(
      {
        adapter,
        minFeedbackRows: 8,
        minDistinctQueries: 8,
      },
      training.model!
    );

    const baselines = [evaluation.bm25, evaluation.vector, evaluation.rrf, evaluation.logistic];
    const bestAggregateNdcg = Math.max(...baselines.map((metric) => metric.ndcg));
    const bestAggregateMrr = Math.max(...baselines.map((metric) => metric.mrr));

    for (const fixture of RANKER_QUALITY_FIXTURES) {
      const learned = evaluation.learned.per_query[fixture.query];
      const bestBaseline = Math.max(
        ...baselines.map((metric) => metric.per_query[fixture.query].ndcg)
      );
      expect(learned.ndcg).toBeGreaterThanOrEqual(bestBaseline - 0.0001);
    }

    expect(evaluation.learned.ndcg).toBeGreaterThanOrEqual(bestAggregateNdcg + 0.01);
    expect(evaluation.learned.mrr).toBeGreaterThanOrEqual(bestAggregateMrr + 0.01);
    expect(evaluation.passes).toBe(true);
  });
});
