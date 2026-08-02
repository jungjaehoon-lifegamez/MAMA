# Report Carry V2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver the latest successful full report to exactly one intended Telegram owner turn,
acknowledge it only after durable assistant-session persistence, and never revive or repeatedly
inject it across retries or restarts.

**Architecture:** A versioned file store owns target-scoped peek/ack CAS and same-delivery-ID
idempotency. Full-report composition captures provenance into the TG-06 pending outbox; successful
Telegram delivery persists a v2 carry for the configured report chat. MessageRouter injects the
peeked prefix only on verified Telegram owner turns and acknowledges the captured delivery ID after
final session persistence.

**Tech Stack:** TypeScript, atomic JSON file stores, Telegram delivery queue, MessageRouter,
Vitest single-fork.

## Global Constraints

- TG-01 per-chat FIFO and external-report ordering remain unchanged.
- TG-05 continuation receives carry through the per-turn user message only; no system prompt is
  re-injected into an existing backend session.
- TG-06 exact pending text, delivery ID, deduplication, restart replay, and success-only schedule
  advancement remain authoritative.
- Carry is persisted only after Telegram send success.
- Digest reports never create carry.
- A failed model turn or failed final session persistence never consumes carry.
- A same-ID replay preserves original timestamp and consumed state; it never revives carry.
- A new delivery ID may replace current carry; old-turn acknowledgement must not consume the new ID.
- Legacy unscoped carry is diagnostic-only and never injectable.
- Derived carry write/ack failure is loud but does not retract an already delivered report or fail a
  completed owner turn.
- No `any`, silent fallback data, or placeholders; Vitest remains single-fork.

---

## File Structure

- Replace `packages/standalone/src/operator/report-carry.ts` with a v2 `FileReportCarryStore`.
- Modify `packages/standalone/src/operator/situation-report.ts`: capture/deliver full-report
  provenance and delivery metadata.
- Modify `packages/standalone/src/operator/pending-report-store.ts`: durable optional provenance
  with legacy recovery.
- Modify `packages/standalone/src/operator/operator-trigger-loop.ts`: pending delivery round-trip.
- Modify `packages/standalone/src/cli/commands/start.ts`: exact target and provenance wiring.
- Modify `packages/standalone/src/gateways/message-router.ts` and gateway config types: injected
  `ReportCarryPort`, exact target peek, success-bound ack.
- Expand report, trigger-loop, router, and Telegram TG tests.

### Task 1: Versioned chat-scoped file store

**Files:**

- Modify: `packages/standalone/src/operator/report-carry.ts`
- Modify: `packages/standalone/tests/operator/report-carry.test.ts`

**Interfaces:**

```ts
export interface ReportCarryTarget {
  source: 'telegram';
  channelId: string;
}

export interface ReportCarryV2 {
  version: 2;
  deliveryId: string;
  target: ReportCarryTarget;
  deliveredAt: string;
  text: string;
  provenance: ArtifactProvenance;
  consumedAt?: string;
  consumingChannelKey?: string;
}

export interface ReportCarryPeek {
  deliveryId: string;
  prefix: string;
}

export interface PersistDeliveredInput {
  deliveryId: string;
  target: ReportCarryTarget;
  deliveredAt: string;
  text: string;
  provenance: ArtifactProvenance;
}

export interface AckInput {
  deliveryId: string;
  target: ReportCarryTarget;
  consumingChannelKey: string;
  consumedAtIso: string;
}

export interface ReportCarryPort {
  peek(target: ReportCarryTarget, nowMs?: number): ReportCarryPeek | null;
  acknowledge(input: AckInput): boolean;
}

export class FileReportCarryStore implements ReportCarryPort {
  constructor(path?: string);
  persistDelivered(input: PersistDeliveredInput): void;
  peek(target: ReportCarryTarget, nowMs?: number): ReportCarryPeek | null;
  acknowledge(input: AckInput): boolean;
}
```

- [ ] **Step 1: Replace current tests with failing v2 behavior tests**

