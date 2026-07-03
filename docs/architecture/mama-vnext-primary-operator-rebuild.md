# MAMA vNext Primary Operator Rebuild Plan

Status: draft, reviewed twice by read-only gstack-style subagents.
Branch base: `origin/main`.
Decision date: 2026-07-02.

## Decision

Discard the current standalone runtime architecture as the product foundation.

This does not mean deleting every useful module. It means the current branch is an
investigation branch, not the base for vNext. MAMA vNext should be built as a small
PR sequence from `main`.

## Review Status

The first review rejected the original broad rebuild plan. This document was split
into PR slices.

The second review rejected the first tracked `main`-based version because it still
contained branch-local assumptions from the dirty investigation branch:

- migration number was wrong for `origin/main`
- several referenced files did not exist on `origin/main`
- DB contracts were not exact enough
- connector polling could still write non-atomically before the vNext operator exists
- startup side-effect tests used a denylist instead of an allowlist

This version incorporates those findings. PR 0 is still documentation/contract-first.
Do not start runtime rewiring before PR 0 and PR 1 pass.

A final blocker-only review after these edits returned `APPROVE`: no remaining P0/P1
blockers for starting PR 0.

## Why

Current standalone runtime has too many durable-state writers:

- `packages/standalone/src/cli/commands/start.ts`
  owns bootstrap, config mutation, operator wiring, API wiring, system agents, and timers.
- `packages/standalone/src/gateways/message-router.ts`
  owns session routing, context injection, and per-turn memory recall.
- `packages/standalone/src/agent/agent-loop.ts`
  also owns session continuity, model-run lifecycle, tool execution, compaction, and telemetry.
- `packages/standalone/src/cli/runtime/api-routes-init.ts`
  creates dashboard/wiki system loops, timers, listeners, Obsidian launch, and report publishing.
- `packages/standalone/src/agent/gateway-tool-executor.ts`
  is a write-capable runtime kernel for tasks, report, wiki, memory, delegate, filesystem, and connector tools.

The bad shape:

```text
Gateway messages
  -> MessageRouter
      -> AgentLoop
          -> GatewayToolExecutor
              -> task/report/wiki/memory/delegate writes

osTaskLedgerEvents.changed
  -> dashboard SSE
  -> dashboard-agent
  -> wiki-agent
  -> memory compose
```

There is no single committer. That is the bug.

## Target Runtime

```text
Connectors / Gateways / Manual Tools
        |
        v
Raw Event Index
        |
        v
Primary Operator Runtime
        |
        +--> Context Compiler
        |       |
        |       v
        |   Context Packet Ledger
        |
        +--> delegate_worker(job)
        |       |
        |       v
        |   Worker Proposal Ledger
        |
        v
Commit Authority
        |
        v
Canonical Ledgers
  - TaskProjectLedger
  - MemoryLedger
  - WikiArtifactLedger
  - AgentRunLedger
  - ActionVerificationLedger
  - NoUpdateLedger
        |
        v
Deterministic Projections
  - Today Situation Board
  - Wiki Markdown/Obsidian Export
  - Memory Hint Packets
  - Verify/Audit Drawers
```

## Invariants

1. One committer per durable ledger.
2. No source refs, no durable write.
3. Workers propose. The primary operator commits.
4. Dashboard and wiki are projections, not canonical truth.
5. Memory recall is policy-gated, not injected every turn.
6. Cursor advancement is atomic and idempotent.
7. Public-release privacy audit is mandatory before every PR.

## Public Release Privacy Gate

MAMA is a public project. Every stage must prove it does not publish private,
customer, channel, local-machine, or internal project information.

Run this gate before opening every PR, after responding to PR review comments, and
before starting the next branch.

What to check:

- secrets: tokens, API keys, private keys, OAuth credentials, webhook URLs
- local identity: usernames, absolute home paths, machine names, local database paths
- private work context: customer names, channel names, Slack/Discord/Telegram IDs,
  internal project titles, raw chat excerpts, source message bodies
- generated docs: examples, screenshots, fixtures, markdown frontmatter, logs
- tests and fixtures: real connector payloads, real timestamps tied to private work,
  real message IDs unless synthetic and clearly marked

Required commands for every PR:

```bash
git diff --cached --check
git diff --cached --name-only
./scripts/check-pii.sh
```

`scripts/check-pii.sh` is the authoritative staged-file privacy check. It loads
`.pii-patterns` when that gitignored file exists and always runs the generic ID
checks built into the script.

If the gate finds anything:

1. classify it as synthetic/public-safe or private/internal
2. remove, redact, or replace private/internal content before review
3. add a test or fixture note when synthetic IDs are intentional

Code review cannot be marked clear until this gate is clear.

## What To Reuse

- `packages/mama-core/src/connectors/event-index.ts`
  - raw event index foundation
- `packages/mama-core/src/context-compile/ref.ts`
  - existing context ref parsing and provenance string serialization
