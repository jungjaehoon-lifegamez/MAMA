# MAMA OS v0.16 — Memory Engine Completion

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete mama-core as a production memory platform with real-time memory agent, scope-based search, and debounce queue for hook events.

**Architecture:** Memory agent receives Claude Code Plugin hook events via HTTP, queues them (debounce), and processes batches through existing Sonnet extraction pipeline (`ingestConversation`). Scope-based vector search replaces topicPrefix string matching. Hybrid extraction stays in memorybench only (benchmark-specific optimization, not production).

---

## Pre-v0.16 Completed Work (feat/memory-stabilization-benchmark)

**Merged to main:** Search quality overhaul — LongMemEval benchmark 58% → 88% (100Q) / 81.5% (200Q).

| Area              | Changes                                               | Status   |
| ----------------- | ----------------------------------------------------- | -------- |
| RRF fusion        | Threshold fix, normalization, lexical-first ranking   | **Done** |
| FTS5 BM25         | better-sqlite3 rollback, integrated into recallMemory | **Done** |
| Evolution engine  | Conservative supersede (raw→extracted, ≥0.3 overlap)  | **Done** |
| Extraction prompt | Mandatory dates/amounts/places/brands, no-merge rule  | **Done** |
| Benchmark infra   | topicPrefix isolation, session date injection         | **Done** |
| PR review         | ~66 comments resolved across all packages             | **Done** |

**Benchmark vs Industry (LongMemEval-S):**

| System      | Score     | Model             |
| ----------- | --------- | ----------------- |
| Mastra      | 94.87%    | GPT-5-mini        |
| SuperMemory | 81.6%     | GPT-4o            |
| **MAMA**    | **81.5%** | Sonnet 4.6 + Opus |
| Zep         | 71.2%     | GPT-4o            |

**Known gaps from benchmark analysis:**

- knowledge-update: 70% (vs SuperMemory 88%) — need temporal metadata on facts
- single-session-assistant: 85% (vs 96%) — assistant response extraction weak
- Production memory agent saves noise (greetings, prompts, duplicates)
- Checkpoint → decision continuity broken

---

**Eng Review Decisions (2026-03-31):**

- Hybrid extractor: benchmarks only, NOT integrated into mama-core production path
- ingestDocument: deferred to v0.17 (no consumer in v0.16)
- Production extraction: Sonnet via existing ingestConversation
- Hook fetch pattern: test-driven decision during implementation
- Memory agent: debounce queue (Kagemusha delta-digest pattern)
- Queue max size: 50 (oldest dropped on overflow)

**CEO Review Additions (2026-03-31, SELECTIVE EXPANSION):**

- Cherry-pick 1: `mama memory search` CLI command (developer QoL)
- Cherry-pick 2: Hook sends assistant response alongside user prompt (richer extraction)
- Debounce queue unit tests (new code needs coverage)
- Flush activity logging (observability)

**Post-Benchmark Additions (2026-04-01):**

- Memory agent noise filtering — reject greetings, internal prompts, duplicates
- FTS5 trigger migration SQL (permanent, not runtime-generated)
- Temporal metadata on facts (event_date field for time-based search)

**Tech Stack:** TypeScript, Vitest, SQLite (better-sqlite3), Transformers.js (384-dim e5-small embeddings), Claude API (Sonnet for extraction)

---

## File Structure

### New Files

| File                                                         | Responsibility                                               |
| ------------------------------------------------------------ | ------------------------------------------------------------ |
| `packages/mama-core/tests/unit/memory-scope-search.test.ts`  | Scope-based search tests                                     |
| `packages/standalone/src/api/memory-agent-handler.ts`        | HTTP endpoint + debounce queue (max 50, flush log)           |
| `packages/standalone/src/api/memory-agent-queue.ts`          | Debounce queue class (enqueue, flush, overflow drop)         |
| `packages/standalone/tests/api/memory-agent-handler.test.ts` | Handler tests (happy path + malformed JSON + ingest failure) |
| `packages/standalone/tests/api/memory-agent-queue.test.ts`   | Queue unit tests (enqueue, flush, max size drop)             |
| `packages/standalone/src/cli/commands/memory.ts`             | `mama memory search` CLI command                             |

### Modified Files

| File                                                           | Changes                                             |
| -------------------------------------------------------------- | --------------------------------------------------- |
| `packages/mama-core/src/memory/types.ts`                       | Add `filterByScopes` utility                        |
| `packages/mama-core/src/memory/api.ts`                         | Scope-based recall improvements                     |
| `packages/mama-core/src/db-adapter/node-sqlite-adapter.ts`     | Scope-based filtering (extend topicPrefix to scope) |
| `packages/mama-core/src/db-manager.ts`                         | Pass scope filter to vectorSearch                   |
| `packages/standalone/src/cli/commands/start.ts`                | Register memory-agent HTTP endpoint                 |
| `packages/claude-code-plugin/scripts/userpromptsubmit-hook.js` | Send hook events to MAMA OS memory agent            |

### NOT Modified (Eng Review decisions)

