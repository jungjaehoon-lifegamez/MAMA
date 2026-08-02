# External Lifecycle Reconciliation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert structured Kagemusha lifecycle observations into native task state only through
an exact receipted binding and candidate-bound apply/retain decision, with atomic effects and
receipt-authoritative crash recovery.

**Architecture:** Content-changing connector-event upserts receive both a new partition delivery
sequence and a connector-wide observation ordinal, and the reconcile publisher copies an immutable
observation snapshot into the durable board payload. The
operator DB owns exact pair bindings and decision receipts. Candidate tools recover identity from
the trusted work-order attempt ID; lifecycle apply reuses the canonical task transition primitive,
while completion, retry, and boot recovery arbitrate from durable receipt sets.

**Tech Stack:** TypeScript, SQLite/better-sqlite3, mama-core connector event index, standalone
TaskLedger, GatewayToolExecutor, Code-Act host bridge, Vitest single-fork.

## Global Constraints

- Cite and preserve TG-01, TG-05, and TG-06; ambiguous mutation outcomes are never replayed.
- `connector_event_index` content, metadata, and free-form delta prose are untrusted evidence.
- Candidate identity and fields are host-authored; tools accept only opaque candidate ID, decision,
  reason, and expected revision.
- An agent-authored `source_event_id` or broad batch `source_event_ids` can discover a binding
  candidate but cannot establish an exact pair without a separate committed `bind` receipt.
- A binding committed in an attempt cannot produce a lifecycle candidate until a later work order.
- Trello list names, disappearance, title similarity, prose, and elapsed time never map lifecycle.
- Candidate-target `task_update(status/latest_event)` must fail before mutation.
- Task mutation, temporal generation changes, effect attribution, and lifecycle receipt commit or
  roll back in one operator-DB transaction.
- The exact candidate event ID, not the broad batch, is recorded in `evidence_effects`.
- Do not edit `packages/mcp-server/`; the mama-core migration has no Claude-plugin duplicate.
- Node.js remains `>=22.13.0`; Vitest remains single-fork; no `any`, silent fallback, or placeholders.

---

## File Structure

- Create `packages/mama-core/db/migrations/062-refresh-connector-event-sequences.sql`: assign a
  fresh partition delivery sequence and connector-wide observation ordinal after content-changing
  stable-row updates.
- Modify `packages/mama-core/src/connectors/event-index.ts`: set `operator_ingest_seq` to `NULL`
  only when the authoritative observation changes so the migration trigger allocates new values.
- Modify `packages/mama-core/src/connectors/types.ts`: expose both non-null sequence fields on
  `ConnectorEventIndexRecord`.
- Modify `packages/mama-core/src/db-adapter/node-sqlite-adapter.ts`: recover partially applied or
  skipped migration 062, including every cursor/index/trigger.
- Create `packages/mama-core/tests/connectors/operator-ingest-seq-update.test.ts`: insert/update/
  identical-upsert behavior.
- Create `packages/standalone/src/operator/external-lifecycle.ts`: pure candidate, mapping, receipt,
  attempt-state types and invariant validators.
- Create `packages/standalone/src/operator/external-lifecycle-candidates.ts`: strict event lookup,
  immutable snapshot construction, and deterministic IDs.
- Create `packages/standalone/src/db/migrations/operator-task-external-lifecycle.ts`: bindings and
  receipt tables.
- Modify `packages/standalone/src/operator/task-ledger.ts`: binding/lifecycle transactions,
  canonical transition primitive, candidate attempt inspection, and generic-update guard.
- Modify `packages/standalone/src/operator/workorder-publishers.ts`: strict nested candidate payload.
- Modify `packages/standalone/src/cli/runtime/api-routes-init.ts`: candidate construction and board
  completion hook.
- Modify `packages/standalone/src/agent/types.ts`, `agent-loop.ts`,
  `gateway-tool-executor.ts`, `tool-registry.ts`, and `code-act/host-bridge.ts`: candidate tools and
  attempt-bound transport.
- Modify `packages/standalone/src/cli/commands/start.ts`: board tool policy and receipt arbitration
  wiring.
- Modify `packages/standalone/src/operator/workorder-consumer.ts`: live/boot receipt arbitration.
- Modify `packages/standalone/src/operator/briefs.ts`: binding/lifecycle candidate contract.
- Add focused tests under `packages/standalone/tests/operator`, `tests/agent`, `tests/code-act`,
  `tests/cli`, and mama-core connector tests.

### Task 1: Re-emit and globally order changed stable connector observations

**Files:**

- Create: `packages/mama-core/db/migrations/062-refresh-connector-event-sequences.sql`
- Modify: `packages/mama-core/src/connectors/event-index.ts`
- Modify: `packages/mama-core/src/connectors/types.ts`
- Modify: `packages/mama-core/src/db-adapter/node-sqlite-adapter.ts`
- Create: `packages/mama-core/tests/connectors/operator-ingest-seq-update.test.ts`
- Test: `packages/mama-core/tests/cases/migration-chain.test.ts`

**Interfaces:**

- Consumes: migration 039 cursor table and insert triggers.
- Produces: changed stable event rows receive a strictly newer per-partition
  `operator_ingest_seq` and connector-wide `operator_observation_seq`; byte-identical re-upserts
  retain both. The global ordinal, never a cross-channel comparison of partition sequences, orders
  lifecycle watermarks.

- [ ] **Step 1: Write the failing sequence tests**