- `packages/mama-core/src/context-compile/packet-store.ts`
  - trusted context packet lookup
- `packages/mama-core/src/model-runs/*`
  - model run and tool trace provenance
- `packages/standalone/src/api/agent-situation-handler.ts`
  - current agent situation API surface on `origin/main`
- `packages/standalone/src/api/report-handler.ts`
  - current report surface on `origin/main`, legacy-only in vNext
- `packages/standalone/src/api/wiki-handler.ts`
  - current wiki HTTP surface on `origin/main`
- `packages/standalone/src/api/worker-envelope.ts`
  - current envelope read boundary on `origin/main`
- `packages/standalone/src/agent/delegation-executor.ts`
  - bounded delegation mechanics
- `packages/standalone/src/wiki/obsidian-writer.ts`
  - export sink only

Do not reuse as architecture:

- self-paced `dashboard-agent`
- self-paced `wiki-agent`
- always-on multi-agent chat routing
- per-turn `MessageRouter.getPerTurnMemoryPrefix`
- direct `wiki_publish` with empty `sourceIds`
- `report_publish` as canonical dashboard state

## Source Inventory From `origin/main`

The following files from the investigation branch do **not** exist on `origin/main`
and must not be referenced as existing code:

- `packages/standalone/src/operator/task-ledger-store.ts`
- `packages/standalone/src/operator/projection-publisher.ts`
- `packages/standalone/src/operator/os-operator-loop.ts`
- `packages/standalone/src/api/today-handler.ts`
- `packages/standalone/src/api/verify-types.ts`

If vNext needs these ideas, recreate them as new files in a PR, or port only the
minimal required logic after tests exist.

Current `origin/main` startup/control files that PR 1 must inventory:

- `packages/standalone/src/cli/commands/start.ts`
- `packages/standalone/src/cli/runtime/connector-init.ts`
- `packages/standalone/src/cli/runtime/scheduler-init.ts`
- `packages/standalone/src/cli/runtime/api-routes-init.ts`
- `packages/standalone/src/cli/runtime/gateway-init.ts`
- `packages/standalone/src/cli/runtime/gateway-wiring.ts`
- `packages/standalone/src/cli/runtime/memory-agent-init.ts`

Current `origin/main` connector polling files that PR 1 must control:

- `packages/standalone/src/connectors/framework/polling-scheduler.ts`
- `packages/standalone/src/memory/raw-backed-memory-ingest.ts`
- `packages/standalone/src/memory/history-extractor.ts`

## Not In Scope

- Full UI redesign.
- Replacing SQLite.
- Changing the embedding model.
- Removing all legacy runtime code in the first PR.
- Building a generic swarm.
- Automatically promoting legacy wiki/report artifacts to verified state.

## SourceRef Compatibility Matrix

Do not create a third provenance dialect in standalone. The canonical parser belongs
in `mama-core`.

| Surface                   | Current shape                                   | Current kinds                                                                                               | Problem                                         | vNext rule                                                |
| ------------------------- | ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ----------------------------------------------- | --------------------------------------------------------- |
| context compile           | object refs                                     | `memory`, `raw`, `entity`, `case`                                                                           | rejects `context_packet`, `report`, `wiki_page` | keep V0 parser, add conversion to canonical `SourceRef`   |
| context provenance string | `raw:${connector}:${raw_id}` or `${kind}:${id}` | `raw`, `memory`, `entity`, `case`                                                                           | string form is narrower than needed             | canonical serializer must round-trip current strings      |
| verify artifact           | `{ type, id }`                                  | `decision`, `os_task`, `agent_situation_packet`, `report_slot`, `context_packet`, `model_run`, `tool_trace` | uses `type`, not `kind`                         | add adapter from verify artifact to canonical `SourceRef` |
| memory provenance         | `source_refs: string[]`                         | unconstrained strings                                                                                       | permits bad refs                                | validate strings before trusted writes                    |
| legacy memory provenance  | string refs                                     | `message:*`, `conversation:*`, `raw_memory:*`                                                               | current tests allow these strings               | grandfather as `legacy` refs before strict enforcement    |
| wiki current              | `sourceIds: string[]`                           | often empty                                                                                                 | source chain breaks                             | reject empty source refs in vNext                         |

Canonical file:

```text
packages/mama-core/src/provenance/source-ref.ts
```

Required adapters:

- `fromContextRef(ref: ContextRef): SourceRef`
- `toContextRef(ref: SourceRef): ContextRef | null`
- `fromVerifyArtifact(artifact: { type: string; id: string }): SourceRef`
- `parseSourceRefString(value: string): SourceRef`
- `serializeSourceRef(ref: SourceRef): string`
- `assertNonEmptySourceRefs(refs: SourceRef[]): void`

Compatibility tests must include:

- current context refs: `raw`, `memory`, `entity`, `case`
- current provenance strings: `raw:${connector}:${raw_id}`, `${kind}:${id}`
- verify-like artifact refs: `context_packet`, `model_run`, `tool_trace`
- legacy memory strings: `message:test`, `conversation:test`, `raw_memory:test`
- rejection of empty strings and unknown strict refs

## Atomic Commit Semantics

Cursor commit must use a contiguous-delivery rule: only events whose durable effects
are committed, or explicitly recorded as no-update, can move the cursor.

```text
read events after cursor
  |
  v
process batch
  |
  +-- changed durable state
  |      |
  |      v
  |   commit rows + commit marker + cursor in one transaction
  |
  +-- no update
  |      |
  |      v
  |   commit no_update row + cursor in one transaction
  |
  +-- error / partial failure
         |
         v
      cursor unchanged
```

Rules:

- Cursor advances only to the highest contiguous delivered event.
- Every batch has an idempotency key:
  - `connector:${source_connector}:seq:${first_change_seq}-${last_change_seq}`
- Durable write and cursor advance happen in one DB transaction when they share a DB.
- If they cannot share a DB, write a commit marker first and reconcile cursor on startup.
- Projection failure does not roll back canonical state, but it records a projection error.
- Model text without `changed` or `no_update` is a failed commit.
- DB busy retries are bounded and visible.
- Two primary operators racing must not double-commit the same idempotency key.

## Commit Authority Matrix

Default in vNext: deny durable writes unless explicitly allowed.

| Tool/path         | Primary operator                 | Worker                 | Legacy agent  | Viewer/admin                   | Notes                        |
| ----------------- | -------------------------------- | ---------------------- | ------------- | ------------------------------ | ---------------------------- |
| `task_create`     | allow                            | deny                   | legacy-only   | deny                           | worker returns task proposal |
| `task_update`     | allow                            | deny                   | legacy-only   | deny                           | primary commits after verify |
| `mama_save`       | allow through memory commit path | deny                   | legacy-only   | admin/manual allowed with refs | source refs required         |
| `wiki_publish`    | allow proposal commit            | proposal-only          | legacy-only   | admin/manual allowed with refs | no empty refs                |
| `report_publish`  | deny as canonical state          | deny                   | legacy-only   | deny                           | dashboard reads projection   |
| `delegate`        | allow                            | deny nested by default | legacy-only   | deny                           | bounded depth                |
| filesystem writes | deny by default                  | deny by default        | legacy policy | viewer policy                  | not part of canonical state  |

Implementation hook:

```text
packages/standalone/src/agent/gateway-tool-executor.ts
  -> resolveCommitAuthority(toolName, agentContext, envelope, runtimeMode)
  -> deny before switch side effects
```

## DB Contract

`origin/main` currently has mama-core SQL migrations through `037`.

PR 0 owns the next contiguous migration:

```text
packages/mama-core/db/migrations/038-create-vnext-operator-contracts.sql
```

Never skip migration numbers. The migration runner reads `MAX(schema_version)` and
skips `version <= currentVersion`; a jump from `037` to `061` can permanently skip
future `038-060` migrations on upgraded databases.

PR 0 tables:

```sql
CREATE TABLE IF NOT EXISTS vnext_operator_cursors (
  cursor_name TEXT PRIMARY KEY,
  last_change_seq INTEGER NOT NULL DEFAULT 0,
  last_idempotency_key TEXT,
  updated_at_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS vnext_operator_commits (
  commit_id TEXT PRIMARY KEY,
  cursor_name TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  first_change_seq INTEGER NOT NULL CHECK (first_change_seq >= 0),
  last_change_seq INTEGER NOT NULL CHECK (last_change_seq >= first_change_seq),
  status TEXT NOT NULL CHECK (status IN ('changed', 'no_update')),
  changed_refs_json TEXT NOT NULL,
  source_refs_json TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  FOREIGN KEY (cursor_name) REFERENCES vnext_operator_cursors(cursor_name)
);

CREATE INDEX IF NOT EXISTS idx_vnext_operator_commits_cursor_seq
  ON vnext_operator_commits(cursor_name, last_change_seq);

CREATE TABLE IF NOT EXISTS operator_no_updates (
  no_update_id TEXT PRIMARY KEY,
  scope_key TEXT NOT NULL,
  reason TEXT NOT NULL,
  source_refs_json TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  created_at_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS worker_proposals (
  proposal_id TEXT PRIMARY KEY,
  worker_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  source_refs_json TEXT NOT NULL,
  confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  status TEXT NOT NULL CHECK (status IN ('proposed', 'accepted', 'rejected', 'superseded')),
  created_at_ms INTEGER NOT NULL,
  accepted_at_ms INTEGER CHECK (accepted_at_ms IS NULL OR accepted_at_ms >= created_at_ms)
);

CREATE INDEX IF NOT EXISTS idx_worker_proposals_status_kind
  ON worker_proposals(status, kind, created_at_ms);
```