| File                                                 | Reason                                        |
| ---------------------------------------------------- | --------------------------------------------- |
| `packages/mama-core/src/memory/hybrid-extractor.ts`  | Benchmarks only, stays in memorybench scripts |
| `packages/mama-core/src/memory/document-ingester.ts` | Deferred to v0.17                             |
| `packages/mama-core/src/index.ts`                    | No new exports needed                         |

---

## Task 1: Hybrid Extractor Module

Extract the proven hybrid pipeline from `scripts/test-hybrid-v2.mjs` into a reusable mama-core module.

**Files:**

- Create: `packages/mama-core/src/memory/hybrid-extractor.ts`
- Create: `packages/mama-core/tests/unit/memory-hybrid-extractor.test.ts`

- [ ] **Step 1: Write failing test for code regex extraction**

```typescript
// packages/mama-core/tests/unit/memory-hybrid-extractor.test.ts
import { describe, it, expect } from 'vitest';
import { extractFactsWithCode, FACT_PATTERNS } from '../../src/memory/hybrid-extractor.js';

describe('hybrid-extractor', () => {
  describe('code regex extraction', () => {
    it('should extract personal facts from user messages', () => {
      const messages = [
        {
          role: 'user' as const,
          content: "I've been collecting vintage cameras for three months now.",
        },
        { role: 'assistant' as const, content: "That's a great hobby!" },
        { role: 'user' as const, content: 'I just finished reading The Nightingale yesterday.' },
      ];
      const facts = extractFactsWithCode(messages);
      expect(facts.length).toBeGreaterThanOrEqual(2);
      expect(facts[0].sentence).toContain('collecting vintage cameras');
      expect(facts[1].sentence).toContain('Nightingale');
    });

    it('should return empty array for messages with no personal facts', () => {
      const messages = [
        { role: 'user' as const, content: 'Can you explain how JWT tokens work?' },
        { role: 'assistant' as const, content: 'JWT tokens are...' },
      ];
      const facts = extractFactsWithCode(messages);
      expect(facts).toEqual([]);
    });

    it('should normalize I to User in extracted facts', () => {
      const messages = [{ role: 'user' as const, content: 'I upgraded to 500 Mbps last week.' }];
      const facts = extractFactsWithCode(messages);
      expect(facts[0].normalized).toContain('User');
      expect(facts[0].normalized).not.toMatch(/\bI\b/);
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/mama-core && npx vitest run tests/unit/memory-hybrid-extractor.test.ts`
Expected: FAIL with "Cannot find module"

- [ ] **Step 3: Implement code regex extraction**