```ts
it('allocates a new operator sequence only when the stable observation changes', () => {
  const adapter = getAdapter();
  const base = {
    source_connector: 'kagemusha',
    source_type: 'kanban_card',
    source_id: 'task:42',
    channel: 'room-a',
    content: 'status:pending',
    source_timestamp_ms: Date.parse('2026-08-02T00:00:00.000Z'),
    metadata: { taskId: 42, status: 'pending', rawConnector: 'kagemusha' },
  } as const;
  const first = upsertConnectorEventIndex(adapter, base);
  const identical = upsertConnectorEventIndex(adapter, base);
  const changed = upsertConnectorEventIndex(adapter, {
    ...base,
    content: 'status:done',
    metadata: { ...base.metadata, status: 'done' },
  });
  expect(identical.operator_ingest_seq).toBe(first.operator_ingest_seq);
  expect(identical.operator_observation_seq).toBe(first.operator_observation_seq);
  expect(changed.event_index_id).toBe(first.event_index_id);
  expect(changed.operator_ingest_seq).toBeGreaterThan(first.operator_ingest_seq);
  expect(changed.operator_observation_seq).toBeGreaterThan(first.operator_observation_seq);
});

it('orders an equal-timestamp channel move by the connector-wide ordinal', () => {
  const adapter = getAdapter();
  const first = upsertConnectorEventIndex(adapter, {
    source_connector: 'kagemusha',
    source_type: 'kanban_card',
    source_id: 'task:43',
    channel: 'room-a',
    content: 'status:pending',
    source_timestamp_ms: 1_775_260_800_000,
  });
  const moved = upsertConnectorEventIndex(adapter, {
    source_connector: 'kagemusha',
    source_type: 'kanban_card',
    source_id: 'task:43',
    channel: 'room-b',
    content: 'status:pending',
    source_timestamp_ms: 1_775_260_800_000,
  });
  expect(moved.operator_observation_seq).toBeGreaterThan(first.operator_observation_seq);
});
```

Also cover channel moves so a stale sequence cannot collide in the new partition.

- [ ] **Step 2: Run the connector and migration tests to verify failure**

```bash
pnpm --dir packages/mama-core exec vitest run \
  tests/connectors/operator-ingest-seq-update.test.ts \
  tests/cases/migration-chain.test.ts
```

- [ ] **Step 3: Add the update allocator trigger and conditional upsert reset**

The migration adds `operator_observation_seq`, backfills it deterministically per connector, creates
a connector-wide next-ordinal cursor, and installs insert/update allocators. The existing
partition allocator still uses `(source_connector, COALESCE(channel,''))`. In
`ON CONFLICT ... DO UPDATE`, set both sequence columns to `NULL` only when `content_hash`,
`metadata_json`, `source_timestamp_ms`, `source_type`, or channel identity differs; otherwise retain
both. Map the post-trigger non-null fields through `ConnectorEventIndexRecord`.

Use these exact migration objects and guards (the insert/update allocator bodies use the same
`INSERT OR IGNORE → assign current next_seq → increment cursor` transaction pattern as migration
039):

```sql
ALTER TABLE connector_event_index
  ADD COLUMN operator_observation_seq INTEGER CHECK (
    operator_observation_seq IS NULL OR operator_observation_seq >= 1
  );

CREATE TABLE connector_event_index_observation_cursors (
  source_connector TEXT PRIMARY KEY,
  next_seq INTEGER NOT NULL CHECK (next_seq >= 1)
);

WITH ranked AS (
  SELECT event_index_id,
         ROW_NUMBER() OVER (
           PARTITION BY source_connector
           ORDER BY source_timestamp_ms, rowid
         ) AS seq
  FROM connector_event_index
)
UPDATE connector_event_index
SET operator_observation_seq = (
  SELECT seq FROM ranked WHERE ranked.event_index_id = connector_event_index.event_index_id
);

INSERT INTO connector_event_index_observation_cursors (source_connector, next_seq)
SELECT source_connector, MAX(operator_observation_seq) + 1
FROM connector_event_index
GROUP BY source_connector;

CREATE UNIQUE INDEX idx_connector_event_index_observation_seq
  ON connector_event_index(source_connector, operator_observation_seq)
  WHERE operator_observation_seq IS NOT NULL;

CREATE TRIGGER trg_connector_event_index_operator_ingest_seq_au
AFTER UPDATE OF operator_ingest_seq ON connector_event_index
WHEN NEW.operator_ingest_seq IS NULL AND OLD.operator_ingest_seq IS NOT NULL
BEGIN
  INSERT OR IGNORE INTO connector_event_index_operator_seq_cursors
    (source_connector, channel, next_seq)
  VALUES (NEW.source_connector, COALESCE(NEW.channel, ''), 1);
  UPDATE connector_event_index
  SET operator_ingest_seq = (
    SELECT next_seq FROM connector_event_index_operator_seq_cursors
    WHERE source_connector = NEW.source_connector
      AND channel = COALESCE(NEW.channel, '')
  )
  WHERE event_index_id = NEW.event_index_id;
  UPDATE connector_event_index_operator_seq_cursors
  SET next_seq = next_seq + 1
  WHERE source_connector = NEW.source_connector
    AND channel = COALESCE(NEW.channel, '');
END;

CREATE TRIGGER trg_connector_event_index_observation_seq_ai
AFTER INSERT ON connector_event_index
WHEN NEW.operator_observation_seq IS NULL
BEGIN
  INSERT OR IGNORE INTO connector_event_index_observation_cursors
    (source_connector, next_seq)
  VALUES (NEW.source_connector, 1);
  UPDATE connector_event_index
  SET operator_observation_seq = (
    SELECT next_seq FROM connector_event_index_observation_cursors
    WHERE source_connector = NEW.source_connector
  )
  WHERE event_index_id = NEW.event_index_id;
  UPDATE connector_event_index_observation_cursors
  SET next_seq = next_seq + 1
  WHERE source_connector = NEW.source_connector;
END;

CREATE TRIGGER trg_connector_event_index_observation_seq_au
AFTER UPDATE OF operator_observation_seq ON connector_event_index
WHEN NEW.operator_observation_seq IS NULL AND OLD.operator_observation_seq IS NOT NULL
BEGIN
  INSERT OR IGNORE INTO connector_event_index_observation_cursors
    (source_connector, next_seq)
  VALUES (NEW.source_connector, 1);
  UPDATE connector_event_index
  SET operator_observation_seq = (
    SELECT next_seq FROM connector_event_index_observation_cursors
    WHERE source_connector = NEW.source_connector
  )
  WHERE event_index_id = NEW.event_index_id;
  UPDATE connector_event_index_observation_cursors
  SET next_seq = next_seq + 1
  WHERE source_connector = NEW.source_connector;
END;

INSERT INTO schema_version (version, description)
VALUES (62, 'Refresh connector event delivery and observation sequences');
```