Source ref constraints:

- SQLite cannot validate source-ref JSON shape with current project conventions.
- Store validation lives in TypeScript and is required before every insert.
- Tests must verify invalid/empty refs cannot reach these tables through store APIs.

Transaction ownership:

- PR 0 creates schema and store-level validation helpers only.
- PR 2 owns transaction code that writes `vnext_operator_commits`,
  `operator_no_updates`, and `vnext_operator_cursors` together.
- `worker_proposals` can be inserted independently, but accepting a proposal must
  happen in the same transaction as the canonical commit that consumes it.

Migration-chain test:

```text
packages/mama-core/tests/db/migration-chain.test.ts
```

The test must fail when SQL migration filenames skip a version number.

## PR Sequence

### PR 0: Contracts And Compatibility

Goal:

- Create shared `SourceRef` contract.
- Add no-update and worker proposal schemas.
- Add architecture invariant tests.
- No runtime behavior changes except validation helpers.

Files:

- Create: `packages/mama-core/src/provenance/source-ref.ts`
- Create: `packages/mama-core/tests/provenance/source-ref.test.ts`
- Modify: `packages/mama-core/src/index.ts`
- Create: `packages/mama-core/db/migrations/038-create-vnext-operator-contracts.sql`
- Create: `packages/mama-core/tests/db/migration-chain.test.ts`
- Create: `packages/mama-core/tests/provenance/vnext-operator-contracts.test.ts`
- Create: `packages/standalone/tests/vnext/architecture-invariants.test.ts`
- Create: `docs/architecture/mama-vnext-primary-operator-adr.md`

Verify:

```bash
MAMA_FORCE_TIER_3=true pnpm vitest run \
  packages/mama-core/tests/provenance/source-ref.test.ts \
  packages/mama-core/tests/provenance/vnext-operator-contracts.test.ts \
  packages/mama-core/tests/db/migration-chain.test.ts \
  packages/standalone/tests/vnext/architecture-invariants.test.ts
```

Build/typecheck:

```bash
pnpm --filter @jungjaehoon/mama-core build
pnpm --filter @jungjaehoon/mama-os typecheck
```

### PR 1: vNext Bootstrap And Legacy Fanout-Off

Goal:

- Add vNext mode that starts without legacy dashboard/wiki/memory side effects.
- Do not build the full operator yet.
- Prove legacy mode stays unchanged.
- Use a startup allowlist, not a side-effect denylist.
- Disable connector polling in vNext until PR 2 can consume raw events atomically.

Files:

- Create: `packages/standalone/src/runtime-vnext/feature-flags.ts`
- Create: `packages/standalone/src/runtime-vnext/bootstrap.ts`
- Modify: `packages/standalone/src/cli/commands/start.ts`
- Modify: `packages/standalone/src/cli/runtime/api-routes-init.ts`
- Modify: `packages/standalone/src/cli/runtime/connector-init.ts`
- Modify: `packages/standalone/src/cli/runtime/scheduler-init.ts`
- Create: `packages/standalone/tests/runtime-vnext/bootstrap.test.ts`
- Create: `packages/standalone/tests/runtime-vnext/legacy-fanout-disabled.test.ts`

Regression cases:

Allowed in vNext PR 1:

- config read
- DB initialization
- API server health endpoint
- explicit manual endpoints needed for status
- no-op primary operator placeholder

Forbidden in vNext PR 1:

- vNext mode does not schedule dashboard-agent interval.
- vNext mode does not schedule wiki-agent interval.
- vNext mode does not schedule ledger-triggered memory compose.
- vNext mode does not launch Obsidian.
- vNext mode does not rewrite MCP config as part of dashboard/wiki setup.
- vNext mode does not mutate config to add OS/dashboard/wiki agents.
- vNext mode does not write persona files.
- vNext mode does not start heartbeat/token keep-alive timers.
- vNext mode does not schedule Conductor audit.
- vNext mode does not call `messageRouter.process()` autonomously.
- vNext mode does not start connector polling.
- vNext PR 1 has no connector mode at all. Raw-index-only connector ingestion is
  deferred until PR 2, where the operator can commit raw events and cursor
  advancement in one transaction.
- legacy mode still schedules existing behavior.

Verify:

```bash
MAMA_FORCE_TIER_3=true pnpm vitest run \
  packages/standalone/tests/runtime-vnext/bootstrap.test.ts \
  packages/standalone/tests/runtime-vnext/legacy-fanout-disabled.test.ts
```

Use fake timers and spies for config/persona writes, scheduler timers, connector
polling, and `messageRouter.process()`.

### PR 2: Atomic Primary Operator Commit

Goal:

- Add primary operator commit shell.
- Implement no-update store.
- Add cursor commit idempotency and crash recovery tests.
- Do not wire live gateways yet.

Files:

- Create: `packages/standalone/src/operator-vnext/operator-commit-result.ts`
- Create: `packages/standalone/src/operator-vnext/no-update-ledger.ts`
- Create: `packages/standalone/src/operator-vnext/operator-cursor-commit.ts`
- Create: `packages/standalone/src/operator-vnext/primary-operator-runtime.ts`
- Create: `packages/standalone/tests/operator-vnext/no-update-ledger.test.ts`
- Create: `packages/standalone/tests/operator-vnext/operator-cursor-commit.test.ts`
- Create: `packages/standalone/tests/operator-vnext/primary-operator-runtime.test.ts`

Regression cases:

- changed commit advances cursor
- no-update advances cursor
- thrown error does not advance cursor
- crash after ledger write before cursor is reconciled on startup
- crash after cursor write does not duplicate commit
- partial channel failure advances only contiguous delivered prefix
- two operators racing on same idempotency key result in one commit
- DB busy retry stops after bounded attempts

### PR 3: Primary Operator Bootstrap Runtime

Goal:

- Replace the PR 1 `primary_operator_placeholder` startup step with explicit
  operator schema and runtime preparation.
- Keep legacy fanout disabled while exposing the primary operator readiness state
  through authenticated status APIs.
- Preserve the PR 1/PR 2-compatible `primary_operator` response field during the
  transition; expose the new runtime payload as `primary_operator_runtime`.

Files:

- Create: `packages/standalone/src/operator-vnext/schema.ts`
- Modify: `packages/standalone/src/runtime-vnext/bootstrap.ts`
- Modify: `packages/standalone/src/cli/commands/start.ts`
- Create: `packages/standalone/tests/operator-vnext/schema.test.ts`
- Modify: `packages/standalone/tests/runtime-vnext/bootstrap.test.ts`
- Modify: `packages/standalone/tests/runtime-vnext/bootstrap-api.test.ts`

Regression cases:

- empty sessions DB gets vNext operator tables before runtime creation
- existing sessions DB skips repeated schema work
- failed operator schema installation rolls back as one transaction
- status endpoints keep `/health` public and `/api/*` authenticated
- existing status clients can still parse `primary_operator.status = noop`
- new status clients can read `primary_operator_runtime.cursor_name`,
  `connector`, and `advanced_through_seq`
- `createVNextPrimaryOperatorRuntime` binds the manual connector and advances
  the `operator:primary` cursor through `processBatch`

### PR 4: Wiki Artifact Adapter And Store

Goal:

- Extract wiki publish/import/export out of `gateway-tool-executor.ts`.
- Add source-linked wiki artifact store.
- Make `wiki_publish` vNext path reject empty refs.

Files:

- Create: `packages/standalone/src/wiki-artifacts/types.ts`
- Create: `packages/standalone/src/wiki-artifacts/wiki-artifact-store.ts`
- Create: `packages/standalone/src/wiki-artifacts/wiki-publish-adapter.ts`
- Create: `packages/standalone/src/wiki-artifacts/wiki-exporter.ts`
- Modify: `packages/standalone/src/agent/gateway-tool-executor.ts`
- Modify: `packages/standalone/src/wiki/obsidian-writer.ts`
- Create: `packages/standalone/tests/wiki-artifacts/wiki-artifact-store.test.ts`
- Create: `packages/standalone/tests/wiki-artifacts/wiki-publish-adapter.test.ts`
- Create: `packages/standalone/tests/wiki-artifacts/wiki-exporter.test.ts`

Rule:

`gateway-tool-executor.ts` should delegate to a wiki adapter. It should not own wiki
publish logic.

### PR 5: Dashboard Projection And Commit Authority

Goal:

- Add a vNext situation projection for `origin/main`.
- Add commit authority gate for durable write tools.
- Restrict workers to proposals in vNext mode.

Files:

- Create: `packages/standalone/src/operator-vnext/situation-projection.ts`
- Create: `packages/standalone/src/operator-vnext/situation-projection-types.ts`
- Modify: `packages/standalone/src/api/report-handler.ts`
- Modify: `packages/standalone/src/api/index.ts`
- Create: `packages/standalone/tests/operator-vnext/situation-projection.test.ts`
- Create: `packages/standalone/tests/api/report-vnext.test.ts`
- Create: `packages/standalone/src/operator-vnext/commit-authority.ts`
- Modify: `packages/standalone/src/agent/gateway-tool-executor.ts`
- Modify: `packages/standalone/src/agent/delegation-executor.ts`
- Create: `packages/standalone/tests/operator-vnext/commit-authority.test.ts`
- Create: `packages/standalone/tests/operator-vnext/delegation-authority.test.ts`

Rules:

- Do not reference `packages/standalone/src/operator/projection-publisher.ts` on
  `origin/main`; it does not exist here.
- If the investigation branch's projection logic is useful, port the minimum tested
  logic into `operator-vnext/situation-projection.ts`.
- Keep current `report-handler.ts` legacy-compatible. vNext projection is selected
  only when the vNext runtime flag is active.