```ts
it('peeks once for the exact unexpired Telegram chat and then acknowledges it', () => {
  const path = tempCarryPath();
  const store = new FileReportCarryStore(path);
  const deliveredAt = '2026-08-02T00:00:00.000Z';
  const target = { source: 'telegram', channelId: 'C1' } as const;
  store.persistDelivered({
    deliveryId: 'd1',
    target,
    deliveredAt,
    text: 'owner report',
    provenance: { status: 'available', modelRunId: 'mr_1' },
  });
  expect(store.peek({ source: 'telegram', channelId: 'C2' }, Date.parse(deliveredAt))).toBeNull();
  expect(store.peek(target, Date.parse(deliveredAt))?.deliveryId).toBe('d1');
  expect(
    store.acknowledge({
      deliveryId: 'd1',
      target,
      consumingChannelKey: 'telegram:C1',
      consumedAtIso: '2026-08-02T00:01:00.000Z',
    })
  ).toBe(true);
  expect(store.peek(target, Date.parse(deliveredAt))).toBeNull();
});

it('does not revive a consumed carry when the same delivery is replayed', () => {
  const path = tempCarryPath();
  const store = new FileReportCarryStore(path);
  const input: PersistDeliveredInput = {
    deliveryId: 'd1',
    target: { source: 'telegram', channelId: 'C1' },
    deliveredAt: '2026-08-02T00:00:00.000Z',
    text: 'owner report',
    provenance: { status: 'available', modelRunId: 'mr_1' },
  };
  store.persistDelivered(input);
  store.acknowledge({
    deliveryId: input.deliveryId,
    target: input.target,
    consumingChannelKey: 'telegram:C1',
    consumedAtIso: '2026-08-02T00:01:00.000Z',
  });
  store.persistDelivered({ ...input, deliveredAt: '2026-08-02T00:05:00.000Z' });
  expect(store.peek(input.target, Date.parse(input.deliveredAt))).toBeNull();
  expect(JSON.parse(readFileSync(path, 'utf8')).deliveredAt).toBe(input.deliveredAt);
});
```

Add cases for 24-hour inclusive boundary and expiry, wrong source/chat, malformed/corrupt JSON,
legacy unscoped record, closed provenance reasons, capped untrusted prefix, new-ID replacement,
failed old-ID CAS, and temporary filename uniqueness. For a same-ID content, target, or provenance
mismatch, assert that `persistDelivered()` throws and the pre-existing file remains byte-for-byte
unchanged. A same-ID replay with those fields equal ignores the callback's newer `deliveredAt` and
preserves the first stored timestamp and consumed state. Delivery callers cannot set `consumedAt`
or `consumingChannelKey` because those fields do not exist on `PersistDeliveredInput`.

- [ ] **Step 2: Run the store test and verify the current global carry fails**

```bash
pnpm --dir packages/standalone exec vitest run tests/operator/report-carry.test.ts
```

- [ ] **Step 3: Implement strict parsing, atomic writes, idempotent persist, peek, and ack**

Use a UUID in the `0600` temporary filename. Validate `ArtifactProvenance` against exactly
`no_run_handle | commit_failed | legacy_record`. `peek()` requires version 2, exact target,
unconsumed state, a valid delivered ISO time, and age in `[0, 24h]`. `acknowledge()` rereads current
state and compare-and-sets delivery ID plus target before atomic rewrite. Keep consumed/expired state
on disk.

- [ ] **Step 4: Run the store suite, typecheck, and commit**

```bash
pnpm --dir packages/standalone exec vitest run tests/operator/report-carry.test.ts
pnpm --dir packages/standalone typecheck
git add packages/standalone/src/operator/report-carry.ts \
  packages/standalone/tests/operator/report-carry.test.ts
git commit -m "fix(standalone): make report carry one shot"
```

### Task 2: Preserve full-report provenance in the TG-06 pending outbox

**Files:**

- Modify: `packages/standalone/src/operator/situation-report.ts`
- Modify: `packages/standalone/src/operator/pending-report-store.ts`
- Modify: `packages/standalone/src/operator/operator-trigger-loop.ts`
- Modify: `packages/standalone/src/operator/report-run.ts`
- Test: `packages/standalone/tests/operator/situation-report.test.ts`
- Test: `packages/standalone/tests/operator/pending-report-store.test.ts`
- Test: `packages/standalone/tests/operator/operator-trigger-loop.test.ts`