```typescript
// packages/mama-core/src/memory/hybrid-extractor.ts

export interface ConversationMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export interface CodeExtractedFact {
  sentence: string;
  normalized: string;
  entityKey: string;
  domainLabel: string | null;
}

export const FACT_PATTERNS: RegExp[] = [
  /\bI\s+(just\s+)?(started|began|finished|completed|graduated|attended)\b/i,
  /\bI\s+(just\s+)?(got|bought|purchased|acquired|received)\s+(a|an|my|the)\b/i,
  /\bI\s+(just\s+)?(got|bought|purchased|acquired)\b/i,
  /\bI\s+(am\s+currently|'m\s+currently)\b/i,
  /\bI\s+(am|'m)\s+(reading|watching|writing|playing|learning|training|working)\b/i,
  /\bI\s+recently\s+(attended|went|visited|saw|watched|volunteered|completed|finished|made|baked)\b/i,
  /\bI\s+went\s+(to|on|for)\b/i,
  /\bI\s+visited\b/i,
  /\bI\s+volunteered\b/i,
  /\bI\s+(work|live|play|run|do)\b/i,
  /\bI\s+spent\s+\d+\s+(day|days|week|weeks|hour|hours)\b/i,
  /\bI\s+was\s+(just\s+)?(in|at|talking)\b/i,
  /\bI'?ve\s+(made|baked|cooked|tried|been\s+\w+ing)\b/i,
  /\bI\s+(upgraded|assembled|set\s+up|replaced|installed|organized)\b/i,
  /\bI\s+(usually|normally|typically)\b/i,
  /\bI\s+finally\s+\w+/i,
  /\bI\s+(love|like|prefer|enjoy)\s+\w+/i,
  /\bmy\s+(new|sister|brother|cousin|friend|mom|dad)\b.*\b[A-Z][a-z]{2,}\b/i,
  /\bour\s+\w*\s*(team|record|score|league)\b/i,
  /\bwe'?re\s+\d+-\d+\b/i,
  /\b\d+[-\s]+(minute|hour|day|week|month|year)\b.*\b(commute|trip|jog|walk|run|drive)\b/i,
];

const DOMAIN_LABELS: Array<{ patterns: RegExp[]; label: string }> = [
  { patterns: [/\b(made|baked|cooked|brewed)\b/i], label: 'Cooking/baking' },
  {
    patterns: [
      /\b(started|began|finished|completed)\b.*\b(book|novel)\b/i,
      /\b(started|began|finished|completed)\b.*["'][^"']{3,}["']/i,
    ],
    label: 'Reading',
  },
  {
    patterns: [
      /\b(started|watching|watched|finished|binge)\b.*\b(show|series|movie|season|episode)\b/i,
    ],
    label: 'Watching',
  },
  {
    patterns: [
      /\b(attended|visited)\b.*\b(concert|lecture|museum|gallery|theater|festival|exhibition)\b/i,
      /\bvolunteered\b/i,
    ],
    label: 'Event',
  },
  {
    patterns: [/\b(bought|purchased|acquired)\b/i, /\bgot\s+(a|an|my|the)\s+\w+/i],
    label: 'Purchase',
  },
  { patterns: [/\bwe'?re\s+\d+-\d+\b/i, /\b(record|score)\b.*\d+-\d+/i], label: 'Sports' },
  { patterns: [/\b(went to|visited|was in|traveled to)\b.*\b[A-Z][a-z]{2,}\b/i], label: 'Travel' },
  { patterns: [/\b(graduated|degree|diploma)\b/i], label: 'Education' },
];

export function extractFactsWithCode(messages: ConversationMessage[]): CodeExtractedFact[] {
  const userMessages = messages.filter((m) => m.role === 'user');
  const facts: CodeExtractedFact[] = [];

  for (const msg of userMessages) {
    const sentences = msg.content.split(/(?<=[.!?])\s+/);
    for (const sentence of sentences) {
      if (sentence.length <= 15) continue;
      if (!FACT_PATTERNS.some((p) => p.test(sentence))) continue;

      const normalized = sentence.replace(/\bI\b/g, 'User').trim();
      const domainLabel = getDomainLabel(sentence);
      const entityKey = extractEntityKey(sentence);

      facts.push({ sentence, normalized, entityKey, domainLabel });
    }
  }

  return facts;
}

function getDomainLabel(sentence: string): string | null {
  for (const { patterns, label } of DOMAIN_LABELS) {
    if (patterns.some((p) => p.test(sentence))) return label;
  }
  return null;
}

function extractEntityKey(fact: string): string {
  const quoted = fact.match(/"([^"]+)"/)?.[1];
  if (quoted) {
    const verb =
      fact
        .match(
          /\b(started|began|finished|completed|got|bought|purchased|attended|went|visited)\b/i
        )?.[1]
        ?.toLowerCase() ?? 'fact';
    return `${verb}_${quoted.toLowerCase().replace(/\s+/g, '_')}`.slice(0, 70);
  }
  const proper = fact
    .match(/\b[A-Z][a-z]{2,}(?:\s+[A-Z][a-z]{2,})*/g)
    ?.filter((w) => !['User', 'By', 'The', 'In', 'On'].includes(w));
  if (proper?.length) {
    const verb =
      fact
        .match(/\b(started|finished|attended|bought|visited|went|graduated|completed)\b/i)?.[1]
        ?.toLowerCase() ?? 'fact';
    return `${verb}_${proper[0].toLowerCase().replace(/\s+/g, '_')}`.slice(0, 70);
  }
  const words = fact
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 4)
    .slice(0, 3);
  return words.join('_') || 'unknown';
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/mama-core && npx vitest run tests/unit/memory-hybrid-extractor.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Write failing test for hybrid pipeline (code + LLM)**

```typescript
// Add to memory-hybrid-extractor.test.ts
import { hybridExtract, type HybridExtractOptions } from '../../src/memory/hybrid-extractor.js';

describe('hybrid extraction', () => {
  it('should use code-only when enough facts found', async () => {
    const messages = [
      {
        role: 'user' as const,
        content: 'I just finished reading The Nightingale. I started it three weeks ago.',
      },
    ];
    let llmCalled = false;
    const options: HybridExtractOptions = {
      codeThreshold: 2,
      llmExtract: async () => {
        llmCalled = true;
        return [];
      },
    };
    const result = await hybridExtract(messages, options);
    expect(result.length).toBeGreaterThanOrEqual(2);
    expect(llmCalled).toBe(false);
    expect(result.every((f) => f.source === 'code')).toBe(true);
  });

  it('should call LLM when code finds fewer than threshold', async () => {
    const messages = [
      { role: 'user' as const, content: 'Can you recommend a good restaurant near Serenity Yoga?' },
    ];
    let llmCalled = false;
    const options: HybridExtractOptions = {
      codeThreshold: 2,
      llmExtract: async (msgs) => {
        llmCalled = true;
        return ['User takes yoga classes at Serenity Yoga'];
      },
    };
    const result = await hybridExtract(messages, options);
    expect(llmCalled).toBe(true);
    expect(result.some((f) => f.source === 'llm')).toBe(true);
  });
});
```

- [ ] **Step 6: Implement hybrid pipeline**

```typescript
// Add to hybrid-extractor.ts

export interface HybridExtractedFact {
  text: string;
  entityKey: string;
  domainLabel: string | null;
  source: 'code' | 'llm';
  factIndex: number;
}

export interface HybridExtractOptions {
  codeThreshold?: number; // default 2
  llmExtract?: (messages: ConversationMessage[]) => Promise<string[]>;
  datePrefix?: string;
}