- `gateway-tool-executor.ts` must check authority before side effects.

Verify:

```bash
MAMA_FORCE_TIER_3=true pnpm vitest run \
  packages/standalone/tests/operator-vnext/situation-projection.test.ts \
  packages/standalone/tests/api/report-vnext.test.ts \
  packages/standalone/tests/operator-vnext/commit-authority.test.ts \
  packages/standalone/tests/operator-vnext/delegation-authority.test.ts
```

### PR 6: Connector Ingress Dry-Run Rollout

Goal:

- Add a local, authenticated dry-run runway for one explicit connector/channel.
- Convert `connector_event_index` rows into source-linked primary-operator event
  candidates without advancing cursors or committing durable state.
- Keep connector polling, dashboard/wiki agents, memory compose, and worker commits
  disabled by default in vNext bootstrap mode.

Files:

- Create: `packages/standalone/src/operator-vnext/connector-event-ingress.ts`
- Modify: `packages/standalone/src/cli/commands/start.ts`
- Create: `packages/standalone/tests/operator-vnext/connector-event-ingress.test.ts`
- Modify: `packages/standalone/tests/runtime-vnext/bootstrap-api.test.ts`

Runtime opt-in:

```bash
MAMA_VNEXT_RUNTIME=1 \
MAMA_VNEXT_INGRESS_CONNECTOR=slack \
MAMA_VNEXT_INGRESS_CHANNEL=C_PUBLIC_SYNTHETIC \
mama start --foreground
```

Authenticated preview endpoint:

```text
GET /api/vnext/ingress/preview?connector=slack&channel=C_PUBLIC_SYNTHETIC&limit=25
```

Rules:

- `MAMA_VNEXT_INGRESS_CONNECTOR` and `MAMA_VNEXT_INGRESS_CHANNEL` must be set
  together.
- Preview is locked to the configured connector/channel.
- Preview returns source refs and deterministic event seq candidates only.
- Preview must not insert `vnext_operator_commits`, `vnext_operator_cursors`, or
  `operator_no_updates` rows.
- Preview must not promote legacy report/wiki/memory artifacts.

Verify:

```bash
MAMA_FORCE_TIER_3=true pnpm --filter @jungjaehoon/mama-os exec vitest run \
  tests/operator-vnext/connector-event-ingress.test.ts \
  tests/runtime-vnext/bootstrap-api.test.ts \
  tests/runtime-vnext/bootstrap.test.ts \
  tests/runtime-vnext/legacy-fanout-disabled.test.ts
```

### PR 7: Connector Ingress Migration Dry-Run Report

Goal:

- Add an authenticated migration dry-run report on top of the PR 6 connector
  ingress preview.
- Report which explicit connector/channel raw events would require primary
  operator decisions before migration.
- Keep the report read-only: no commits, cursor movement, no-update rows, or
  promotion of report/wiki/memory artifacts.

Files:

- Create: `packages/standalone/src/operator-vnext/connector-ingress-migration-dry-run.ts`
- Modify: `packages/standalone/src/cli/commands/start.ts`
- Create: `packages/standalone/tests/operator-vnext/connector-ingress-migration-dry-run.test.ts`
- Modify: `packages/standalone/tests/runtime-vnext/bootstrap-api.test.ts`

Authenticated migration dry-run endpoint:

```text
GET /api/vnext/ingress/migration-dry-run?connector=slack&channel=C_PUBLIC_SYNTHETIC&limit=25
```

Rules:

- Migration dry-run is locked to the configured connector/channel.
- Migration dry-run returns source refs, event seqs, and decision-readiness only.
- Migration dry-run must not call the primary operator commit path.
- Migration dry-run must not insert `vnext_operator_commits`,
  `vnext_operator_cursors`, or `operator_no_updates` rows.
- Migration dry-run must not promote report/wiki/memory artifacts.

Verify:

```bash
MAMA_FORCE_TIER_3=true pnpm --filter @jungjaehoon/mama-os exec vitest run \
  tests/operator-vnext/connector-ingress-migration-dry-run.test.ts \
  tests/operator-vnext/connector-event-ingress.test.ts \
  tests/runtime-vnext/bootstrap-api.test.ts \
  tests/runtime-vnext/bootstrap.test.ts \
  tests/runtime-vnext/legacy-fanout-disabled.test.ts
```

### PR 8: Default Config Drops Legacy Self-Paced Agents

Decision:

- Remove legacy self-paced `dashboard-agent` and `wiki-agent` from new default
  `multi_agent.agents`.
- Stop automatically backfilling those agents into existing configs.
- Preserve user-defined `dashboard-agent` and `wiki-agent` entries and keep their
  legacy permission migrations active.
- Update agent guidance so dashboard/wiki delegation is opt-in and only happens
  when the agent exists in config.

Files:

- Modify: `packages/standalone/src/cli/config/config-manager.ts`
- Modify: `packages/standalone/src/cli/commands/start.ts`
- Modify: `packages/standalone/src/cli/runtime/api-routes-init.ts`
- Modify: `packages/standalone/tests/cli/config-manager.test.ts`
- Modify: `packages/standalone/tests/agent/gateway-tool-executor.test.ts`
- Modify: `packages/standalone/tests/runtime-vnext/legacy-fanout-disabled.test.ts`
- Modify: `packages/standalone/src/agent/os-agent-capabilities.md`
- Modify: `packages/standalone/src/multi-agent/conductor-persona.ts`

Rules:

- New default config includes the primary operator-facing agents only:
  `os-agent`, `conductor`, and `memory`.
- Loading an older config must not create missing `dashboard-agent` or
  `wiki-agent` entries, even when `wiki.enabled` is true.
- Runtime startup must not persist missing `dashboard-agent` or `wiki-agent`
  entries back into config.
- Legacy dashboard/wiki timers, publishers, persona writes, MCP rewrites, and
  Obsidian wiring only start when the corresponding agent is explicitly
  configured and not disabled.
- Loading an older config that already has those agents must keep them and still
  migrate old Code-Act gateway permission allowlists.

Verify:

```bash
MAMA_FORCE_TIER_3=true pnpm --filter @jungjaehoon/mama-os exec vitest run \
  tests/cli/config-manager.test.ts \
  tests/agent/gateway-tool-executor.test.ts \
  tests/runtime-vnext/legacy-fanout-disabled.test.ts
```

### PR 13: Manual Memory Commit From Reviewed Ingress

Goal:

- Add an authenticated, operator-owned path that commits manually reviewed
  connector events into MAMA memory.
- Save approved memories as staged records first, then promote them only after the
  primary operator cursor commit succeeds.
- Make retries idempotent by recording memory commit intents keyed to the operator
  cursor idempotency key.

Files:

- Create: `packages/mama-core/db/migrations/040-create-operator-memory-commit-intents.sql`
- Create: `packages/standalone/src/operator-vnext/connector-ingress-manual-memory-commit.ts`
- Modify: `packages/standalone/src/cli/commands/start.ts`
- Modify: `packages/standalone/src/operator-vnext/schema.ts`
- Modify: `packages/mama-core/src/db-adapter/node-sqlite-adapter.ts`
- Create: `packages/standalone/tests/operator-vnext/connector-ingress-manual-memory-commit.test.ts`
- Modify: `packages/standalone/tests/runtime-vnext/bootstrap-api.test.ts`
- Modify: `packages/standalone/tests/operator-vnext/schema.test.ts`
- Modify: `packages/mama-core/tests/cases/migration-runner-duplicate-column.test.ts`

Authenticated manual memory endpoint:

```text
POST /api/vnext/ingress/manual-memory-commit
```

Rules:

- Manual memory commit is locked to the configured connector/channel.
- Requests provide only reviewed event ids and memory payloads; source refs and
  provenance are derived from reviewed raw events.
- Request-supplied source refs, provenance, gateway call ids, agent ids, or model
  run ids are rejected before durable writes.
- The HTTP response is allowlisted and must not expose raw connector events,
  source message bodies, local paths, memory ids, or internal provider fields.
- Saved memories remain `stale` and suppress `memory_truth` projection until the
  primary operator commit succeeds, so staged memories cannot enter normal truth
  snapshots before cursor commit.
- After cursor commit, each memory is promoted to its requested final status
  through the normal memory evolution path, including `supersedes` chain updates.
- If status promotion fails after the cursor commit, the response is still
  `committed` with `promotionPending: true`; the intent stays `saved` so the
  next idempotent replay can finish promotion without saving duplicate memories.
- Duplicate committed replays must not re-save memories or re-promote memory
  statuses.
- Concurrent or cross-process attempts use
  `operator_memory_commit_intents.status` and `claim_token` so only the current
  save owner can update memory ids or advance the intent state.
- A durable `saving` intent is a bounded lease, not a permanent lock. After the
  lease expires, replay may CAS-take the claim and recover already-saved memory
  ids from deterministic `gateway_call_id` provenance before saving anything new.
- Partial failures must not advance the operator cursor.

Verify:

```bash
MAMA_FORCE_TIER_3=true pnpm --filter @jungjaehoon/mama-os exec vitest run \
  tests/operator-vnext/connector-ingress-manual-memory-commit.test.ts \
  tests/runtime-vnext/bootstrap-api.test.ts \
  tests/operator-vnext/schema.test.ts

MAMA_FORCE_TIER_3=true pnpm --filter @jungjaehoon/mama-core exec vitest run \
  tests/memory/memory-provenance.test.ts \
  tests/memory/memory-promotion-semantic.test.ts \
  tests/cases/migration-runner-duplicate-column.test.ts \
  tests/cases/migration-chain.test.ts
```

## Global Regression Checklist