**Interfaces:**

```ts
export interface DeliveredFullReport {
  deliveryId: string;
  deliveredAtIso: string;
  text: string;
  provenance: ArtifactProvenance;
}

export interface PreparedSituationReport {
  mode: ReportMode;
  text: string;
  citedTriggerIds: string[];
  createdAtIso: string;
  deliveryId?: string;
  provenance?: ArtifactProvenance;
}

export interface SituationReporterOptions {
  fullReportProvenance?: () => ArtifactProvenance;
  persistLastFullReport?: (report: DeliveredFullReport) => void;
}
```

- [ ] **Step 1: Add failing delivery-boundary tests**

Assert send rejection calls carry persistence zero times; successful full send calls once with exact
text, ID, and captured provenance; digest calls zero times; missing full delivery ID warns and does
not create carry; persistence error warns but delivery resolves.

- [ ] **Step 2: Add failing pending outbox provenance tests**

```ts
it('round-trips full report provenance across restart replay', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mama-report-buffer-'));
  const path = join(root, 'pending.json');
  const store = new FilePendingReportStore(path);
  const snapshot = new SituationReporter().snapshot();
  const provenance = { status: 'available', modelRunId: 'mr_1' } as const;
  store.save({
    version: 1,
    digest: snapshot,
    full: snapshot,
    delivery: {
      mode: 'full',
      text: 'owner report',
      citedTriggerIds: [],
      createdAtIso: '2026-08-02T00:00:00.000Z',
      deliveryId: 'd1',
      provenance,
      occurrence: {
        kind: 'scheduled_full',
        hourKey: '2026-08-02:09',
        firedAtIso: '2026-08-02T00:00:00.000Z',
      },
    },
  });
  expect(store.load()?.delivery?.provenance).toEqual(provenance);
});

it('labels legacy pending full deliveries without provenance', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mama-report-buffer-'));
  const path = join(root, 'pending.json');
  const store = new FilePendingReportStore(path);
  const snapshot = new SituationReporter().snapshot();
  await writeFile(
    path,
    JSON.stringify({
      version: 1,
      digest: snapshot,
      full: snapshot,
      delivery: {
        mode: 'full',
        text: 'legacy owner report',
        citedTriggerIds: [],
        createdAtIso: '2026-08-02T00:00:00.000Z',
        deliveryId: 'legacy-d1',
        occurrence: { kind: 'scheduled_full', hourKey: '2026-08-02:09' },
      },
    })
  );
  expect(store.load()?.delivery?.provenance).toEqual({
    status: 'unavailable',
    reason: 'legacy_record',
  });
});
```

Reject malformed provenance instead of silently inventing a run handle.

- [ ] **Step 3: Run the focused report/outbox tests and observe provenance loss**

```bash
pnpm --dir packages/standalone exec vitest run \
  tests/operator/situation-report.test.ts \
  tests/operator/pending-report-store.test.ts \
  tests/operator/operator-trigger-loop.test.ts
```

- [ ] **Step 4: Capture provenance at composition and persist it with pending delivery**

`prepareReport(full)` reads the provider immediately after the composing run and places provenance
on `PreparedSituationReport`. `OperatorTriggerLoop` stores that field in the pending occurrence and
rehydrates it on replay. `deliverPrepared()` calls carry persistence only after successful send,
using the prepared provenance rather than a process-local last-run variable.

- [ ] **Step 5: Run TG-06 report tests and commit**

```bash
pnpm --dir packages/standalone exec vitest run \
  tests/operator/situation-report.test.ts \
  tests/operator/pending-report-store.test.ts \
  tests/operator/operator-trigger-loop.test.ts
git add packages/standalone/src/operator/situation-report.ts \
  packages/standalone/src/operator/pending-report-store.ts \
  packages/standalone/src/operator/operator-trigger-loop.ts \
  packages/standalone/src/operator/report-run.ts \
  packages/standalone/tests/operator/situation-report.test.ts \
  packages/standalone/tests/operator/pending-report-store.test.ts \
  packages/standalone/tests/operator/operator-trigger-loop.test.ts
git commit -m "fix(standalone): persist report run provenance"
```