export async function hybridExtract(
  messages: ConversationMessage[],
  options: HybridExtractOptions = {}
): Promise<HybridExtractedFact[]> {
  const threshold = options.codeThreshold ?? 2;

  // Phase 1: Code extraction
  const codeFacts = extractFactsWithCode(messages);

  const results: HybridExtractedFact[] = codeFacts.map((f, i) => ({
    text: options.datePrefix
      ? `${options.datePrefix}: ${f.domainLabel ? `${f.domainLabel}: ` : ''}${f.normalized}`
      : f.normalized,
    entityKey: f.entityKey,
    domainLabel: f.domainLabel,
    source: 'code' as const,
    factIndex: i,
  }));

  // Phase 2: LLM supplement when code finds fewer than threshold
  if (codeFacts.length < threshold && options.llmExtract) {
    const llmFacts = await options.llmExtract(messages);
    for (let i = 0; i < llmFacts.length; i++) {
      const text = String(llmFacts[i]);
      results.push({
        text,
        entityKey: `llm_f${i}_${text
          .toLowerCase()
          .split(/\s+/)
          .filter((w) => w.length > 4)
          .slice(0, 2)
          .join('_')}`.slice(0, 60),
        domainLabel: null,
        source: 'llm',
        factIndex: results.length,
      });
    }
  }

  return results;
}
```

- [ ] **Step 7: Run all tests**

Run: `cd packages/mama-core && npx vitest run tests/unit/memory-hybrid-extractor.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 8: Commit**

```bash
git add packages/mama-core/src/memory/hybrid-extractor.ts packages/mama-core/tests/unit/memory-hybrid-extractor.test.ts
git commit -m "feat(mama-core): add hybrid extractor module — code regex + LLM pipeline"
```

---

## Task 2: Wire Hybrid Extraction into ingestConversation

**Files:**

- Modify: `packages/mama-core/src/memory/types.ts`
- Modify: `packages/mama-core/src/memory/api.ts`
- Modify: `packages/mama-core/src/index.ts`

- [ ] **Step 1: Add HybridExtractOptions to types**

```typescript
// Add to packages/mama-core/src/memory/types.ts

export interface HybridExtractConfig {
  enabled: boolean;
  mode?: 'llm' | 'hybrid'; // default 'llm' for backward compat
  codeThreshold?: number; // default 2 — LLM when code finds fewer
  batchSize?: number; // sessions per LLM call (for batch mode)
  model?: string;
  apiKey?: string;
  baseUrl?: string;
}
```

- [ ] **Step 2: Update IngestConversationInput to accept hybrid config**

```typescript
// Modify IngestConversationInput in types.ts
export interface IngestConversationInput {
  messages: ConversationMessage[];
  scopes?: MemoryScopeRef[];
  source: {
    package: 'mama-core' | 'mcp-server' | 'standalone' | 'claude-code-plugin';
    source_type: string;
    user_id?: string;
    channel_id?: string;
    project_id?: string;
  };
  extract?: HybridExtractConfig; // was: { enabled, model, apiKey, baseUrl }
}
```

- [ ] **Step 3: Update ingestConversation in api.ts to use hybrid mode**

In `packages/mama-core/src/memory/api.ts`, find the `ingestConversation` function and add the hybrid branch:

```typescript
// Inside ingestConversation, after checking extract.enabled:
if (input.extract?.mode === 'hybrid') {
  const { hybridExtract } = await import('./hybrid-extractor.js');
  const facts = await hybridExtract(input.messages, {
    codeThreshold: input.extract.codeThreshold ?? 2,
    datePrefix: undefined, // caller provides if needed
    llmExtract: async (msgs) => {
      // Use existing extraction prompt + LLM call
      const prompt = buildExtractionPrompt(msgs);
      // Call LLM via existing extraction function
      const extractionFn = getExtractionFn();
      if (!extractionFn) return [];
      const response = await extractionFn(prompt, input.extract?.model);
      const units = parseExtractionResponse(response);
      return units.map((u) => u.summary);
    },
  });

  // Save each fact via saveMemory
  for (const fact of facts.slice(0, 8)) {
    const saved = await saveMemory({
      topic: `${fact.entityKey}`,
      kind: 'fact',
      summary: fact.text,
      details: `Source: ${fact.source}. ${fact.domainLabel ? `Domain: ${fact.domainLabel}.` : ''}`,
      confidence: fact.source === 'code' ? 0.8 : 0.7,
      scopes: input.scopes ?? [],
      source: input.source,
    });
    if (saved.success) {
      result.extractedMemories.push({ id: saved.id, kind: 'fact', topic: fact.entityKey });
    }
  }

  return result;
}
```

- [ ] **Step 4: Export from index.ts**

```typescript
// Add to packages/mama-core/src/index.ts
export { extractFactsWithCode, hybridExtract, FACT_PATTERNS } from './memory/hybrid-extractor.js';
export type {
  HybridExtractOptions,
  HybridExtractedFact,
  CodeExtractedFact,
} from './memory/hybrid-extractor.js';
```

- [ ] **Step 5: Run existing tests to verify no regression**

Run: `cd packages/mama-core && npx vitest run`
Expected: All existing tests PASS

- [ ] **Step 6: Commit**

