# Memory Agent Path Benchmark Design

Date: 2026-03-28
Owner: standalone / memory-agent runtime
Status: prep

## Goal

Validate the real standalone runtime path:

1. user message enters gateway
2. main agent responds
3. memory agent receives the completed turn
4. memory agent searches, saves, and exits
5. follow-up turns can recall the saved memory

This benchmark must not bypass runtime with direct `ingestConversation()` or provider-only save shortcuts.

## Why

Earlier benchmark wins came from lower-level extraction paths and did not fully prove live gateway behavior.
The runtime now has enough working pieces to benchmark the actual memory-agent path:

- main Telegram/os-agent path responds
- memory agent triggers from `MessageRouter`
- save ack is observable via `/api/memory-agent/stats`
- successful `mama_save` now stops the memory loop immediately

## Benchmark Modes

### 1. Provider Path

Purpose:

- lower-level retrieval/extraction quality
- component benchmarking

Keep existing memorybench provider runs for:

- retrieval quality
- context quality
- answer quality

### 2. Agent Path

Purpose:

- prove real standalone runtime behavior
- prove save/recall/ack behavior through the live gateway contract

This is the proof benchmark for runtime memory quality.

## Scope

### In Scope

- Telegram or synthetic gateway message ingestion
- memory-agent trigger behavior
- save success/failure accounting
- follow-up recall correctness
- latency of:
  - main first response
  - memory-agent completion

### Out of Scope

- full memorybench replacement in one step
- provider-path removal
- large-scale benchmark automation before the runtime contract is stable

## Scenario Set

Use a small deterministic suite first.

### Save Scenarios

1. Explicit decision

- `앞으로 이 프로젝트 DB는 PostgreSQL로 사용하자. 기억해.`
- Expect:
  - candidate detected
  - `mama_search`
  - `mama_save`
  - `acksApplied = 1`

2. Preference

- `나는 Sony 호환 액세서리를 선호해.`
- Expect save under preference-like topic

3. No-op

- `고마워`
- Expect:
  - no candidate
  - no memory-agent invocation or `SKIP`

4. Supersede

- first: `DB는 SQLite로 가자`
- later: `이제 PostgreSQL로 바꾸자`
- Expect same topic evolution instead of unrelated duplicates

### Recall Scenarios

1. direct recall

- `우리 DB 뭐 쓰기로 했지?`
- Expect latest saved truth

2. preference recall

- `어떤 액세서리 성향이었지?`
- Expect stored preference

3. current truth after supersede

- Expect new truth, not stale old answer

## Metrics

### Runtime Metrics

- `main_response_ms`
- `memory_agent_ms`
- `turnsObserved`
- `factsSaved`
- `acksApplied`
- `acksSkipped`
- `acksFailed`

### Quality Metrics

- `correct_save`
- `wrong_topic`
- `duplicate_save`
- `false_skip`
- `correct_recall`
- `stale_recall`

## Success Criteria

Sample runtime benchmark should pass these before scaling up:

- explicit decision save success rate: 100%
- no-op false positive rate: 0%
- supersede handled on same topic or explicit evolution edge
- recall correctness: >= 80% on small scenario set
- memory-agent failed rate: 0 on stable sample runs

## Runbook

### Preconditions

- standalone running with Codex MCP backend
- Telegram connected
- `memory-agent` dashboard API healthy
- `MessageRouter` candidate extraction enabled
- memory agent immediate-stop-after-save enabled

### Manual Verification Commands

```bash
node /Users/jeongjaehun/project/MAMA/packages/standalone/dist/cli/index.js status
curl -s http://localhost:3847/api/memory-agent/stats
curl -s http://localhost:3847/api/memory-agent/dashboard
tail -120 /Users/jeongjaehun/.mama/logs/daemon.log
```

### Evidence to Capture

- main response completion log
- memory-agent session creation log
- `mama_save` success log
- session release log
- final stats snapshot
- saved decision row from SQLite

## Next Implementation Step

Add a small agent-path benchmark harness that:

1. sends deterministic gateway turns
2. waits for memory-agent completion
3. captures stats and DB deltas
4. runs follow-up recall turns
5. emits a compact runtime benchmark report

This harness should live separately from provider-path memorybench runs, then later be compared against them.