Add the explicit-non-null insert cursor repair trigger so fixture/import rows cannot leave the
global cursor behind their assigned ordinal:

```sql
CREATE TRIGGER trg_connector_event_index_observation_seq_explicit_ai
AFTER INSERT ON connector_event_index
WHEN NEW.operator_observation_seq IS NOT NULL
BEGIN
  INSERT OR IGNORE INTO connector_event_index_observation_cursors
    (source_connector, next_seq)
  VALUES (NEW.source_connector, 1);
  UPDATE connector_event_index_observation_cursors
  SET next_seq = CASE
    WHEN next_seq <= NEW.operator_observation_seq THEN NEW.operator_observation_seq + 1
    ELSE next_seq
  END
  WHERE source_connector = NEW.source_connector;
END;
```

In `event-index.ts`, place these assignments at the end of the existing conflict update list (the
repeated predicate is intentional so the two allocators observe the same change boundary):

```sql
operator_ingest_seq = CASE
  WHEN connector_event_index.content_hash IS NOT excluded.content_hash
    OR connector_event_index.metadata_json IS NOT excluded.metadata_json
    OR connector_event_index.source_timestamp_ms IS NOT excluded.source_timestamp_ms
    OR connector_event_index.source_type IS NOT excluded.source_type
    OR connector_event_index.channel IS NOT excluded.channel
  THEN NULL
  ELSE connector_event_index.operator_ingest_seq
END,
operator_observation_seq = CASE
  WHEN connector_event_index.content_hash IS NOT excluded.content_hash
    OR connector_event_index.metadata_json IS NOT excluded.metadata_json
    OR connector_event_index.source_timestamp_ms IS NOT excluded.source_timestamp_ms
    OR connector_event_index.source_type IS NOT excluded.source_type
    OR connector_event_index.channel IS NOT excluded.channel
  THEN NULL
  ELSE connector_event_index.operator_observation_seq
END
```

Extend `repairSkippedFeatureMigrations()` with a migration-062 completeness predicate covering the
new column, cursor table, unique index, the partition update trigger, all three observation
allocator triggers, and schema version 62. `recoverConnectorEventSequencesMigration062()` performs
the exact guarded DDL/backfill shown above inside one adapter transaction and
`assertMigration062Complete()` checks every object before inserting the schema version. Add a
partial-migration test that pre-creates only `operator_observation_seq`; opening the adapter must
repair the rest without a duplicate-column error.

- [ ] **Step 4: Run mama-core tests and compatibility checks**

```bash
pnpm --dir packages/mama-core exec vitest run \
  tests/connectors/operator-ingest-seq-update.test.ts \
  tests/cases/migration-chain.test.ts \
  tests/cases/migration-runner-duplicate-column.test.ts \
  tests/connectors/raw-provenance.test.ts
pnpm --dir packages/mama-core typecheck
```

- [ ] **Step 5: Commit Task 1**

```bash
git add packages/mama-core/db/migrations/062-refresh-connector-event-sequences.sql \
  packages/mama-core/src/connectors/event-index.ts \
  packages/mama-core/src/connectors/types.ts \
  packages/mama-core/src/db-adapter/node-sqlite-adapter.ts \
  packages/mama-core/tests/connectors/operator-ingest-seq-update.test.ts \
  packages/mama-core/tests/cases/migration-chain.test.ts
git commit -m "fix(core): sequence updated connector observations"
```

### Task 2: Immutable candidate contracts and payload validation

**Files:**

- Create: `packages/standalone/src/operator/external-lifecycle.ts`
- Create: `packages/standalone/src/operator/external-lifecycle-candidates.ts`
- Modify: `packages/standalone/src/operator/workorder-publishers.ts`
- Create: `packages/standalone/tests/operator/external-lifecycle.test.ts`
- Test: `packages/standalone/tests/operator/workorder-publishers.test.ts`
- Test: `packages/standalone/tests/operator/connector-delta-repo.test.ts`

**Interfaces:**

```ts
export interface ExternalObservationSnapshot {
  eventId: string;
  connector: 'kagemusha';
  sourceType: 'kanban_card';
  externalSourceId: string;
  channelPartition: string;
  contentSha256: string;
  sourceTimestampMs: number;
  operatorIngestSeq: number;
  operatorObservationSeq: number;
  observedStatus: string;
  evidenceSummary: string;
}

export interface BindingCandidate extends ExternalObservationSnapshot {
  kind: 'binding';
  candidateId: string;
  taskId: number;
  taskRevision: number;
}

export interface LifecycleCandidate extends ExternalObservationSnapshot {
  kind: 'lifecycle';
  candidateId: string;
  bindingId: number;
  bindingRevision: number;
  taskId: number;
  taskRevision: number;
  proposedStatus: 'pending' | 'in_progress' | 'review' | 'done' | 'cancelled';
}

export interface ExternalLifecycleCandidateSet {
  bindingCandidates: readonly BindingCandidate[];
  lifecycleCandidates: readonly LifecycleCandidate[];
  diagnostics: readonly ExternalLifecycleDiagnostic[];
}

export type ExternalLifecycleDiagnosticCode =
  | 'missing_event'
  | 'unsupported_connector'
  | 'unsupported_source_type'
  | 'malformed_metadata'
  | 'unknown_status'
  | 'ambiguous_task_pair'
  | 'receipt_already_exists';

export interface ExternalLifecycleDiagnostic {
  eventId: string;
  code: ExternalLifecycleDiagnosticCode;
}

export interface TaskHintLookup {
  directTaskIdsByEventId: ReadonlyMap<string, readonly number[]>;
  effectTaskIdsByEventId: ReadonlyMap<string, readonly number[]>;
}

export interface CandidateTaskSnapshot {
  taskId: number;
  revision: number;
}

export interface ExistingExternalBindingSnapshot {
  bindingId: number;
  bindingRevision: number;
  taskId: number;
  externalSourceId: string;
  connector: 'kagemusha';
  sourceType: 'kanban_card';
  lastObservationSeq: number;
}

export interface BindingCandidateIdentityInput {
  kind: 'binding';
  eventId: string;
  externalSourceId: string;
  channelPartition: string;
  contentSha256: string;
  operatorObservationSeq: number;
  taskId: number;
  taskRevision: number;
}

export interface LifecycleCandidateIdentityInput extends Omit<
  BindingCandidateIdentityInput,
  'kind'
> {
  kind: 'lifecycle';
  bindingId: number;
  bindingRevision: number;
  proposedStatus: LifecycleCandidate['proposedStatus'];
}

export function externalLifecycleCandidateId(
  input: BindingCandidateIdentityInput | LifecycleCandidateIdentityInput
): string;

export function buildExternalLifecycleCandidateSet(input: {
  eventIds: readonly string[];
  observations: readonly ExternalObservationSnapshot[];
  taskHints: TaskHintLookup;
  tasksById: ReadonlyMap<number, CandidateTaskSnapshot>;
  bindings: readonly ExistingExternalBindingSnapshot[];
  receiptedCandidateIds: ReadonlySet<string>;
}): ExternalLifecycleCandidateSet;
```