```bash
git add packages/mama-core/src/memory/types.ts packages/mama-core/src/memory/api.ts packages/mama-core/src/index.ts
git commit -m "feat(mama-core): wire hybrid extraction into ingestConversation"
```

---

## Task 3: ingestDocument API

**Files:**

- Create: `packages/mama-core/src/memory/document-ingester.ts`
- Create: `packages/mama-core/tests/unit/memory-document-ingester.test.ts`
- Modify: `packages/mama-core/src/memory/api.ts`
- Modify: `packages/mama-core/src/memory/types.ts`
- Modify: `packages/mama-core/src/index.ts`

- [ ] **Step 1: Write failing test**

```typescript
// packages/mama-core/tests/unit/memory-document-ingester.test.ts
import { describe, it, expect } from 'vitest';
import { prepareDocumentFacts } from '../../src/memory/document-ingester.js';

describe('document-ingester', () => {
  it('should extract facts from text content', () => {
    const facts = prepareDocumentFacts({
      type: 'document',
      content: 'Project X budget increased from 10M to 15M. Deadline moved to May 2026.',
      metadata: { filename: 'project-x-update.pdf' },
    });
    expect(facts.length).toBeGreaterThanOrEqual(1);
    expect(facts[0].text).toContain('budget');
  });

  it('should include filename in metadata', () => {
    const facts = prepareDocumentFacts({
      type: 'pdf',
      content: 'Contract terms: 1 year, monthly payment 5M KRW.',
      metadata: { filename: 'contract.pdf', size: 1234 },
    });
    expect(facts[0].metadata.filename).toBe('contract.pdf');
  });

  it('should handle image descriptions', () => {
    const facts = prepareDocumentFacts({
      type: 'image',
      content: 'Design mockup showing navigation bar with blue accent color and rounded corners.',
      metadata: { filename: 'design-v3.png' },
    });
    expect(facts.length).toBeGreaterThanOrEqual(1);
    expect(facts[0].type).toBe('image');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/mama-core && npx vitest run tests/unit/memory-document-ingester.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement document ingester**

```typescript
// packages/mama-core/src/memory/document-ingester.ts

export interface DocumentInput {
  type: 'image' | 'pdf' | 'spreadsheet' | 'document';
  content: string;
  metadata: { filename: string; size?: number; [key: string]: unknown };
}

export interface DocumentFact {
  text: string;
  type: DocumentInput['type'];
  entityKey: string;
  metadata: DocumentInput['metadata'];
}

export function prepareDocumentFacts(input: DocumentInput): DocumentFact[] {
  const sentences = input.content.split(/(?<=[.!?])\s+/).filter((s) => s.length > 20);

  if (sentences.length === 0 && input.content.length > 20) {
    sentences.push(input.content);
  }

  const baseName = input.metadata.filename.replace(/\.[^.]+$/, '').replace(/[-_]/g, ' ');

  return sentences.slice(0, 10).map((sentence, i) => ({
    text: sentence.trim(),
    type: input.type,
    entityKey: `doc_${baseName.toLowerCase().replace(/\s+/g, '_')}_${i}`.slice(0, 60),
    metadata: input.metadata,
  }));
}
```

- [ ] **Step 4: Add ingestDocument to api.ts**

```typescript
// Add to packages/mama-core/src/memory/api.ts

export interface IngestDocumentInput {
  type: 'image' | 'pdf' | 'spreadsheet' | 'document';
  content: string;
  metadata: { filename: string; size?: number; [key: string]: unknown };
  source: SaveMemoryInput['source'];
  scopes?: MemoryScopeRef[];
}

export async function ingestDocument(
  input: IngestDocumentInput
): Promise<{ success: boolean; facts: Array<{ id: string; topic: string }> }> {
  const { prepareDocumentFacts } = await import('./document-ingester.js');
  const facts = prepareDocumentFacts({
    type: input.type,
    content: input.content,
    metadata: input.metadata,
  });

  const saved: Array<{ id: string; topic: string }> = [];

  for (const fact of facts) {
    const result = await saveMemory({
      topic: fact.entityKey,
      kind: 'fact',
      summary: fact.text,
      details: `Source: ${input.type} (${input.metadata.filename})`,
      confidence: 0.7,
      scopes: input.scopes ?? [],
      source: input.source,
    });
    if (result.success) {
      saved.push({ id: result.id, topic: fact.entityKey });
    }
  }

  return { success: saved.length > 0, facts: saved };
}
```

- [ ] **Step 5: Export from index.ts**

```typescript
// Add to packages/mama-core/src/index.ts
export { ingestDocument } from './memory/api.js';
export type { IngestDocumentInput } from './memory/api.js';
```

- [ ] **Step 6: Run tests**

Run: `cd packages/mama-core && npx vitest run tests/unit/memory-document-ingester.test.ts`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add packages/mama-core/src/memory/document-ingester.ts packages/mama-core/tests/unit/memory-document-ingester.test.ts packages/mama-core/src/memory/api.ts packages/mama-core/src/memory/types.ts packages/mama-core/src/index.ts
git commit -m "feat(mama-core): add ingestDocument API for non-conversational data"
```

