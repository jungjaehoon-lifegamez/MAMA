#!/usr/bin/env tsx
/**
 * MAMA Memory Benchmark Runner
 *
 * Production-level benchmark using LongMemEval dataset.
 * Uses mama-core directly (no HTTP API needed) and Claude CLI for judging.
 *
 * Usage:
 *   pnpm --dir packages/standalone bench:sample   # 12 questions (2 per category)
 *   pnpm --dir packages/standalone bench:full     # all 500 questions
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { createRequire } from 'module';
import { execSync } from 'child_process';

const require = createRequire(import.meta.url);

// ── Types ──────────────────────────────────────────────────────────────────

interface LongMemEvalQuestion {
  question_id: string;
  question_type: string;
  question: string;
  answer: string;
  haystack_sessions: Array<Array<{ role: string; content: string }>>;
}

interface BenchmarkResult {
  questionId: string;
  questionType: string;
  question: string;
  groundTruth: string;
  searchResults: number;
  searchMs: number;
  ingestMs: number;
  topSimilarity: number;
  answer: string;
  correct: boolean;
  judgeReason: string;
}

interface BenchmarkReport {
  runId: string;
  timestamp: string;
  totalQuestions: number;
  correctCount: number;
  accuracy: number;
  avgSearchMs: number;
  avgIngestMs: number;
  judgeMethod: string;
  byCategory: Record<string, { total: number; correct: number; accuracy: number }>;
  results: BenchmarkResult[];
}

// ── Configuration ──────────────────────────────────────────────────────────

const DATASET_PATH =
  process.env.LONGMEMEVAL_PATH ||
  join(
    homedir(),
    '.mama/workspace/memorybench/data/benchmarks/longmemeval/datasets/longmemeval_s_cleaned.json'
  );
const RESULTS_DIR = join(dirname(new URL(import.meta.url).pathname), 'results');
const BENCH_DB = '/tmp/mama-bench-run.db';

// ── mama-core direct access ────────────────────────────────────────────────

function initMamaCore() {
  // Clean previous bench DB
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    try {
      unlinkSync(`${BENCH_DB}${suffix}`);
    } catch {
      /* ok */
    }
  }
  process.env.MAMA_DB_PATH = BENCH_DB;

  const mamaApi = require('@jungjaehoon/mama-core/mama-api');
  const mamaCore = require('@jungjaehoon/mama-core');

  // Inject Claude CLI as extraction backend (no API key needed)
  const { parseExtractionResponse } = mamaCore;
  mamaCore.setExtractionFn(async (prompt: string) => {
    const result = execSync(
      `echo ${JSON.stringify(prompt)} | claude --print --model claude-haiku-4-5-20251001 2>/dev/null`,
      { timeout: 30000, encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 }
    ).trim();
    return parseExtractionResponse(result);
  });

  return { ...mamaApi, ingestConversation: mamaCore.ingestConversation };
}

async function closeMamaCore() {
  const dbManager = await import('@jungjaehoon/mama-core/db-manager');
  await dbManager.closeDB();
  delete process.env.MAMA_DB_PATH;
}

// ── Judge via Claude CLI ───────────────────────────────────────────────────

function judgeWithClaude(
  question: string,
  groundTruth: string,
  answer: string
): { correct: boolean; reason: string } {
  const prompt = `Judge if the answer correctly addresses the question. Reply ONLY "CORRECT" or "INCORRECT" then a brief reason.
Question: ${question}
Ground truth: ${groundTruth}
Answer: ${answer}`;

  try {
    const result = execSync(
      `echo ${JSON.stringify(prompt)} | claude --print --model claude-haiku-4-5-20251001 2>/dev/null`,
      { timeout: 15000, encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 }
    ).trim();
    const correct = result.toUpperCase().startsWith('CORRECT');
    return { correct, reason: result.slice(0, 200) };
  } catch {
    // Fallback to keyword judge
    return keywordJudge(groundTruth, answer);
  }
}