### Task 3: Wire exact Telegram target at successful delivery

**Files:**

- Modify: `packages/standalone/src/cli/commands/start.ts`
- Test: `packages/standalone/tests/cli/lane-wiring.test.ts`
- Test: `packages/standalone/tests/operator/operator-trigger-loop.test.ts`
- Test: `packages/standalone/tests/gateways/telegram.test.ts`

**Interfaces:**

- Consumes: `reportChatId`, `PreparedSituationReport.deliveryId`, persisted provenance.
- Produces: `FileReportCarryStore.persistDelivered({ deliveryId, deliveredAt, text, provenance,
target: { source: 'telegram', channelId: reportChatId } })`.

- [ ] **Step 1: Add failing lane-wiring and exact-ID tests**

Assert scheduled and on-demand full reports use the same policy, pending store, Telegram chat,
delivery ID, provenance, and carry store. Extend TG-01 Telegram tests to prove report sends retain
the exact delivery ID while staying behind an active same-chat turn.

- [ ] **Step 2: Run the lane/Telegram tests**

```bash
pnpm --dir packages/standalone exec vitest run \
  tests/cli/lane-wiring.test.ts \
  tests/operator/operator-trigger-loop.test.ts \
  tests/gateways/telegram.test.ts
```

- [ ] **Step 3: Replace process-local delivery provenance with prepared delivery metadata**

Keep the composition callback only as the provider used by `prepareReport`. At delivery, pass the
prepared report object into `FileReportCarryStore` with `reportChatId`. If the same TG-06 delivery
is replayed after acknowledgement, store idempotency preserves consumed state.

- [ ] **Step 4: Re-run tests and commit**

```bash
pnpm --dir packages/standalone exec vitest run \
  tests/cli/lane-wiring.test.ts \
  tests/operator/operator-trigger-loop.test.ts \
  tests/gateways/telegram.test.ts
git add packages/standalone/src/cli/commands/start.ts \
  packages/standalone/tests/cli/lane-wiring.test.ts \
  packages/standalone/tests/operator/operator-trigger-loop.test.ts \
  packages/standalone/tests/gateways/telegram.test.ts
git commit -m "fix(standalone): scope report carry delivery"
```

### Task 4: Peek/ack at the Telegram owner turn success boundary

**Files:**

- Modify: `packages/standalone/src/gateways/message-router.ts`
- Modify: `packages/standalone/tests/gateways/message-router.test.ts`
- Modify: `packages/standalone/tests/gateways/message-router-turn-save.test.ts`

**Interfaces:**

- Extend the private-isolation plan's existing `MessageRouterDependencies` contract in
  `message-router.ts` with `reportCarry`; it remains deliberately separate from behavioral
  `MessageRouterConfig`:

```ts
export interface MessageRouterDependencies {
  privateConnectorPolicy?: PrivateConnectorPolicy;
  reportCarry?: ReportCarryPort;
}
```

Production supplies `new FileReportCarryStore()` through the already-established seventh
constructor argument. Tests inject a temp-path `FileReportCarryStore`; no `MessageRouterConfig`
field is added.

- The turn-local `ReportCarryPeek` is captured before the agent call and acknowledged after final
  assistant session persistence.

- [ ] **Step 1: Add failing router one-shot tests**

