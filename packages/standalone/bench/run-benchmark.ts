#!/usr/bin/env tsx
/**
 * MAMA Memory Benchmark Runner
 *
 * Production-level benchmark using LongMemEval dataset.
 * Tests the full save -> search -> answer -> judge pipeline.
 *
 * Usage:
 *   pnpm --dir packages/standalone bench:sample   # 12 questions (2 per category)
 *   pnpm --dir packages/standalone bench:full     # all 500 questions
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';

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
  byCategory: Record<string, { total: number; correct: number; accuracy: number }>;
  results: BenchmarkResult[];
}

// ── Configuration ──────────────────────────────────────────────────────────

const MAMA_BASE_URL = process.env.MAMA_BASE_URL || 'http://localhost:3847';
const DATASET_PATH =
  process.env.LONGMEMEVAL_PATH ||
  join(
    homedir(),
    '.mama/workspace/memorybench/data/benchmarks/longmemeval/datasets/longmemeval_s_cleaned.json'
  );
const RESULTS_DIR = join(dirname(new URL(import.meta.url).pathname), 'results');

// ── Helpers ────────────────────────────────────────────────────────────────

async function mamaHealthCheck(): Promise<boolean> {
  try {
    const res = await fetch(`${MAMA_BASE_URL}/health`);
    return res.ok;
  } catch {
    return false;
  }
}

async function mamaSave(
  topic: string,
  decision: string,
  reasoning: string
): Promise<{ success: boolean; id?: string }> {
  const res = await fetch(`${MAMA_BASE_URL}/api/mama/save`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ topic, decision, reasoning }),
  });
  return (await res.json()) as { success: boolean; id?: string };
}

async function mamaSearch(
  query: string,
  limit = 10,
  topicPrefix?: string
): Promise<
  Array<{
    id: string;
    topic: string;
    decision: string;
    reasoning: string;
    similarity: number;
  }>
> {
  let url = `${MAMA_BASE_URL}/api/mama/search?q=${encodeURIComponent(query)}&limit=${limit * 3}`;
  if (topicPrefix) {
    url += `&topicPrefix=${encodeURIComponent(topicPrefix)}`;
  }
  const res = await fetch(url);
  const data = (await res.json()) as { results?: unknown[] };
  let results = (data.results ?? []) as Array<{
    id: string;
    topic: string;
    decision: string;
    reasoning: string;
    similarity: number;
  }>;
  // Filter by topic prefix if provided (client-side enforcement)
  if (topicPrefix) {
    results = results.filter((r) => r.topic.startsWith(topicPrefix));
  }
  return results.slice(0, limit);
}

function buildContext(
  results: Array<{ topic: string; decision: string; reasoning: string }>
): string {
  if (results.length === 0) return '<no relevant memories found>';
  return results
    .map((r, i) => `[${i + 1}] Topic: ${r.topic}\nContent: ${r.decision}\nReason: ${r.reasoning}`)
    .join('\n\n');
}

async function generateAnswer(question: string, context: string): Promise<string> {
  // Use MAMA's own API to answer (through the main agent's model)
  // Fallback: simple extraction from context
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    // No API key: extract best guess from context
    return extractAnswerFromContext(question, context);
  }

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 200,
      messages: [
        {
          role: 'user',
          content: `Answer this question using ONLY the provided context. Be concise (1-2 sentences max).

Context:
${context}

Question: ${question}

Answer:`,
        },
      ],
    }),
  });
  const data = (await res.json()) as {
    content?: Array<{ text: string }>;
    error?: { message: string };
  };
  if (data.error) return `ERROR: ${data.error.message}`;
  return data.content?.[0]?.text ?? '<no answer>';
}

function extractAnswerFromContext(question: string, context: string): string {
  // Simple keyword extraction fallback when no API key
  const lines = context.split('\n').filter((l) => l.startsWith('Content:'));
  return lines[0]?.replace('Content: ', '') ?? '<no context>';
}

async function judgeAnswer(
  question: string,
  groundTruth: string,
  answer: string
): Promise<{ correct: boolean; reason: string }> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    // Improved keyword judge: check for key entities (numbers, proper nouns)
    const normalizedAnswer = answer.toLowerCase();
    const normalizedTruth = groundTruth.toLowerCase();

    // Extract key entities: numbers, capitalized words, quoted phrases
    const numbers = groundTruth.match(/\d[\d,./:]+/g) ?? [];
    const properNouns = groundTruth.match(/[A-Z][a-z]{2,}/g) ?? [];
    const keyEntities = [
      ...numbers.map((n) => n.toLowerCase()),
      ...properNouns.map((n) => n.toLowerCase()),
    ];

    if (keyEntities.length > 0) {
      const entityMatches = keyEntities.filter((e) => normalizedAnswer.includes(e));
      const correct = entityMatches.length >= Math.ceil(keyEntities.length * 0.4);
      return {
        correct,
        reason: `entity-match: ${entityMatches.join(',')} (${entityMatches.length}/${keyEntities.length})`,
      };
    }

    // Fallback: word overlap
    const truthWords = normalizedTruth.split(/\s+/).filter((w) => w.length > 3);
    const matches = truthWords.filter((w) => normalizedAnswer.includes(w));
    const correct = matches.length >= Math.ceil(truthWords.length * 0.4);
    return { correct, reason: `keyword-match: ${matches.length}/${truthWords.length}` };
  }

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 100,
      messages: [
        {
          role: 'user',
          content: `Judge if the answer correctly addresses the question given the ground truth.
Question: ${question}
Ground truth: ${groundTruth}
Answer: ${answer}

Reply with ONLY "CORRECT" or "INCORRECT" followed by a brief reason.`,
        },
      ],
    }),
  });
  const data = (await res.json()) as { content?: Array<{ text: string }> };
  const text = data.content?.[0]?.text ?? 'INCORRECT: no response';
  const correct = text.toUpperCase().startsWith('CORRECT');
  return { correct, reason: text };
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const mode = args[0] || 'sample';

  // Load dataset
  if (!existsSync(DATASET_PATH)) {
    console.error(`Dataset not found: ${DATASET_PATH}`);
    console.error('Download LongMemEval or set LONGMEMEVAL_PATH env var.');
    process.exit(1);
  }

  const healthy = await mamaHealthCheck();
  if (!healthy) {
    console.error(`MAMA not reachable at ${MAMA_BASE_URL}. Run 'mama start' first.`);
    process.exit(1);
  }

  const dataset: LongMemEvalQuestion[] = JSON.parse(readFileSync(DATASET_PATH, 'utf-8'));
  console.log(`Loaded ${dataset.length} questions from LongMemEval`);

  // Select questions based on mode
  let questions: LongMemEvalQuestion[];
  if (mode === 'full') {
    questions = dataset;
  } else if (mode === 'sample') {
    // 2 per category, smallest haystack
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
    // Category filter
    questions = dataset.filter((q) => q.question_type === mode);
    if (questions.length === 0) {
      console.error(
        `No questions for category: ${mode}. Available: ${[...new Set(dataset.map((q) => q.question_type))].join(', ')}`
      );
      process.exit(1);
    }
  }

  console.log(`Running ${questions.length} questions (mode: ${mode})`);
  console.log(
    `API key: ${process.env.ANTHROPIC_API_KEY ? 'present (LLM judge)' : 'absent (keyword judge)'}\n`
  );

  const results: BenchmarkResult[] = [];
  const runId = `mama-bench-${mode}-${Date.now()}`;

  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
    const prefix = `[${i + 1}/${questions.length}]`;
    process.stdout.write(`${prefix} ${q.question_type}: ${q.question.slice(0, 50)}... `);

    // Ingest: save haystack sessions in parallel batches
    const ingestStart = Date.now();
    const containerTag = `bench_${runId}_${q.question_id}`;
    const BATCH_SIZE = 5;
    for (let batch = 0; batch < q.haystack_sessions.length; batch += BATCH_SIZE) {
      const batchSessions = q.haystack_sessions.slice(batch, batch + BATCH_SIZE);
      await Promise.all(
        batchSessions.map((session, offset) => {
          const si = batch + offset;
          const conversationText = session
            .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
            .join('\n');
          const topic = `${containerTag}_s${si}`.slice(0, 80);
          return mamaSave(
            topic,
            conversationText.slice(0, 8000),
            `Session ${si} for ${q.question_id}`
          );
        })
      );
    }
    const ingestMs = Date.now() - ingestStart;

    // Search (scoped to this question's container)
    const searchStart = Date.now();
    const searchResults = await mamaSearch(q.question, 5, containerTag);
    const searchMs = Date.now() - searchStart;

    // Answer
    const context = buildContext(searchResults);
    const answer = await generateAnswer(q.question, context);

    // Judge
    const { correct, reason } = await judgeAnswer(q.question, q.answer, answer);

    results.push({
      questionId: q.question_id,
      questionType: q.question_type,
      question: q.question,
      groundTruth: q.answer,
      searchResults: searchResults.length,
      searchMs,
      ingestMs,
      answer,
      correct,
      judgeReason: reason,
    });

    console.log(correct ? '✅' : '❌', `(${searchMs}ms)`);
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
  console.log(`║ Avg search: ${report.avgSearchMs}ms`.padEnd(59) + '║');
  console.log(`║ Avg ingest: ${report.avgIngestMs}ms`.padEnd(59) + '║');
  console.log(`║ Report: ${reportPath}`.padEnd(59) + '║');
  console.log('╚══════════════════════════════════════════════════════════╝');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
