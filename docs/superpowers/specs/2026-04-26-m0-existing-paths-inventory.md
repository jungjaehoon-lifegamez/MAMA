# M0 Existing Path Inventory

작성일: 2026-04-27
작성 브랜치: `codex/p1-runtime-contract-impl`
근거: spec v2.3 §11 M0, P1 runtime contract v6

목표: raw connector ingest만으로 `MemoryItem` / `Case` / `Edge` / decision-like
영속 객체가 생기는 경로를 찾고, P1에서 kill-switch 또는 후속 phase 이관
대상을 명확히 한다.

## 1. Connector → Case/Decision/Memory auto-create paths

명령:

```bash
rg -n "case_ingest|connectorCaseIngest|extractSaveCandidates|saveDecision|case\\.create|insertCase|createCase" packages/standalone/src -g '*.ts' -g '!**/*.test.ts' -g '!**/__tests__/**'
rg -n "saveMemory\\(|ingestCaseEvent\\(|writeCaseLiveStateFromEvent\\(|upsertEntityObservations\\(|rawStore\\.save|PollingScheduler|startBatch\\(" packages/standalone/src/cli/runtime/connector-init.ts packages/standalone/src/connectors packages/standalone/src/memory packages/standalone/src/gateways -g '*.ts'
rg -n "INSERT INTO cases|INSERT INTO decisions" packages/standalone/src packages/mama-core/src -g '*.ts'
```

| File:line | Path | Trigger | Target table/object | Disposition |
|---|---|---|---|---|
| `packages/standalone/src/connectors/framework/polling-scheduler.ts:82` | `PollingScheduler.pollAll()` saves connector items into `RawStore` | connector poll returns items | `raw_items` only | keep; raw evidence write is allowed |
| `packages/standalone/src/cli/runtime/connector-init.ts:152` | connector extraction pipeline calls `upsertEntityObservations()` | classified connector batch | entity observations | migrate/defer; not a case/decision write, but still raw-derived projection and should be governed in P3/P4 |
| `packages/standalone/src/cli/runtime/connector-init.ts:186` | `extractAndSave()` calls `saveMemory()` for LLM-extracted connector facts | classified `activity` / `spoke` batch after connector poll | `MemoryItem` / decision-memory substrate via mama-core | kill in M0; replace with visible no-op warning or candidate-only path |
| `packages/mama-core/src/db-manager.ts:483` | low-level decision insert | explicit `saveDecision` / memory API write | `decisions` | keep; not raw connector ingest by itself |
| recent branch only: `packages/standalone/src/memory/connector-case-ingest.ts` | `ingestConnectorCasesForItems()` calls `ingestCaseEvent()` | connector normalized items | case event / case substrate | integration risk; if branch lands before P1 completion, add M0 kill switch before runtime exposure |
| recent branch only: `packages/standalone/src/memory/connector-case-ingest.ts` | `attachSavedDecisionToCases()` calls `writeCaseLiveStateFromEvent()` | connector memory candidate with source ids | case live-state membership | integration risk; kill or defer to M3/M5 envelope-governed path |

No current HEAD match was found for `packages/standalone/src/memory/connector-case-ingest.ts`,
`packages/standalone/src/api/case-board-router.ts`, or
`packages/standalone/src/api/case-task-board-router.ts`.

## 2. extractSaveCandidates pipeline

Current reactive chat memory path:

```text
MessageRouter.process()
  -> after response, fire-and-forget triggerMemoryAgent()
  -> extractSaveCandidates(userText, botResponse, channel/source/project context)
  -> AuditTaskQueue.enqueue(job)
  -> memory agent prompt instructs mama_search once, then mama_save at most once
  -> GatewayToolExecutor / MCP executor handles mama_save
```

Evidence:

- `packages/standalone/src/gateways/message-router.ts:46` imports `extractSaveCandidates`.
- `packages/standalone/src/gateways/message-router.ts:1481` builds candidates.
- `packages/standalone/src/gateways/message-router.ts:1304` instructs the memory agent to call `mama_save`.
- `packages/standalone/src/memory/save-candidate-extractor.ts:100` is regex/heuristic candidate detection.

Disposition:

- Keep as existing user-facing chat memory behavior during M0.
- Mark as transitional: under spec v2.3 this becomes candidate detection only.
- Later M3 memory.write / curator flow must replace direct save authority.
- P1 envelope work must make any tool write visible and scope-bound; do not silently fallback.

## 3. CaseWorkProjection consumers

Current HEAD has no `CaseWorkProjection`, `case_work_projection`, or
`caseWorkProjection` matches under `packages/standalone/src`.

Recent valid branches introduce read-only case/task-board assets:

- `codex/provenance-drawer-mainbase`
- `codex/work-item-identity`

Disposition:

- Do not import those routers in P1 only to test them.
- If either branch lands before P1 completes, add a read-only route invariant test and
  verify no `router.post`, `router.patch`, `router.put`, or `router.delete` exists.

## 4. Live/test DB boundary

Potential real DB defaults:

- `packages/mama-core/src/db-manager.ts:147` documents default `~/.claude/mama-memory.db`.
- `packages/mama-core/src/db-adapter/node-sqlite-adapter.ts:17` defines `DEFAULT_DB_PATH`.
- `packages/standalone/src/agent/auto-recall.ts:74` falls back to `~/.claude/mama-memory.db`.
- `packages/standalone/src/cli/runtime/mama-core-init.ts:143` sets `MAMA_DB_PATH` during runtime bootstrap.

Existing tests mostly set explicit temp DB paths:

- `packages/mama-core/src/test-utils.ts:117`
- `packages/mama-core/tests/entities/read-identity.test.ts:37`
- `packages/standalone/tests/gateways/memory-v2.e2e.test.ts:36`
- `packages/standalone/tests/benchmark/memory-provider-benchmark.test.ts:63`

Risk:

- There is not yet a global guard that refuses `MAMA_DB_PATH=~/.claude/mama-memory.db`
  inside Vitest/test processes.
- Task 5 should add that guard before broad test execution.

## 5. Recommended Kill Switch Order

1. Current HEAD: disable direct connector extraction writes in
   `packages/standalone/src/cli/runtime/connector-init.ts`.
   Replace `saveMemory()` writes from connector batches with a visible M0 no-op warning
   and keep raw evidence in `RawStore`.
2. Current HEAD: decide whether `upsertEntityObservations()` from connector batches is
   allowed as observation-only telemetry or should also become no-op until P3/P4. Default
   recommendation: defer raw-derived entity projection writes unless an explicit eval needs
   them before M3.
3. Recent branch integration: if `connector-case-ingest.ts` lands, kill-switch
   `ingestConnectorCasesForItems()` and `attachSavedDecisionToCases()` before enabling
   connector ingestion.
4. Future M3/M5: reintroduce curation through envelope-bound `memory.write` /
   case APIs with explicit source ids, scope, model-run provenance, and audit.

## Task 1 Status

Task 1 is complete for current HEAD. Task 2 should start with a defensive
`RawStore` isolation regression and a contract guard for the current direct connector
write path in `connector-init.ts`, then Task 3 can turn that path into a visible no-op.