- [ ] **Step 1: Write failing strict parsing, mapping, and deterministic-ID tests**

```ts
it.each([
  ['done', 'done'],
  ['completed', 'done'],
  ['cancelled', 'cancelled'],
  ['dismissed', 'cancelled'],
  ['review', 'review'],
])('maps Kagemusha %s to native %s', (external, native) => {
  expect(mapKagemushaLifecycle(external)).toBe(native);
});

it('rejects prose, Trello lists, malformed metadata, duplicate IDs, and unknown fields', () => {
  expect(() =>
    validateWorkOrderPayload('board', {
      mode: 'reconcile',
      channelKey: 'kagemusha:room-a',
      deltaLines: ['untrusted prose'],
      eventIds: ['evt_1'],
      candidates: {
        bindingCandidates: [],
        lifecycleCandidates: [],
        injected: true,
      },
    })
  ).toThrow(/unknown|candidate/i);
});

it('changes candidate identity when content hash or task revision changes', () => {
  const base: BindingCandidateIdentityInput = {
    kind: 'binding',
    eventId: 'evt_1',
    externalSourceId: 'task:42',
    channelPartition: 'room-a',
    contentSha256: 'a'.repeat(64),
    operatorObservationSeq: 7,
    taskId: 4,
    taskRevision: 7,
  };
  expect(externalLifecycleCandidateId(base)).not.toBe(
    externalLifecycleCandidateId({ ...base, contentSha256: 'b'.repeat(64) })
  );
  expect(externalLifecycleCandidateId(base)).not.toBe(
    externalLifecycleCandidateId({ ...base, taskRevision: 8 })
  );
});
```

Add one-to-one discovery tests with exact adjacency expectations: one event hinted by two tasks
produces no binding candidate; two events hinted by one task produce none; a direct hint to task A
plus an effect hint to task B produces none; exactly one event whose non-empty direct/effect sets
both resolve to the same single task produces one. A broad effect only discovers adjacency and
never overrides these uniqueness checks.

- [ ] **Step 2: Run tests to verify missing contracts fail**

```bash
pnpm --dir packages/standalone exec vitest run \
  tests/operator/external-lifecycle.test.ts \
  tests/operator/workorder-publishers.test.ts \
  tests/operator/connector-delta-repo.test.ts
```

- [ ] **Step 3: Implement bounded event lookup and immutable snapshots**

Query exact event IDs and include `source_connector`, `source_type`, `source_id`, `channel`,
`source_timestamp_ms`, `operator_ingest_seq`, `operator_observation_seq`, `metadata_json`, and hex
`content_hash`. Parse metadata as a strict plain object; accept only Kagemusha `kanban_card` rows
whose `taskId`, `status`, and `rawConnector` agree. Build `evidenceSummary` only as the fixed host
template `` `Kagemusha task ${taskId} reported ${status} at ${timestampIso}` `` after validating all
three interpolated values; never
copy title, content, metadata prose, or `deltaLines`. Hash canonical identity fields including the
global observation ordinal.

Look up task hints from exact `operator_tasks.source_event_id` equality and
`evidence_effects.source_event_ids` membership, then fetch `{ taskId, revision }` snapshots for the
bounded union of every hinted task ID and every existing binding task ID. Construct the bipartite
event↔task graph. Emit a
binding candidate only when both endpoint degrees are exactly one and any non-empty direct/effect
sets agree on that task. Existing exact bindings bypass hint discovery and produce lifecycle
candidates. A previously receipted candidate ID is diagnosed and suppressed.

Add a bound-only regression: a previously committed exact binding plus a newer observation and no
direct/effect hint still loads the bound task revision from `tasksById` and produces one lifecycle
candidate.

Malformed/missing/unsupported rows and unknown statuses append one bounded diagnostic and yield no
candidate for that event; they do not throw or prevent the ordinary reconcile payload from being
enqueued. Only a database read failure throws and leaves the scheduler batch unconsumed.

- [ ] **Step 4: Extend BoardPayload with recursive validation**

Allow candidates only for `mode: 'reconcile'`; require every candidate event ID in `eventIds`;
bound strings to 1-1000 characters; validate hashes, safe integers, enum values, exact keys, and
unique candidate IDs. Bound tool decision `reason` to 1-500 characters and require
`expected_revision` to be a positive safe integer. Manual `workorder_request` never accepts
candidate input because it constructs its own payload.

- [ ] **Step 5: Run focused tests, typecheck, and commit**

```bash
pnpm --dir packages/standalone exec vitest run \
  tests/operator/external-lifecycle.test.ts \
  tests/operator/workorder-publishers.test.ts \
  tests/operator/connector-delta-repo.test.ts
pnpm --dir packages/standalone typecheck
git add packages/standalone/src/operator/external-lifecycle.ts \
  packages/standalone/src/operator/external-lifecycle-candidates.ts \
  packages/standalone/src/operator/workorder-publishers.ts \
  packages/standalone/tests/operator/external-lifecycle.test.ts \
  packages/standalone/tests/operator/workorder-publishers.test.ts \
  packages/standalone/tests/operator/connector-delta-repo.test.ts
git commit -m "feat(standalone): define lifecycle candidates"
```