---

## Task 4: Scope-Based Vector Search

**Files:**

- Modify: `packages/mama-core/src/db-adapter/node-sqlite-adapter.ts`
- Modify: `packages/mama-core/src/db-manager.ts`
- Modify: `packages/mama-core/src/memory/api.ts`
- Create: `packages/mama-core/tests/unit/memory-scope-search.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
// packages/mama-core/tests/unit/memory-scope-search.test.ts
import { describe, it, expect } from 'vitest';
import { filterByScopes, type MemoryScopeRef } from '../../src/memory/types.js';

describe('scope-based search', () => {
  it('should filter results by app scope', () => {
    const records = [
      { id: '1', topic: 'meeting', scopes: [{ kind: 'app', id: 'slack' }] },
      { id: '2', topic: 'commit', scopes: [{ kind: 'app', id: 'github' }] },
      { id: '3', topic: 'chat', scopes: [{ kind: 'app', id: 'slack' }] },
    ];
    const filtered = filterByScopes(records, [{ kind: 'app', id: 'slack' }]);
    expect(filtered).toHaveLength(2);
    expect(filtered.map((r) => r.id)).toEqual(['1', '3']);
  });

  it('should return all when scopes is "all"', () => {
    const records = [
      { id: '1', topic: 'a', scopes: [{ kind: 'app', id: 'slack' }] },
      { id: '2', topic: 'b', scopes: [{ kind: 'app', id: 'github' }] },
    ];
    const filtered = filterByScopes(records, 'all');
    expect(filtered).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Implement scope filtering utility**

```typescript
// Add to packages/mama-core/src/memory/types.ts
export function filterByScopes<T extends { scopes?: MemoryScopeRef[] }>(
  records: T[],
  scopes: MemoryScopeRef[] | 'all'
): T[] {
  if (scopes === 'all') return records;
  if (!scopes.length) return records;

  const scopeSet = new Set(scopes.map((s) => `${s.kind}:${s.id}`));
  return records.filter((r) => {
    if (!r.scopes || r.scopes.length === 0) return false;
    return r.scopes.some((s) => scopeSet.has(`${s.kind}:${s.id}`));
  });
}
```

- [ ] **Step 3: Update recallMemory to prefer scope-based filtering**

In `packages/mama-core/src/memory/api.ts`, update `recallMemory` to build a `topicPrefix` from scopes when available, maintaining backward compatibility:

```typescript
// Inside recallMemory, before vector search:
// If scopes contain app-level filtering, derive topicPrefix for vector pre-filter
let derivedTopicPrefix = options.topicPrefix;
if (!derivedTopicPrefix && options.scopes?.length) {
  // App scopes can map to topic prefixes for efficient vector filtering
  const appScopes = options.scopes.filter((s) => s.kind === 'app');
  if (appScopes.length === 1) {
    derivedTopicPrefix = appScopes[0].id;
  }
}
```

- [ ] **Step 4: Run tests**

Run: `cd packages/mama-core && npx vitest run tests/unit/memory-scope-search.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/mama-core/src/memory/types.ts packages/mama-core/src/memory/api.ts packages/mama-core/src/db-adapter/node-sqlite-adapter.ts packages/mama-core/src/db-manager.ts packages/mama-core/tests/unit/memory-scope-search.test.ts
git commit -m "feat(mama-core): scope-based vector search with backward-compatible topicPrefix"
```

---

## Task 5: Memory Agent HTTP Endpoint

**Files:**

- Create: `packages/standalone/src/api/memory-agent-handler.ts`
- Create: `packages/standalone/tests/api/memory-agent-handler.test.ts`
- Modify: `packages/standalone/src/cli/commands/start.ts`

- [ ] **Step 1: Write failing test**

```typescript
// packages/standalone/tests/api/memory-agent-handler.test.ts
import { describe, it, expect } from 'vitest';
import { extractMemoryFromHookEvent, type HookEvent } from '../../src/api/memory-agent-handler.js';

describe('memory-agent-handler', () => {
  it('should extract decision from user prompt', () => {
    const event: HookEvent = {
      type: 'UserPromptSubmit',
      userPrompt: "Let's use JWT for authentication because we need mobile support",
      projectPath: '/Users/dev/myapp',
      timestamp: Date.now(),
    };
    const candidates = extractMemoryFromHookEvent(event);
    expect(candidates.length).toBeGreaterThanOrEqual(1);
    expect(candidates[0].kind).toBe('decision');
  });

  it('should skip generic questions', () => {
    const event: HookEvent = {
      type: 'UserPromptSubmit',
      userPrompt: 'How does JWT work?',
      projectPath: '/Users/dev/myapp',
      timestamp: Date.now(),
    };
    const candidates = extractMemoryFromHookEvent(event);
    expect(candidates).toEqual([]);
  });
});
```

- [ ] **Step 2: Implement memory agent handler**

```typescript
// packages/standalone/src/api/memory-agent-handler.ts
import { extractSaveCandidates } from '../memory/save-candidate-extractor.js';

