# Memory Writer Agent — Design Spec

**Date:** 2026-03-27  
**Status:** Draft  
**Approach:** Replace the current audit/no-op memory agent flow with a two-stage `candidate extraction -> memory writer` pipeline, and align benchmark validation with the real runtime path.

## Background

Current runtime behavior proves that the standalone memory agent is connected and invoked, but it frequently ends in `skipped` without persisting durable memories. Recent live telemetry showed:

- Memory agent turns are observed (`turnsObserved > 0`)
- Channel dashboard linkage works
- Auth/child cleanup regressions were partially addressed
- Explicit decisions such as database choices still end as `acksSkipped`

At the same time, earlier benchmark work showed that the best accuracy improvements came not from a pure audit loop, but from decomposing conversations into typed memory units via `ingestConversation()` and then recalling those units. The MAMA checkpoints also already document this mismatch:

- `checkpoint_220`: memory agent should be a tool-using memory manager, not a text-returning auditor
- `checkpoint_227`: benchmark quality gains from `ingestConversation()` were benchmark-only and did not reflect the live `memory agent -> saveMemory()` runtime path
- `checkpoint_229`: tool calls worked in runtime, but recall/ack/runtime semantics remained incomplete

The design implication is direct: the runtime memory agent should not be the first component deciding whether a turn is memory-worthy. That classification must happen earlier and more deterministically.

## Problem Statement

The current architecture is wrong in two ways:

1. It gives the memory agent too much discretion over whether to save at all.
2. It benchmarks a different ingestion path than the one used in live operation.

This leads to:

- false skips for explicit decisions and preferences
- weak observability (`skipped` hides whether a candidate existed)
- runtime/benchmark divergence
- excessive dependence on agent prompt compliance

## Target Architecture

### 1. Candidate Extraction Layer

Add a pre-memory-agent layer that examines recent conversation context and emits structured `SaveCandidate` objects.

This layer is responsible for:

- detecting explicit durable memory candidates
- classifying them into memory kinds
- carrying evidence snippets and confidence
- deciding whether the memory writer agent should be invoked at all

This layer must be deterministic-first:

- rule-based detection for explicit decisions, preferences, constraints, and changes
- optional lightweight LLM extraction later, but not required for the first implementation

### 2. Memory Writer Agent

The memory agent becomes a `writer`, not a `judge`.

Its job is:

- search for related existing memories via `mama_search`
- determine topic continuity
- decide `supersedes` / `builds_on` / `synthesizes`
- call `mama_save`
- return a structured ack describing what happened

It should no longer be responsible for deciding whether obvious durable content is memory-worthy.

### 3. Candidate-Aware Ack Semantics

Ack classification must distinguish:

- no candidate existed
- candidate existed but save was skipped
- candidate existed and save failed
- candidate existed and save was applied

This prevents explicit decisions from being silently swallowed as routine `skipped`.

### 4. Benchmark Alignment

Benchmarking must be split into:

- `provider-path benchmark`: lower-level extraction/save/recall performance
- `agent-path benchmark`: real runtime path using candidate extraction + memory writer agent

The latter is the only benchmark that should be used as proof of runtime memory quality.

## Data Model

### SaveCandidate

```ts
type SaveCandidateKind =
  | 'decision'
  | 'preference'
  | 'fact'
  | 'constraint'
  | 'lesson'
  | 'profile_update'
  | 'change';

interface SaveCandidate {
  id: string;
  kind: SaveCandidateKind;
  confidence: number;
  topicHint?: string;
  summary: string;
  evidence: string[];
  channelKey: string;
  source: string;
  channelId: string;
  userId?: string;
  projectId?: string;
  createdAt: number;
}
```

### Memory Writer Ack

```ts
interface MemoryWriterAck {
  status: 'applied' | 'skipped' | 'failed' | 'needs_review';
  action: 'save' | 'supersede' | 'builds_on' | 'synthesizes' | 'no_op';
  topic?: string;
  event_ids: string[];
  reason?: string;
  candidateId?: string;
}
```

## File Responsibilities

### New/Expanded Runtime Files

- `packages/standalone/src/memory/save-candidate-extractor.ts`
  - Detect durable memory candidates from recent turns
- `packages/standalone/src/memory/save-candidate-types.ts`
  - Candidate contracts and helper types
- `packages/standalone/src/memory/memory-agent-dashboard.ts`
  - Extend metrics/payloads to include candidate lifecycle counters
- `packages/standalone/src/memory/memory-agent-ack.ts`
  - Candidate-aware ack classification
- `packages/standalone/src/gateways/message-router.ts`
  - Build candidate extraction input, invoke writer agent only when candidates exist, record candidate-aware metrics
- `packages/standalone/src/multi-agent/memory-agent-persona.ts`
  - Rewrite persona from memory auditor to memory writer

### Benchmark/Validation Files

- `packages/standalone/tests/gateways/message-router.test.ts`
  - Candidate detection, writer invocation, ack behavior
- `packages/standalone/tests/memory/*.test.ts`
  - Candidate extractor and dashboard contract tests
- `~/.mama/workspace/memorybench/src/providers/mama/index.ts`
  - Later: optional agent-path benchmark provider or alignment helper

## Runtime Flow

```text
User turn
-> MessageRouter builds recent turn window
-> SaveCandidateExtractor emits 0..N candidates
-> if no candidates: no memory agent invocation
-> if candidates exist: invoke Memory Writer Agent
-> writer calls mama_search
-> writer decides topic / relationship
-> writer calls mama_save
-> candidate-aware ack recorded
-> dashboard + notices + channel summary updated
```

## What Must Count As Candidates

Examples that should be promoted automatically:

- “앞으로 PostgreSQL을 기본 DB로 사용하자”
- “이건 기억해”
- “우리 DB는 SQLite로 하기로 했지”
- “나는 Sony 호환 액세서리를 선호해”
- “예전엔 4명, 지금은 5명 리드한다”

Examples that should remain no-op:

- “고마워”
- “좋네”
- pure acknowledgment without durable state

## Observability Requirements

Add the following metrics:

- `candidatesDetected`
- `writerInvoked`
- `saveAttempted`
- `saveApplied`
- `saveSkipped`
- `saveFailed`
- `falseSkipSuspected`

The memory agent dashboard should show these separately.

## Benchmark Strategy

### Provider-Path Benchmark

Purpose:

- measure lower-level typed memory API quality
- still valid for `saveMemory` / `ingestConversation` / `recallMemory`

### Agent-Path Benchmark

Purpose:

- measure the real runtime path used by live gateways
- should be the final proof benchmark for MAMA standalone memory quality

### Acceptance for Agent-Path Benchmark

- explicit decision saves should have near-zero false skips
- preference extraction should outperform current `single-session-preference = 0%`
- benchmark ingestion path must not bypass runtime candidate extraction + writer path

## Risks

- Rule-based candidate extraction can over-trigger if too broad
- Writer agent prompt still needs enough context to form stable topics/relationships
- Candidate extraction and runtime save path changes can affect dashboard semantics and memory volume
- Benchmark migration may temporarily lower scores while the runtime path is being aligned

## Recommended Next Step

Implement the first deterministic version of `SaveCandidateExtractor`, rewire `MessageRouter` to invoke the memory agent only for extracted candidates, and upgrade ack/dashboard semantics before touching benchmark code again.