### Task 3: Binding tables and explicit exact-pair decisions

**Files:**

- Create: `packages/standalone/src/db/migrations/operator-task-external-lifecycle.ts`
- Modify: `packages/standalone/src/operator/task-ledger.ts`
- Create: `packages/standalone/tests/operator/external-lifecycle-binding-migration.test.ts`
- Create: `packages/standalone/tests/operator/external-lifecycle-reconcile.test.ts`
- Create: `packages/standalone/tests/operator/external-lifecycle-fixtures.ts`

**Interfaces:**

```ts
export interface ExternalTaskBinding {
  id: number;
  revision: number;
  taskId: number;
  connector: 'kagemusha';
  sourceType: 'kanban_card';
  externalSourceId: string;
  lastObservationSeq: number;
  createdByAttemptId: number;
}

export interface ExternalBindingReceipt {
  kind: 'binding';
  candidateId: string;
  workOrderAttemptId: number;
  taskId: number;
  outcome: 'bound' | 'declined' | 'superseded';
  reason: string;
  bindingId?: number;
}

export interface ExternalLifecycleReceipt {
  kind: 'lifecycle';
  candidateId: string;
  workOrderAttemptId: number;
  taskId: number;
  outcome: 'applied' | 'retained' | 'superseded';
  reason: string;
  taskRevisionBefore: number;
  taskRevisionAfter: number;
}

applyExternalBindingDecision(
  attemptId: number,
  input: {
    candidate_id: string;
    decision: 'bind' | 'decline';
    reason: string;
    expected_revision: number;
  },
  origin: ChangeOrigin
): ExternalBindingReceipt;

loadBoardCandidate(
  attemptId: number,
  candidateId: string,
  kind: 'binding' | 'lifecycle'
): BindingCandidate | LifecycleCandidate;

getExternalBinding(taskId: number): ExternalTaskBinding | null;
getExternalCandidateReceipt(
  candidateId: string
): ExternalBindingReceipt | ExternalLifecycleReceipt | null;

export interface SeededExternalLifecycleAttempt {
  db: SQLiteDatabase;
  ledger: TaskLedger;
  task: TaskRecord;
  attempt: WorkOrderRecord;
  candidate: BindingCandidate | LifecycleCandidate;
}

export function seedBindingCandidateAttempt(): SeededExternalLifecycleAttempt;
export function seedLifecycleCandidateAttempt(): SeededExternalLifecycleAttempt;
```

The fixture functions use a real in-memory `TaskLedger`. The lifecycle fixture first creates and
claims a binding attempt, commits `bind`, then enqueues and claims a later reconcile attempt whose
snapshot has a larger `operatorObservationSeq`; it never inserts receipt rows directly or mocks
TaskLedger internals.

- [ ] **Step 1: Write failing migration constraint tests**

Assert the three tables exist, decision checks reject unknown values, active task and active
`(connector,source_type,external_source_id)` uniqueness works both directions, and receipt identity
is globally unique by `candidate_id` independent of attempt ID.

- [ ] **Step 2: Write failing bind/decline/superseded/idempotency tests**

```ts
it('binds only the host candidate and receipt atomically', () => {
  const task = ledger.create({ title: 'native task' });
  const candidate: BindingCandidate = {
    kind: 'binding',
    candidateId: externalLifecycleCandidateId({
      kind: 'binding',
      eventId: 'evt_1',
      externalSourceId: 'task:42',
      channelPartition: 'room-a',
      contentSha256: 'a'.repeat(64),
      operatorObservationSeq: 9,
      taskId: task.id,
      taskRevision: task.revision,
    }),
    eventId: 'evt_1',
    connector: 'kagemusha',
    sourceType: 'kanban_card',
    externalSourceId: 'task:42',
    channelPartition: 'room-a',
    contentSha256: 'a'.repeat(64),
    sourceTimestampMs: Date.parse('2026-08-02T00:00:00.000Z'),
    operatorIngestSeq: 3,
    operatorObservationSeq: 9,
    observedStatus: 'pending',
    evidenceSummary: 'Kagemusha task 42 reported pending at 2026-08-02T00:00:00.000Z',
    taskId: task.id,
    taskRevision: task.revision,
  };
  const attempt = ledger.enqueueWorkOrder({
    workKind: 'board',
    idempotencyKey: 'binding-test-1',
    input: {
      mode: 'reconcile',
      channelKey: 'kagemusha:room-a',
      deltaLines: [],
      eventIds: [candidate.eventId],
      candidates: {
        bindingCandidates: [candidate],
        lifecycleCandidates: [],
        diagnostics: [],
      },
    },
  });
  expect(ledger.claimNextWorkOrder()?.id).toBe(attempt.id);
  const receipt = ledger.applyExternalBindingDecision(
    attempt.id,
    {
      candidate_id: candidate.candidateId,
      decision: 'bind',
      reason: 'exact task identity confirmed',
      expected_revision: candidate.taskRevision,
    },
    {
      runId: 'mr_1',
      workOrderAttemptId: attempt.id,
      causeEventIds: [candidate.eventId],
    }
  );
  expect(receipt.outcome).toBe('bound');
  expect(ledger.getExternalBinding(candidate.taskId)?.externalSourceId).toBe(
    candidate.externalSourceId
  );
});
```

Cover decline, stale revision → superseded, pair conflicts, transaction rollback, same-attempt and
cross-attempt idempotent replay, multi-event batch wrong-pair refusal, and no automatic legacy
backfill. A different decision or reason for an existing candidate fails loudly without changing
the original receipt.

- [ ] **Step 3: Run tests and verify the persistence API is absent**

```bash
pnpm --dir packages/standalone exec vitest run \
  tests/operator/external-lifecycle-binding-migration.test.ts \
  tests/operator/external-lifecycle-reconcile.test.ts
```

- [ ] **Step 4: Implement migration and binding transaction**