export interface HookEvent {
  type: 'UserPromptSubmit' | 'PostToolUse';
  userPrompt?: string;
  toolName?: string;
  toolResult?: string;
  projectPath: string;
  timestamp: number;
}

export interface MemoryCandidate {
  kind: string;
  text: string;
  confidence: number;
  scope: { kind: string; id: string };
}

export function extractMemoryFromHookEvent(event: HookEvent): MemoryCandidate[] {
  if (event.type === 'UserPromptSubmit' && event.userPrompt) {
    const candidates = extractSaveCandidates({
      userText: event.userPrompt,
      botResponse: '',
      channelKey: 'claude-code',
      source: 'claude-code-plugin',
      channelId: event.projectPath,
      createdAt: event.timestamp,
    });

    return candidates.map((c) => ({
      kind: c.kind,
      text: c.content,
      confidence: c.confidence,
      scope: { kind: 'project', id: event.projectPath },
    }));
  }

  return [];
}

export function createMemoryAgentRoute(mamaCore: { ingestConversation: Function }) {
  return async (req: Request): Promise<Response> => {
    try {
      const event: HookEvent = await req.json();
      const candidates = extractMemoryFromHookEvent(event);

      if (candidates.length === 0) {
        return new Response(JSON.stringify({ saved: 0 }), { status: 200 });
      }

      let saved = 0;
      for (const candidate of candidates) {
        try {
          await mamaCore.ingestConversation({
            messages: [{ role: 'user', content: candidate.text }],
            scopes: [candidate.scope],
            source: { package: 'claude-code-plugin', source_type: 'hook' },
            extract: { enabled: true, mode: 'hybrid', codeThreshold: 1 },
          });
          saved++;
        } catch {
          // Skip failed saves
        }
      }

      return new Response(JSON.stringify({ saved }), { status: 200 });
    } catch {
      return new Response(JSON.stringify({ error: 'invalid request' }), { status: 400 });
    }
  };
}
```

- [ ] **Step 3: Register endpoint in start.ts**

Add to the HTTP server in `packages/standalone/src/cli/commands/start.ts`:

```typescript
// In the route handler section, add:
if (pathname === '/api/memory-agent/hook' && req.method === 'POST') {
  const handler = createMemoryAgentRoute({ ingestConversation });
  return handler(req);
}
```

- [ ] **Step 4: Run tests**

Run: `cd packages/standalone && pnpm test -- tests/api/memory-agent-handler.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/standalone/src/api/memory-agent-handler.ts packages/standalone/tests/api/memory-agent-handler.test.ts packages/standalone/src/cli/commands/start.ts
git commit -m "feat(standalone): add memory agent HTTP endpoint for Claude Code hooks"
```

---

## Task 6: Update Claude Code Plugin Hook

**Files:**

- Modify: `packages/claude-code-plugin/scripts/userpromptsubmit-hook.js`

- [ ] **Step 1: Add memory agent call to hook**

```javascript
// Add to userpromptsubmit-hook.js, after existing logic:

// Send to MAMA OS memory agent (non-blocking)
const MAMA_URL = process.env.MAMA_BASE_URL || 'http://localhost:3847';
try {
  fetch(`${MAMA_URL}/api/memory-agent/hook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'UserPromptSubmit',
      userPrompt: userMessage,
      projectPath: process.cwd(),
      timestamp: Date.now(),
    }),
    signal: AbortSignal.timeout(2000), // 2s timeout, don't block the hook
  }).catch(() => {}); // Graceful degradation — MAMA OS might be off
} catch {
  // Silently ignore — MAMA OS is optional
}
```

- [ ] **Step 2: Test manually**

```bash
# Start MAMA OS
mama start

# In another terminal, trigger a Claude Code session
# Verify in MAMA OS logs that hook events are received:
curl -s http://localhost:3847/api/memory-agent/hook \
  -H 'Content-Type: application/json' \
  -d '{"type":"UserPromptSubmit","userPrompt":"Let us use PostgreSQL for the database","projectPath":"/tmp/test","timestamp":1234567890}'
# Expected: {"saved":1}
```

- [ ] **Step 3: Commit**

```bash
git add packages/claude-code-plugin/scripts/userpromptsubmit-hook.js
git commit -m "feat(plugin): send hook events to MAMA OS memory agent endpoint"
```

---

## Task 7: 100-Question Benchmark Analysis

**Files:**

- Read: `/tmp/hybrid-100q.log` (benchmark output)
- Create: `packages/memorybench/docs/benchmark-100q-report.md`

- [ ] **Step 1: Wait for benchmark completion**

```bash
# Check if still running:
ps aux | grep test-hybrid-v2 | grep -v grep

# If complete, check results:
tail -30 /tmp/hybrid-100q.log
```

- [ ] **Step 2: Analyze results**

```bash
cd packages/memorybench
# Extract accuracy from log
grep "Accuracy:" /tmp/hybrid-100q.log
# Extract by-type breakdown
grep -A 10 "By type:" /tmp/hybrid-100q.log
```

- [ ] **Step 3: Write benchmark report**

Create `packages/memorybench/docs/benchmark-100q-report.md` with:

- Overall accuracy (target: >60%)
- Per-type accuracy breakdown
- Comparison to baselines (v68: 50%, code-only: 40%, 10Q hybrid: 100%)
- Notable failure patterns
- Recommendations for v0.17

- [ ] **Step 4: Commit**

```bash
git add packages/memorybench/docs/benchmark-100q-report.md
git commit -m "docs(memorybench): 100-question benchmark report"
```

---

## Task 8: Integration Test — End-to-End

**Files:**

- Create: `packages/mama-core/tests/integration/memory-e2e.test.ts`

- [ ] **Step 1: Write E2E test**

```typescript
// packages/mama-core/tests/integration/memory-e2e.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  initDB,
  closeDB,
  ingestConversation,
  recallMemory,
  ingestDocument,
} from '../../src/index.js';
import { unlinkSync } from 'fs';

const TEST_DB = '/tmp/test-mama-e2e.db';

describe('memory engine e2e', () => {
  beforeAll(async () => {
    process.env.MAMA_DB_PATH = TEST_DB;
    await initDB();
  });

  afterAll(async () => {
    await closeDB();
    try {
      unlinkSync(TEST_DB);
    } catch {}
  });

  it('should ingest conversation with hybrid extraction and recall', async () => {
    // Ingest
    const result = await ingestConversation({
      messages: [
        {
          role: 'user',
          content: 'I just finished reading The Nightingale by Kristin Hannah. It took me 21 days.',
        },
        { role: 'assistant', content: "That's a great book!" },
      ],
      scopes: [{ kind: 'app', id: 'test' }],
      source: { package: 'mama-core', source_type: 'test' },
      extract: { enabled: true, mode: 'hybrid' },
    });
    expect(result.extractedMemories.length).toBeGreaterThan(0);

    // Recall
    const bundle = await recallMemory('How long did it take to finish The Nightingale?');
    expect(bundle.memories.length).toBeGreaterThan(0);
    const relevant = bundle.memories.find(
      (m) => m.summary.includes('Nightingale') || m.summary.includes('21')
    );
    expect(relevant).toBeDefined();
  });

  it('should ingest document and recall', async () => {
    const result = await ingestDocument({
      type: 'pdf',
      content: 'Contract with Client A: 1 year term, monthly payment 5M KRW, starting April 2026.',
      metadata: { filename: 'client-a-contract.pdf' },
      source: { package: 'mama-core', source_type: 'test' },
      scopes: [{ kind: 'app', id: 'gmail' }],
    });
    expect(result.success).toBe(true);

    const bundle = await recallMemory('Client A contract terms');
    expect(bundle.memories.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run E2E test**

Run: `cd packages/mama-core && npx vitest run tests/integration/memory-e2e.test.ts`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add packages/mama-core/tests/integration/memory-e2e.test.ts
git commit -m "test(mama-core): add memory engine E2E test — hybrid ingest + recall"
```

---

## Completion Checklist (Eng Review + CEO Review + Post-Benchmark)

### Pre-v0.16 (Done — feat/memory-stabilization-benchmark)

- [x] Search quality overhaul (RRF, FTS5, lexical-first, stemming)
- [x] better-sqlite3 rollback for FTS5 support
- [x] Evolution engine: conservative supersede
- [x] Extraction prompt: dates/amounts/places/brands mandatory
- [x] Benchmark: 88% (100Q), 81.5% (200Q) — on par with SuperMemory 81.6%
- [x] PR review: ~66 comments resolved

### v0.16 Tasks (Remaining)

- [ ] Task 1: Scope-based vector search (replace topicPrefix with scope filtering)
- [ ] Task 2: Memory agent endpoint + debounce queue (max 50, Kagemusha pattern)
- [ ] Task 3: Debounce queue unit tests (enqueue, flush, overflow drop)
- [ ] Task 4: Claude Code Plugin hook (user + assistant response, fetch pattern TBD)
- [ ] Task 5: `mama memory search` CLI command (CEO cherry-pick)
- [ ] Task 6: Memory agent noise filtering (reject greetings, prompts, duplicates)
- [ ] Task 7: FTS5 trigger migration SQL (permanent migration file)
- [ ] Task 8: Temporal metadata on facts (event_date field)
- [ ] Task 9: 200-question benchmark report (with industry comparison)
- [ ] Task 10: E2E integration test (Sonnet extraction path)

### Removed / Deferred

- ~~Hybrid extractor~~ → stays in memorybench scripts (benchmark-only)
- ~~Wire hybrid into ingestConversation~~ → production uses Sonnet only
- ~~ingestDocument~~ → deferred to v0.17 (no consumer)

### Release Gate

All tasks above must pass. Then: bump version to 0.16.0, update CHANGELOG.md, tag release.

### Priority Order (recommended)

1. Task 7 (FTS5 migration) — blocker for production safety
2. Task 1 (scope-based search) — core infrastructure
3. Task 6 (noise filtering) — production quality
4. Task 2-3 (memory agent + queue) — main feature
5. Task 4 (plugin hook) — integration
6. Task 8 (temporal metadata) — benchmark improvement
7. Task 5 (CLI) — developer QoL
8. Task 9-10 (report + E2E) — validation
