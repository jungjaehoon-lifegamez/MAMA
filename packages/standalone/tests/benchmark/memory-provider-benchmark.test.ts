/**
 * Memory Provider Benchmark
 *
 * Tests the full save → recall path through mama-core APIs.
 * This validates that decisions saved via the runtime pipeline
 * can be accurately recalled via semantic search.
 *
 * Run: pnpm --dir packages/standalone test tests/benchmark/memory-provider-benchmark.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { RECALL_SCENARIOS, SUPERSEDE_SCENARIOS } from './scenarios.js';

const require = createRequire(import.meta.url);
const TEST_DB = '/tmp/test-memory-provider-benchmark.db';

interface MamaApi {
  save(input: {
    topic: string;
    decision: string;
    reasoning: string;
    confidence?: number;
    type?: string;
    scopes?: Array<{ kind: string; id: string }>;
  }): Promise<{ success: boolean; id?: string }>;
  suggest(
    query: string,
    options?: { limit?: number }
  ): Promise<{
    results?: Array<{ id: string; topic: string; decision: string; similarity: number }>;
  }>;
  recallMemory(
    query: string,
    options?: { scopes?: Array<{ kind: string; id: string }>; includeProfile?: boolean }
  ): Promise<{ memories?: Array<{ topic?: string; summary?: string }> }>;
}

interface BenchmarkResult {
  name: string;
  saveSuccess: boolean;
  recallSuccess: boolean;
  recallContent: string;
  saveLatencyMs: number;
  recallLatencyMs: number;
}

const SCOPES = [{ kind: 'project' as const, id: '/benchmark' }];

describe('Memory Provider Benchmark: Save → Recall', () => {
  let mamaApi: MamaApi;
  const results: BenchmarkResult[] = [];

  beforeAll(async () => {
    [TEST_DB, `${TEST_DB}-journal`, `${TEST_DB}-wal`, `${TEST_DB}-shm`].forEach((f) => {
      try {
        fs.unlinkSync(f);
      } catch {
        /* cleanup */
      }
    });
    process.env.MAMA_DB_PATH = TEST_DB;
    mamaApi = require('@jungjaehoon/mama-core/mama-api');
  });

  afterAll(async () => {
    const dbManager = await import('@jungjaehoon/mama-core/db-manager');
    await dbManager.closeDB();
    delete process.env.MAMA_DB_PATH;
    [TEST_DB, `${TEST_DB}-journal`, `${TEST_DB}-wal`, `${TEST_DB}-shm`].forEach((f) => {
      try {
        fs.unlinkSync(f);
      } catch {
        /* cleanup */
      }
    });

    // Print benchmark report
    console.log('\n╔══════════════════════════════════════════════════════════╗');
    console.log('║         MEMORY PROVIDER BENCHMARK REPORT                ║');
    console.log('╠══════════════════════════════════════════════════════════╣');

    const totalTests = results.length;
    const saveSuccesses = results.filter((r) => r.saveSuccess).length;
    const recallSuccesses = results.filter((r) => r.recallSuccess).length;
    const avgSaveMs = results.reduce((s, r) => s + r.saveLatencyMs, 0) / totalTests || 0;
    const avgRecallMs = results.reduce((s, r) => s + r.recallLatencyMs, 0) / totalTests || 0;

    for (const r of results) {
      const status = r.saveSuccess && r.recallSuccess ? '✅ PASS' : '❌ FAIL';
      console.log(
        `║ ${status} │ ${r.name.padEnd(30)} │ save:${r.saveLatencyMs.toString().padStart(5)}ms │ recall:${r.recallLatencyMs.toString().padStart(5)}ms ║`
      );
    }

    console.log('╠══════════════════════════════════════════════════════════╣');
    console.log(
      `║ Save accuracy:   ${saveSuccesses}/${totalTests} (${Math.round((saveSuccesses / totalTests) * 100)}%)`.padEnd(
        59
      ) + '║'
    );
    console.log(
      `║ Recall accuracy: ${recallSuccesses}/${totalTests} (${Math.round((recallSuccesses / totalTests) * 100)}%)`.padEnd(
        59
      ) + '║'
    );
    console.log(`║ Avg save latency:   ${Math.round(avgSaveMs)}ms`.padEnd(59) + '║');
    console.log(`║ Avg recall latency: ${Math.round(avgRecallMs)}ms`.padEnd(59) + '║');
    console.log('╚══════════════════════════════════════════════════════════╝\n');
  });

  describe('Direct save → recall', () => {
    for (const scenario of RECALL_SCENARIOS) {
      it(`${scenario.name}: saves and recalls correctly`, async () => {
        // Save
        const saveStart = Date.now();
        const saveResult = await mamaApi.save({
          topic: scenario.saveTopic,
          decision: scenario.saveText,
          reasoning: scenario.saveReasoning,
          confidence: 0.9,
          type: 'user_decision',
          scopes: SCOPES,
        });
        const saveLatencyMs = Date.now() - saveStart;
        expect(saveResult.success).toBe(true);

        // Recall via suggest (semantic search)
        const recallStart = Date.now();
        const searchResult = await mamaApi.suggest(scenario.recallQuery, { limit: 5 });
        const recallLatencyMs = Date.now() - recallStart;

        const topResults = searchResult?.results ?? [];
        const found = topResults.some(
          (r) => r.decision?.includes(scenario.expectedInRecall) || r.topic === scenario.saveTopic
        );

        results.push({
          name: scenario.name,
          saveSuccess: saveResult.success === true,
          recallSuccess: found,
          recallContent: topResults[0]?.decision ?? '<empty>',
          saveLatencyMs,
          recallLatencyMs,
        });

        expect(found).toBe(true);
      });
    }
  });

  describe('Supersede: latest decision wins', () => {
    for (const scenario of SUPERSEDE_SCENARIOS) {
      it(`${scenario.name}: second save supersedes first on recall`, async () => {
        // Save first decision
        const save1Start = Date.now();
        const save1 = await mamaApi.save({
          topic: scenario.firstSave.topic,
          decision: scenario.firstSave.decision,
          reasoning: scenario.firstSave.reasoning,
          confidence: 0.8,
          type: 'user_decision',
          scopes: SCOPES,
        });
        const save1Ms = Date.now() - save1Start;
        expect(save1.success).toBe(true);

        // Save second decision (supersedes)
        const save2Start = Date.now();
        const save2 = await mamaApi.save({
          topic: scenario.secondSave.topic,
          decision: scenario.secondSave.decision,
          reasoning: `${scenario.secondSave.reasoning}. supersedes: previous ${scenario.firstSave.topic} decision`,
          confidence: 0.9,
          type: 'user_decision',
          scopes: SCOPES,
        });
        const save2Ms = Date.now() - save2Start;
        expect(save2.success).toBe(true);

        // Recall — should find the latest
        const recallStart = Date.now();
        const searchResult = await mamaApi.suggest(scenario.recallQuery, { limit: 3 });
        const recallMs = Date.now() - recallStart;

        const topResults = searchResult?.results ?? [];
        const topDecision = topResults[0]?.decision ?? '';
        const foundLatest = topDecision.includes(scenario.expectedInRecall);

        results.push({
          name: `${scenario.name} (supersede)`,
          saveSuccess: save1.success && save2.success,
          recallSuccess: foundLatest,
          recallContent: topDecision,
          saveLatencyMs: save1Ms + save2Ms,
          recallLatencyMs: recallMs,
        });

        expect(foundLatest).toBe(true);
      });
    }
  });

  describe('Recall via recallMemory API', () => {
    it('recallMemory returns scoped memories with profile', async () => {
      const recallStart = Date.now();
      const bundle = await mamaApi.recallMemory('What database do we use?', {
        scopes: SCOPES,
        includeProfile: true,
      });
      const recallMs = Date.now() - recallStart;

      const memories = bundle?.memories ?? [];

      results.push({
        name: 'recallMemory-scoped',
        saveSuccess: true,
        recallSuccess: memories.length > 0,
        recallContent: memories[0]?.summary ?? '<empty>',
        saveLatencyMs: 0,
        recallLatencyMs: recallMs,
      });

      expect(memories.length).toBeGreaterThan(0);
    });
  });
});