Call the migration inside `TaskLedger`'s existing migration transaction. Persist event hash,
source timestamp, partition delivery sequence, connector-wide observation ordinal, candidate ID,
exact pair, task revision, work-order attempt, outcome, reason, and created time. `bind` inserts
binding and receipt atomically and initializes the binding watermark
to `operatorObservationSeq`; `decline` inserts only the globally unique candidate receipt. Revision
drift inserts a `superseded` receipt and no binding. A repeated call in any attempt reads and
validates the existing candidate receipt instead of mutating again. Candidate construction
suppresses every already-receipted ID, so decline consumes that exact snapshot until changed input
produces a new candidate ID.

- [ ] **Step 5: Run tests and commit**

```bash
pnpm --dir packages/standalone exec vitest run \
  tests/operator/external-lifecycle-binding-migration.test.ts \
  tests/operator/external-lifecycle-reconcile.test.ts
git add packages/standalone/src/db/migrations/operator-task-external-lifecycle.ts \
  packages/standalone/src/operator/task-ledger.ts \
  packages/standalone/tests/operator/external-lifecycle-binding-migration.test.ts \
  packages/standalone/tests/operator/external-lifecycle-fixtures.ts \
  packages/standalone/tests/operator/external-lifecycle-reconcile.test.ts
git commit -m "feat(standalone): receipt external task bindings"
```

### Task 4: Canonical lifecycle transition and generic-update guard

**Files:**

- Modify: `packages/standalone/src/operator/task-ledger.ts`
- Modify: `packages/standalone/src/agent/gateway-tool-executor.ts`
- Test: `packages/standalone/tests/operator/external-lifecycle-reconcile.test.ts`
- Test: `packages/standalone/tests/operator/task-ledger-effects.test.ts`
- Test: `packages/standalone/tests/operator/temporal-generations.test.ts`

**Interfaces:**

```ts
applyExternalLifecycleDecision(
  attemptId: number,
  input: {
    candidate_id: string;
    decision: 'apply' | 'retain';
    reason: string;
    expected_revision: number;
  },
  origin: ChangeOrigin
): ExternalLifecycleReceipt;
```

Extend `ChangeOrigin` with host-only `workOrderAttemptId?: number` and pass it from the executor.

- [ ] **Step 1: Write failing transition-invariant tests**

Test apply, retain, stale superseded, idempotency, rollback, exact event attribution,
terminal→open epoch/reset/generation supersession, and open→terminal generation/workorder
supersession. Assert `apply` changes both status and host-built `latest_event` in one revision.

- [ ] **Step 2: Write failing generic bypass tests**

```ts
it.each(['status', 'latest_event'])('blocks candidate task_update(%s) before mutation', (field) => {
  const seeded = seedLifecycleCandidateAttempt();
  if (seeded.candidate.kind !== 'lifecycle') {
    throw new Error('fixture must produce a lifecycle candidate');
  }
  const { candidate, attempt, ledger } = seeded;
  const patch =
    field === 'status' ? { status: 'done' as const } : { latest_event: 'done externally' };
  expect(() =>
    ledger.update(candidate.taskId, patch, {
      workOrderAttemptId: attempt.id,
      causeEventIds: attempt.payload.eventIds,
    })
  ).toThrow(/candidate-bound lifecycle/);
  expect(ledger.getById(candidate.taskId)?.revision).toBe(candidate.taskRevision);
});
```

Also prove unrelated tasks and title/priority fields remain editable.

- [ ] **Step 3: Extract a transaction-scoped canonical task transition primitive**

Move validation, next-state calculation, revision CAS, `recordTaskChange`, and temporal generation
supersession from public `update()` into a private method that assumes an open transaction. Public
`update()` wraps it with `BEGIN/COMMIT`; lifecycle apply wraps the same primitive plus receipt and
binding watermark update in one transaction.

- [ ] **Step 4: Implement lifecycle receipts and watermark ordering**

Require a binding committed by an earlier work-order attempt. Refuse observation snapshots older
than or equal to the binding's connector-wide `lastObservationSeq` as superseded; never compare
per-channel `operatorIngestSeq` across partitions. `apply` and `retain` advance the binding watermark
to `candidate.operatorObservationSeq`, so retain consumes the exact observation without changing the
task. Attribute an applied effect to `[candidate.eventId]`. `retain` and `superseded` create receipts
without task effects. Add an equal-source-timestamp room-A→room-B test proving the newer global
ordinal applies, and an older payload cannot overwrite it afterward.

- [ ] **Step 5: Enforce generic update guard in TaskLedger and pass trusted attempt origin**

The TaskLedger queries its durable candidate payload using `workOrderAttemptId`; it rejects only
`status` or `latest_event` changes on candidate task IDs. This covers direct and nested executor
calls because both already propagate the attempt ID.

- [ ] **Step 6: Run invariant suites and commit**

```bash
pnpm --dir packages/standalone exec vitest run \
  tests/operator/external-lifecycle-reconcile.test.ts \
  tests/operator/task-ledger-effects.test.ts \
  tests/operator/temporal-generations.test.ts
git add packages/standalone/src/operator/task-ledger.ts \
  packages/standalone/src/agent/gateway-tool-executor.ts \
  packages/standalone/tests/operator/external-lifecycle-reconcile.test.ts \
  packages/standalone/tests/operator/task-ledger-effects.test.ts \
  packages/standalone/tests/operator/temporal-generations.test.ts
git commit -m "feat(standalone): apply receipted lifecycle transitions"
```

### Task 5: Candidate-bound tools and Code-Act transport

**Files:**

- Modify: `packages/standalone/src/agent/types.ts`
- Modify: `packages/standalone/src/agent/tool-registry.ts`
- Modify: `packages/standalone/src/agent/code-act/host-bridge.ts`
- Modify: `packages/standalone/src/agent/gateway-tool-executor.ts`
- Modify: `packages/standalone/src/cli/commands/start.ts`
- Test: `packages/standalone/tests/agent/gateway-tool-executor.test.ts`
- Test: `packages/standalone/tests/agent/tool-registry.test.ts`
- Test: `packages/standalone/tests/code-act/host-bridge.test.ts`
- Test: `packages/standalone/tests/operator/workorder-attempt-context.test.ts`
- Test: `packages/standalone/tests/cli/code-act-policy.test.ts`