function keywordJudge(groundTruth: string, answer: string): { correct: boolean; reason: string } {
  const normalizedAnswer = answer.toLowerCase();
  const numbers = groundTruth.match(/\d[\d,./:]+/g) ?? [];
  const properNouns = groundTruth.match(/[A-Z][a-z]{2,}/g) ?? [];
  const keyEntities = [
    ...numbers.map((n) => n.toLowerCase()),
    ...properNouns.map((n) => n.toLowerCase()),
  ];

  if (keyEntities.length > 0) {
    const entityMatches = keyEntities.filter((e) => normalizedAnswer.includes(e));
    const correct = entityMatches.length >= Math.ceil(keyEntities.length * 0.4);
    return { correct, reason: `entity-match: ${entityMatches.length}/${keyEntities.length}` };
  }

  const truthWords = groundTruth
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 3);
  const matches = truthWords.filter((w) => normalizedAnswer.includes(w));
  const correct = matches.length >= Math.ceil(truthWords.length * 0.4);
  return { correct, reason: `keyword-match: ${matches.length}/${truthWords.length}` };
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const mode = args[0] || 'sample';

  // Check dataset
  if (!existsSync(DATASET_PATH)) {
    console.error(`Dataset not found: ${DATASET_PATH}`);
    process.exit(1);
  }

  // Check Claude CLI for judging
  let useClaude = false;
  try {
    execSync('which claude', { encoding: 'utf-8' });
    useClaude = true;
  } catch {
    console.log('Claude CLI not found, using keyword judge');
  }

  const dataset: LongMemEvalQuestion[] = JSON.parse(readFileSync(DATASET_PATH, 'utf-8'));
  console.log(`Loaded ${dataset.length} questions from LongMemEval`);

  // Select questions
  let questions: LongMemEvalQuestion[];
  if (mode === 'full') {
    questions = dataset;
  } else if (mode === 'sample') {
    const byType: Record<string, LongMemEvalQuestion[]> = {};
    for (const q of dataset) {
      if (!byType[q.question_type]) byType[q.question_type] = [];
      byType[q.question_type].push(q);
    }
    questions = [];
    for (const items of Object.values(byType)) {
      items.sort((a, b) => a.haystack_sessions.length - b.haystack_sessions.length);
      questions.push(...items.slice(0, 2));
    }
  } else {
    questions = dataset.filter((q) => q.question_type === mode);
    if (questions.length === 0) {
      console.error(`No questions for category: ${mode}`);
      process.exit(1);
    }
  }

  console.log(`Running ${questions.length} questions (mode: ${mode})`);
  console.log(`Judge: ${useClaude ? 'Claude CLI (haiku)' : 'keyword matching'}`);
  console.log(`DB: ${BENCH_DB} (fresh per run)\n`);

  const results: BenchmarkResult[] = [];
  const runId = `mama-bench-${mode}-${Date.now()}`;

  // Initialize mama-core with fresh DB for each question
  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
    const prefix = `[${i + 1}/${questions.length}]`;
    process.stdout.write(`${prefix} ${q.question_type}: ${q.question.slice(0, 50)}... `);

    // Fresh DB per question (no cross-contamination)
    const mamaApi = initMamaCore();

    // Ingest haystack sessions
    const ingestStart = Date.now();
    const useExtraction = process.env.BENCH_EXTRACT === 'true';
    for (let si = 0; si < q.haystack_sessions.length; si++) {
      const session = q.haystack_sessions[si];
      if (useExtraction) {
        const messages = session.map((m) => ({
          role: (m.role === 'user' ? 'user' : 'assistant') as 'user' | 'assistant',
          content: m.content,
        }));
        await mamaApi.ingestConversation({
          messages,
          scopes: [],
          source: { package: 'standalone', source_type: 'benchmark' },
          extract: { enabled: true, model: 'claude-haiku-4-5-20251001' },
        });
      } else {
        // Save each session as a decision (same as memorybench provider)
        const conversationText = session
          .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
          .join('\n');
        await mamaApi.save({
          topic: `session_${si}`,
          decision: conversationText.slice(0, 8000),
          reasoning: `Session ${si}`,
          confidence: 0.5,
          type: 'user_decision',
        });
      }
    }
    const ingestMs = Date.now() - ingestStart;

    // Search
    const searchStart = Date.now();
    const searchResult = await mamaApi.suggest(q.question, { limit: 10, threshold: 0.2 });
    let topResults = searchResult?.results ?? [];

    // Semantic reranking via Claude CLI (same concept as memorybench's Codex reranking)
    if (topResults.length >= 2 && useClaude) {
      try {
        const rerankWindow = topResults.slice(0, 6);
        const candidateText = rerankWindow
          .map(
            (r: { topic: string; decision: string }, i: number) =>
              `ID: ${i}\nTopic: ${r.topic}\nExcerpt:\n${r.decision?.slice(0, 1500)}`
          )
          .join('\n\n---\n\n');
        const rerankPrompt = `Rank these memory candidates by relevance to the question. Return ONLY JSON: {"ordered":[0,2,1,...]}

Question: ${q.question}

Candidates:
${candidateText}`;
        const rerankResult = execSync(
          `echo ${JSON.stringify(rerankPrompt)} | claude --print --model claude-haiku-4-5-20251001 2>/dev/null`,
          { timeout: 15000, encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 }
        ).trim();
        const jsonMatch = rerankResult.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]) as { ordered?: number[] };
          if (Array.isArray(parsed.ordered)) {
            const reranked = parsed.ordered
              .filter((i) => i >= 0 && i < rerankWindow.length)
              .map((i) => rerankWindow[i]);
            const seen = new Set(reranked.map((_, i) => parsed.ordered![i]));
            const remaining = rerankWindow.filter((_, i) => !seen.has(i));
            topResults = [...reranked, ...remaining, ...topResults.slice(6)];
          }
        }
      } catch {
        // Reranking failed, keep original order
      }
    }
    const searchMs = Date.now() - searchStart;

    const topSimilarity = topResults[0]?.similarity ?? 0;

    // Build context from search results
    let context = '<no results>';
    if (topResults.length > 0) {
      context = topResults
        .slice(0, 5)
        .map(
          (r: { topic: string; decision: string; reasoning: string }, idx: number) =>
            `[${idx + 1}] ${r.decision?.slice(0, 3000)}`
        )
        .join('\n\n');
    }

    // Extract answer from context using Claude CLI
    let answer = '<no context>';
    if (topResults.length > 0) {
      try {
        const extractPrompt = `Answer this question in 1-2 sentences using ONLY the provided context. If the answer is not in the context, say "Not found in context."

Context:
${context.slice(0, 6000)}

Question: ${q.question}

Answer:`;
        answer = execSync(
          `echo ${JSON.stringify(extractPrompt)} | claude --print --model claude-haiku-4-5-20251001 2>/dev/null`,
          { timeout: 20000, encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 }
        ).trim();
      } catch {
        answer = topResults[0]?.decision?.slice(0, 500) ?? '<extraction failed>';
      }
    }

    // Judge
    const { correct, reason } = useClaude
      ? judgeWithClaude(q.question, q.answer, answer)
      : keywordJudge(q.answer, answer);

    results.push({
      questionId: q.question_id,
      questionType: q.question_type,
      question: q.question,
      groundTruth: q.answer,
      searchResults: topResults.length,
      searchMs,
      ingestMs,
      topSimilarity,
      answer: answer.slice(0, 500),
      correct,
      judgeReason: reason,
    });

    console.log(correct ? '✅' : '❌', `(search:${searchMs}ms sim:${topSimilarity.toFixed(2)})`);

    // Close DB before next question
    await closeMamaCore();
  }

  // Build report
  const byCategory: Record<string, { total: number; correct: number; accuracy: number }> = {};
  for (const r of results) {
    if (!byCategory[r.questionType]) {
      byCategory[r.questionType] = { total: 0, correct: 0, accuracy: 0 };
    }
    byCategory[r.questionType].total++;
    if (r.correct) byCategory[r.questionType].correct++;
  }
  for (const cat of Object.values(byCategory)) {
    cat.accuracy = cat.total > 0 ? Math.round((cat.correct / cat.total) * 1000) / 10 : 0;
  }

  const totalCorrect = results.filter((r) => r.correct).length;
  const report: BenchmarkReport = {
    runId,
    timestamp: new Date().toISOString(),
    totalQuestions: results.length,
    correctCount: totalCorrect,
    accuracy: Math.round((totalCorrect / results.length) * 1000) / 10,
    avgSearchMs: Math.round(results.reduce((s, r) => s + r.searchMs, 0) / results.length),
    avgIngestMs: Math.round(results.reduce((s, r) => s + r.ingestMs, 0) / results.length),
    judgeMethod: useClaude ? 'claude-haiku' : 'keyword',
    byCategory,
    results,
  };

  // Save report
  mkdirSync(RESULTS_DIR, { recursive: true });
  const reportPath = join(RESULTS_DIR, `${runId}.json`);
  writeFileSync(reportPath, JSON.stringify(report, null, 2));

  // Print report
  console.log('\n╔══════════════════════════════════════════════════════════╗');
  console.log('║            MAMA MEMORY BENCHMARK REPORT                 ║');
  console.log(`║  Judge: ${report.judgeMethod.padEnd(48)}║`);
  console.log('╠══════════════════════════════════════════════════════════╣');

  for (const [cat, stats] of Object.entries(byCategory).sort(([a], [b]) => a.localeCompare(b))) {
    console.log(
      `║ ${cat.padEnd(27)}│ ${String(stats.correct).padStart(4)} │ ${String(stats.total).padStart(4)} │ ${String(stats.accuracy + '%').padStart(7)} ║`
    );
  }

  console.log('╠══════════════════════════════════════════════════════════╣');
  console.log(
    `║ ${'OVERALL'.padEnd(27)}│ ${String(totalCorrect).padStart(4)} │ ${String(results.length).padStart(4)} │ ${String(report.accuracy + '%').padStart(7)} ║`
  );
  console.log('╠══════════════════════════════════════════════════════════╣');
  console.log(
    `║ Avg search: ${report.avgSearchMs}ms | Avg ingest: ${report.avgIngestMs}ms`.padEnd(59) + '║'
  );
  console.log(
    `║ Top similarity range: ${Math.min(...results.map((r) => r.topSimilarity)).toFixed(2)} - ${Math.max(...results.map((r) => r.topSimilarity)).toFixed(2)}`.padEnd(
      59
    ) + '║'
  );
  console.log(`║ Report: ${reportPath.split('/').slice(-2).join('/')}`.padEnd(59) + '║');
  console.log('╚══════════════════════════════════════════════════════════╝');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