- legacy mode behavior unchanged
- vNext mode has no dashboard/wiki/memory timers
- vNext bootstrap does not launch Obsidian
- vNext bootstrap does not rewrite MCP config as part of dashboard/wiki setup
- vNext bootstrap does not mutate config/persona files
- vNext bootstrap does not start heartbeat/token/audit timers
- vNext bootstrap does not start connector polling in PR 1
- migration filenames are contiguous with no version gaps
- ordinary turn does not recall memory
- trigger turn recalls memory once
- wiki publish rejects empty source refs
- worker cannot commit durable state directly
- cursor does not advance on model text alone
- cursor does not advance after partial failure
- crash after ledger write before cursor is recoverable
- crash after cursor write does not duplicate commit
- two operators racing commit once
- DB busy retry is bounded
- migration dry run does not write operator commits, cursors, or no-update rows
- migration dry run does not promote unverified legacy artifacts
- manual memory commit rejects caller-supplied refs/provenance before durable writes
- manual memory commit keeps saved memories staged until cursor commit succeeds
- manual memory commit staged saves do not project to `memory_truth` until promotion
- manual memory commit duplicate replay does not duplicate saves or status promotion
- manual memory commit partial failure does not expose raw connector content
- manual memory commit HTTP responses are explicit allowlists
- manual memory commit promotion failure is recoverable with `promotionPending`
- manual memory commit stale save owners cannot overwrite promoted intents
- manual memory commit stale `saving` leases recover saved memory ids without
  duplicate saves
- manual memory promotion writes both `supersedes` and `superseded_by` chain
  fields

## Parallelization

Only pure contract/store work runs in parallel. Integration work is sequential.

| Lane | Work                                    | Modules                                      | Depends on |
| ---- | --------------------------------------- | -------------------------------------------- | ---------- |
| A    | PR 0 SourceRef and contracts            | `mama-core/src/provenance`, migrations       | none       |
| C    | PR 2 commit stores                      | `operator-vnext` stores                      | A          |
| D    | PR 3 primary operator bootstrap runtime | `operator-vnext`, `runtime-vnext`, start API | C          |
| E    | PR 4 wiki store/exporter pure modules   | `wiki-artifacts` pure modules                | A          |

Sequential integration:

```text
1. Merge A.
2. Implement PR 1 sequentially. It touches startup/config/connector/scheduler files.
3. Merge C.
4. Integrate D into vNext bootstrap/start API.
5. Integrate E into GatewayToolExecutor.
6. Add situation projection and report API adapter.
7. Add commit authority to GatewayToolExecutor and DelegationExecutor.
8. Run E2E and build.
```

Conflict flags:

- `gateway-tool-executor.ts` must be touched sequentially.
- `message-router.ts` must be touched sequentially.
- `start.ts` and `api-routes-init.ts` must be touched only in PR 1 until the vNext path is stable.
- `connector-init.ts` and `scheduler-init.ts` are PR 1 sequential startup integration files, not parallel lanes.
- Do not let multiple worktrees edit `gateway-tool-executor.ts` at the same time.

## Rollout

1. Land PR 0 with no runtime behavior change.
2. Land PR 1 and verify `MAMA_VNEXT_RUNTIME=1` has no legacy side effects.
3. Land PR 2 and run synthetic connector deltas.
4. Land PR 3 and dogfood ordinary chat vs prior-rule chat.
5. Land PR 4 and import one wiki page as unverified, then commit one source-linked artifact.
6. Land PR 5 and switch Today dashboard to existing projection extension.
7. Land PR 6 and enable vNext dry-run preview locally for one connector/channel.
8. Land PR 7 and run the authenticated migration dry-run report for one connector/channel.
9. Land PR 8 and verify legacy self-paced agents are opt-in, not default config.

## Review Notes

A read-only subagent rejected the first plan draft for these reasons:

- scope was too large
- `SourceRef` risked creating another provenance dialect
- cursor commit semantics were underspecified
- vNext bootstrap did not account for legacy side effects
- worker authority was too vague
- dashboard plan duplicated existing projection work
- wiki changes risked deepening `gateway-tool-executor.ts`
- missing regression tests
- parallelization was unrealistic

Second review rejected the first tracked `main`-based version for these additional
issues:

- migration `061` was invalid on `origin/main`; current next migration is `038`
- DB contracts were not exact enough
- connector polling could still write and advance file poll-state before the vNext
  operator commit exists; PR 1 now disables it completely and defers raw-index-only
  ingestion to PR 2
- startup side effects needed an allowlist, not a denylist
- several paths existed only on the investigation branch, not on `origin/main`
- legacy memory provenance strings need compatibility tests

Those issues are incorporated above.

Final blocker-only review result:

- Status: `APPROVE`
- Findings: no remaining P0/P1 blockers
- First implementation target: PR 0, contracts and compatibility

This tracked plan is the corrected version. Start with PR 0.