**Interfaces:**

- New tool names: `task_external_bind`, `task_lifecycle_reconcile`.
- Both recover candidates through `executionState.workorderAttemptId`; no new model-supplied context.

- [ ] **Step 1: Add failing no-authority and exact-candidate tool tests**

```ts
const seeded = seedBindingCandidateAttempt();
const input = {
  candidate_id: seeded.candidate.candidateId,
  decision: 'bind' as const,
  reason: 'exact task identity confirmed',
  expected_revision: seeded.candidate.taskRevision,
};
await expect(executor.execute('task_external_bind', input)).rejects.toMatchObject({
  code: 'WORKORDER_SUPERSEDED',
});

const lifecycle = seedLifecycleCandidateAttempt();
const result = await executor.execute(
  'task_lifecycle_reconcile',
  {
    candidate_id: lifecycle.candidate.candidateId,
    decision: 'apply',
    reason: 'verified',
    expected_revision: lifecycle.candidate.taskRevision,
  },
  { executionSurface: 'model_tool', workorderAttemptId: lifecycle.attempt.id }
);
expect(result).toMatchObject({ success: true, receipt: { outcome: 'applied' } });
```

Assert raw `taskId`, `status`, `eventId`, and extra fields are rejected by schemas.

- [ ] **Step 2: Add nested Code-Act propagation tests**

Prove both tools appear only in the board workorder policy, are Tier-2 mutations, reach the inner
executor with the same `workorderAttemptId`, and fail closed when the run context is absent/stale.

- [ ] **Step 3: Implement registry, bridge definitions, and executor cases**

Add both tools to `WORKORDER_TOOL_POLICIES.board`, mutation classification, host definitions, and
executor dispatch. The executor passes trusted model run and exact candidate event origin to the
TaskLedger and serializes only bounded receipt fields.

- [ ] **Step 4: Generate tool documentation and run transport tests**

```bash
pnpm --dir packages/standalone build
pnpm --dir packages/standalone exec vitest run \
  tests/agent/gateway-tool-executor.test.ts \
  tests/agent/tool-registry.test.ts \
  tests/code-act/host-bridge.test.ts \
  tests/operator/workorder-attempt-context.test.ts \
  tests/cli/code-act-policy.test.ts
```

- [ ] **Step 5: Commit Task 5**

```bash
git add packages/standalone/src/agent/types.ts \
  packages/standalone/src/agent/tool-registry.ts \
  packages/standalone/src/agent/code-act/host-bridge.ts \
  packages/standalone/src/agent/gateway-tool-executor.ts \
  packages/standalone/src/agent/gateway-tools.md \
  packages/standalone/src/cli/commands/start.ts \
  packages/standalone/tests/agent/gateway-tool-executor.test.ts \
  packages/standalone/tests/agent/tool-registry.test.ts \
  packages/standalone/tests/code-act/host-bridge.test.ts \
  packages/standalone/tests/operator/workorder-attempt-context.test.ts \
  packages/standalone/tests/cli/code-act-policy.test.ts
git commit -m "feat(standalone): expose bound lifecycle tools"
```

### Task 6: Receipt-authoritative completion, retry, and boot recovery

**Files:**

- Modify: `packages/standalone/src/operator/workorder-consumer.ts`
- Modify: `packages/standalone/src/operator/workorder-hooks.ts`
- Modify: `packages/standalone/src/operator/task-ledger.ts`
- Modify: `packages/standalone/src/cli/runtime/api-routes-init.ts`
- Modify: `packages/standalone/tests/operator/external-lifecycle-fixtures.ts`
- Create: `packages/standalone/tests/operator/external-lifecycle-workorder-recovery.test.ts`
- Test: `packages/standalone/tests/operator/workorder-consumer.test.ts`
- Test: `packages/standalone/tests/operator/workorder-hooks.test.ts`

**Interfaces:**

```ts
export type BoardCandidateAttemptState =
  | { disposition: 'none' }
  | { disposition: 'complete'; outcomes: readonly string[] }
  | { disposition: 'partial'; missingCandidateIds: readonly string[] }
  | { disposition: 'zero' };

inspectBoardCandidateAttempt(attemptId: number): BoardCandidateAttemptState;

export interface SafeCandidateRetryEvidence {
  phase: 'before_runner_call';
  code: 'before_hook_failed' | 'run_options_failed';
}

export function createExternalLifecycleConsumer(
  ledger: TaskLedger,
  runner: WorkerRunner
): WorkOrderConsumer;
```

`SafeCandidateRetryEvidence` is minted directly by the consumer only in its two branches that fail
before invoking `runner.runWithContent()`. It is never derived from a caught error string or runner
result. Once `runWithContent()` is called, the current runner contract cannot prove whether a model
or nested tool started, so every rejection/result failure lacks retry authority. A generic runner
error, required verdict failure, missing/unknown mutation result, partial receipt set, or boot-time
stale zero-receipt claim therefore cannot replay.

- [ ] **Step 1: Write failing live arbitration tests**

Cover complete receipts plus lost runner result → done without replay; partial receipts → loud fail
without replay; zero receipts with each exact `SafeCandidateRetryEvidence` value → one bounded
candidate-only retry; and zero receipts after any `runWithContent()` entry, required-verdict failure,
`MCP_RESULT_MISSING`, interrupted mutation, generic runner error, or unknown mutation → no replay.
Assert a caller cannot construct retry authority from a free-form error code or runner rejection.

- [ ] **Step 2: Write failing boot recovery tests**

```ts
it('completes a stale board claim from a full receipt set without replay', () => {
  const seeded = seedLifecycleCandidateAttempt();
  if (seeded.candidate.kind !== 'lifecycle') {
    throw new Error('fixture must produce a lifecycle candidate');
  }
  seeded.ledger.applyExternalLifecycleDecision(
    seeded.attempt.id,
    {
      candidate_id: seeded.candidate.candidateId,
      decision: 'apply',
      reason: 'verified before crash',
      expected_revision: seeded.candidate.taskRevision,
    },
    {
      runId: 'mr_before_crash',
      workOrderAttemptId: seeded.attempt.id,
      causeEventIds: [seeded.candidate.eventId],
    }
  );
  let runs = 0;
  const consumer = createExternalLifecycleConsumer(seeded.ledger, {
    runWithContent: async () => {
      runs++;
      return { response: 'must not run' };
    },
  });
  consumer.bootRecover();
  expect(
    seeded.db.prepare('SELECT status FROM operator_tasks WHERE id = ?').get(seeded.attempt.id)
  ).toEqual({ status: 'done' });
  expect(runs).toBe(0);
});
```