```ts
it('injects one owner user-prefix and acknowledges after final persistence', async () => {
  const carryPath = join(testMamaHome, 'operator', 'carry.json');
  const carry = new FileReportCarryStore(carryPath);
  const target = { source: 'telegram', channelId: 'C1' } as const;
  const deliveredAt = new Date().toISOString();
  carry.persistDelivered({
    deliveryId: 'd1',
    target,
    deliveredAt,
    text: 'owner report',
    provenance: { status: 'available', modelRunId: 'mr_1' },
  });
  const runs: string[] = [];
  const agentLoop = createMockAgentLoop((prompt) => {
    runs.push(prompt);
    return 'owner response';
  });
  resetRoleManager();
  getRoleManager().setTelegramTrust(['C1']);
  const router = new MessageRouter(
    sessionStore,
    agentLoop,
    createMockMamaApi(mockDecisions),
    {},
    undefined,
    undefined,
    { reportCarry: carry }
  );
  try {
    await router.process({
      source: 'telegram',
      channelId: 'C1',
      userId: 'owner',
      text: 'first',
      metadata: { chatType: 'private' },
    });
    await router.process({
      source: 'telegram',
      channelId: 'C1',
      userId: 'owner',
      text: 'second',
      metadata: { chatType: 'private' },
    });
    expect(runs[0]).toContain('operator-report-carry');
    expect(runs[1]).not.toContain('operator-report-carry');
    expect(carry.peek(target)).toBeNull();
  } finally {
    resetRoleManager();
  }
});
```

Add model failure and final session persistence failure → next turn reinjects; cover both thrown
persistence errors and the exact `flushStreamingResponse() === false` plus
`appendMessage() === false` result. Wrong chat/source/unverified Telegram does not peek or consume;
concurrent report B survives old A acknowledgement; multimodal and text paths share the prefix;
acknowledgement error logs but does not fail turn.

- [ ] **Step 2: Add explicit TG-05 continuation assertions**

First and continued owner turns may each have user text, but the continued run keeps
`resumeSession: true`, receives no rebuilt full system prompt, and sees carry at most once. A policy
fingerprint change remains the only connector-policy re-anchor mechanism.

- [ ] **Step 3: Run router tests and verify repeated global prefix failure**

```bash
pnpm --dir packages/standalone exec vitest run \
  tests/gateways/message-router.test.ts \
  tests/gateways/message-router-turn-save.test.ts
```

- [ ] **Step 4: Implement exact-target peek and success-bound CAS ack**

Only `agentContext.roleName === 'owner_console' && message.source === 'telegram'` peeks
`{ source: 'telegram', channelId: message.channelId }`. Use `peek.prefix` in both existing
effective-message paths. Set
`persisted = sessionStore.flushStreamingResponse(session.id, response) ||
sessionStore.appendMessage(session.id, assistantMessage)`. If both return `false`, throw a bounded
session-persistence error and leave carry unconsumed. Only when `persisted === true` call
`acknowledge` with the captured ID and `buildChannelKey`; catch and warn on ack failure. Do not ack
from the model-run catch or any earlier persistence path.

- [ ] **Step 5: Run router suites, typecheck, and commit**

```bash
pnpm --dir packages/standalone exec vitest run \
  tests/gateways/message-router.test.ts \
  tests/gateways/message-router-turn-save.test.ts
pnpm --dir packages/standalone typecheck
git add packages/standalone/src/gateways/message-router.ts \
  packages/standalone/tests/gateways/message-router.test.ts \
  packages/standalone/tests/gateways/message-router-turn-save.test.ts
git commit -m "fix(standalone): acknowledge report carry after owner turn"
```

### Task 5: Report-carry TG checkpoint

**Files:**

- Test: report carry, report delivery, pending outbox, router, and Telegram suites.

- [ ] **Step 1: Run the complete carry/TG suite**

```bash
pnpm --dir packages/standalone exec vitest run \
  tests/operator/report-carry.test.ts \
  tests/operator/situation-report.test.ts \
  tests/operator/pending-report-store.test.ts \
  tests/operator/operator-trigger-loop.test.ts \
  tests/cli/lane-wiring.test.ts \
  tests/gateways/message-router.test.ts \
  tests/gateways/message-router-turn-save.test.ts \
  tests/gateways/telegram.test.ts
pnpm --dir packages/standalone typecheck
```

- [ ] **Step 2: Inspect the stale-prefix implementation boundary**

```bash
rg -n "buildReportCarryPrefix|persistLastFullReport|last-full-report" \
  packages/standalone/src packages/standalone/tests
```

Expected: old global per-turn helpers are gone; only the v2 store and explicit injected port remain.