Also cover partial and zero stale claims plus receipt DB read failure. A read failure must establish
an unresolved-effect claim barrier before new work is claimed. Boot stale plus zero receipts always
fails without retry because no live `SafeCandidateRetryEvidence` survives a crash.

- [ ] **Step 3: Implement board candidate arbitration**

Route candidate-bearing errors, transport responses, required-verdict failures, normal completion,
and stale claims through one method analogous to temporal arbitration. Complete receipts win;
partial never retries. Zero retries only when the live caller supplies a structurally valid
`SafeCandidateRetryEvidence` minted in the consumer's before-hook/run-options branches before the
runner call; absence or any unrecognized phase/code defaults to no replay. Keep
ordinary board max attempts at one and mint at most one candidate-only replacement. Never reconstruct
retry authority at boot from an error string.

- [ ] **Step 4: Make the board hook verdict-required without changing ordinary semantics**

Full and no-candidate reconcile paths return `{ disposition: 'complete' }`. Candidate reconciles
return complete only for a valid full receipt set. Existing action-verifier `unverified` telemetry
remains observable but does not override a valid receipt result.

- [ ] **Step 5: Run recovery suites and commit**

```bash
pnpm --dir packages/standalone exec vitest run \
  tests/operator/external-lifecycle-workorder-recovery.test.ts \
  tests/operator/workorder-consumer.test.ts \
  tests/operator/workorder-hooks.test.ts
git add packages/standalone/src/operator/workorder-consumer.ts \
  packages/standalone/src/operator/workorder-hooks.ts \
  packages/standalone/src/operator/task-ledger.ts \
  packages/standalone/src/cli/runtime/api-routes-init.ts \
  packages/standalone/tests/operator/external-lifecycle-fixtures.ts \
  packages/standalone/tests/operator/external-lifecycle-workorder-recovery.test.ts \
  packages/standalone/tests/operator/workorder-consumer.test.ts \
  packages/standalone/tests/operator/workorder-hooks.test.ts
git commit -m "fix(standalone): arbitrate board candidate receipts"
```

### Task 7: Reconcile publisher and worker contract integration

**Files:**

- Modify: `packages/standalone/src/cli/runtime/api-routes-init.ts`
- Modify: `packages/standalone/src/cli/commands/start.ts`
- Modify: `packages/standalone/src/operator/briefs.ts`
- Modify: `packages/standalone/src/operator/worker-run.ts`
- Modify: `packages/standalone/src/multi-agent/dashboard-agent-persona.ts`
- Test: `packages/standalone/tests/operator/external-lifecycle-reconcile.test.ts`
- Test: `packages/standalone/tests/operator/briefs.test.ts`
- Test: `packages/standalone/tests/operator/workorder-attempt-context.test.ts`

- [ ] **Step 1: Add failing end-to-end publisher tests**

Feed exact event-index rows and task/effect state into the scheduler callback. Assert the enqueued
payload carries the immutable candidate snapshot, unknown statuses produce no candidate, Trello
produces no lifecycle candidate, previously committed bind produces lifecycle only on a later
attempt, and malformed/unsupported individual events produce bounded diagnostics while the ordinary
reconcile still enqueues. Assert only a database read failure aborts enqueue and leaves the scheduler
batch unconsumed.

- [ ] **Step 2: Add failing worker-contract tests**

Assert a candidate-bearing reconcile brief names every candidate and requires exactly one bound
tool decision per candidate, prohibits generic lifecycle update, retains agent choice of
bind/decline/apply/retain, and keeps ordinary no-candidate reconcile behavior unchanged.

- [ ] **Step 3: Wire candidate construction at reconcile enqueue**

Use `getAdapter()` for the exact event snapshot and TaskLedger for eligible task hints/bindings.
Run the Task 2 one-to-one adjacency algorithm and persist candidates plus bounded diagnostics inside
the validated board payload before enqueue. Per-event validation failures remain non-authoritative
context and do not poison the batch; DB availability failures throw. The worker continues to
receive human-readable `deltaLines` as context, but only the structural candidates authorize the
new tools.

- [ ] **Step 4: Run the lifecycle integration suite and commit**

```bash
pnpm --dir packages/standalone exec vitest run \
  tests/operator/external-lifecycle.test.ts \
  tests/operator/external-lifecycle-reconcile.test.ts \
  tests/operator/external-lifecycle-workorder-recovery.test.ts \
  tests/operator/workorder-publishers.test.ts \
  tests/operator/briefs.test.ts \
  tests/operator/workorder-attempt-context.test.ts \
  tests/connectors/kagemusha.test.ts \
  tests/connectors/raw-store-unified-index.test.ts
pnpm --dir packages/standalone typecheck
git add packages/standalone/src/cli/runtime/api-routes-init.ts \
  packages/standalone/src/cli/commands/start.ts \
  packages/standalone/src/operator/briefs.ts \
  packages/standalone/src/operator/worker-run.ts \
  packages/standalone/src/multi-agent/dashboard-agent-persona.ts \
  packages/standalone/tests/operator/external-lifecycle.test.ts \
  packages/standalone/tests/operator/external-lifecycle-reconcile.test.ts \
  packages/standalone/tests/operator/external-lifecycle-workorder-recovery.test.ts \
  packages/standalone/tests/operator/workorder-publishers.test.ts \
  packages/standalone/tests/operator/briefs.test.ts \
  packages/standalone/tests/operator/workorder-attempt-context.test.ts \
  packages/standalone/tests/connectors/kagemusha.test.ts \
  packages/standalone/tests/connectors/raw-store-unified-index.test.ts
git commit -m "feat(standalone): reconcile external lifecycle evidence"
```
