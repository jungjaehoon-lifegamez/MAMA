# Runtime overhead remediation PR-B: Telegram exact receipt implementation plan

> Status: implemented and merged as PR #235; v0.39.1 release/cutover pending.
>
> Scope: TG-01/TG-03/TG-04/TG-06 owner-event Telegram delivery only. This PR does not add a
> ledger, schema, service, worker, timer, queue, file snapshot, or second payload hash.

## Goal

Make a real owner-event Telegram send locally inspectable from the exact validated payload through
the already-existing Telegram delivery ledger, without changing Telegram's delivery semantics or
adding model work.

The production path must preserve the idempotency key instead of dropping it at gateway wiring.
That is required for the receipt contract to work outside tests.

## What already exists

- `OwnerEventEffectLedger` already reserves one host-issued effect before transmission, blocks
  replay after an unknown outcome, confirms completed effects, and deletes them with inbox
  retention.
- `TelegramGateway` already derives one delivery-ledger key from `{transport variant, deliveryId}`,
  binds the target and payload identity, tracks every text chunk, and marks `delivered` only after
  the final Telegram call returns.
- `GatewayToolExecutor` already validates owner-event authority, derives a stable delivery ID,
  resolves private-workspace files, distinguishes definite photo rejection from ambiguous failure,
  and owns image-to-file fallback.
- `initGateways` already creates one adapter shared by the tool executor and agent loop, but that
  adapter currently drops the optional idempotency key and the active-turn methods.

These existing boundaries are sufficient. PR-B connects them; it does not build parallel ones.

## Selected data flow

```text
telegram_send input
  |
  +-- normalize once
  |     text: exact Unicode body, non-blank
  |     file/image: existing regular-file + private-workspace resolution
  |     sticker: normalized emotion
  |
  +-- persist exact V1 owner-event intent before send
  |     {chatId, requestedVariant, body/caption, resolved path/emotion, deliveryId}
  |
  +-- existing TelegramGateway
  |     adapter forwards deliveryId and active-turn method
  |     existing TelegramMessageLedger binds target + payloadIdentity
  |     image definite rejection may deliver through existing file fallback
  |
  +-- read the existing delivered row by {deliveryId, actualVariant}
        |
        +-- valid delivered row -> confirm V1 effect receipt
        +-- missing/malformed row -> mark effect unknown, never resend automatically
```

## State contract

```text
no effect row
  -> begin(exact V1 intent) -> transmitting -> send
                                      |          |
                                      |          +-- delivered ledger receipt -> confirmed
                                      |          `-- error/missing receipt -> unknown
                                      |
same exact V1 retry ------------------+
  transmitting/unknown -> reconcile-only
  confirmed            -> return stored receipt, zero transport calls

changed V1 retry -> fail closed, zero transport calls
legacy row       -> preserve current no-replay authority; infer no body or receipt
```

## Implementation tasks

### Task 1: Pin canonical intent and compatibility behavior with RED tests

Files:

- Modify `packages/standalone/tests/operator/owner-event-effects.test.ts`
- Modify `packages/standalone/src/operator/owner-event-effects.ts`

RED cases:

1. Exact Unicode text, delivery ID, and null fields persist in a versioned intent.
2. Blank text and missing payload fail before a reservation can be written.
3. A resolved file/image path and exact caption persist without copying or hashing file bytes.
4. Sticker emotion is normalized once.
5. A changed versioned target, variant, body, path, emotion, or delivery ID is rejected.
6. An exact versioned retry remains reconcile-only or replays its confirmed receipt.
7. Legacy confirmed and unknown rows remain authoritative no-replay rows and gain no inferred data.
8. Inbox deletion still removes the retained payload and receipt.

Implementation:

- Add `OwnerEventTelegramIntentV1`, `OwnerEventTelegramReceiptV1`, and pure canonical construction,
  parsing, and exact-comparison helpers beside `OwnerEventEffectLedger`.
- Move the existing private-workspace file resolver into that module and reuse the same regular-file,
  realpath, and containment boundary.
- Compare only recognized versioned Telegram intents. Legacy rows retain their current compatibility
  behavior; Drive effect semantics remain unchanged.

Gate:

```bash
pnpm --dir packages/standalone exec vitest run tests/operator/owner-event-effects.test.ts
```

### Task 2: Expose one narrow read on the existing Telegram gateway with RED tests

Files:

- Modify `packages/standalone/tests/gateways/telegram.test.ts`
- Modify `packages/standalone/src/gateways/telegram.ts`

RED cases:

1. A delivered long text returns one receipt with the existing payload identity and delivered time.
2. A missing, processing, or payload-identity-free row returns no receipt.
3. Reusing one owner-event delivery ID with changed text reaches the existing binding mismatch
   instead of silently succeeding.
4. File, image, and sticker reads use the actual transport-variant ledger key.

Implementation:

- Add one read-only `readOutboundDeliveryReceipt(deliveryId, variant)` method to
  `TelegramGateway`.
- Return only `{deliveryId, variant, state, payloadIdentity, confirmedAt}` from an existing
  delivered row.
- Remove the owner-event delivered shortcut that precedes `claim`; let the existing binding check
  reject changed payloads. Exact retries remain idempotent through the existing claim result.

Gate:

```bash
pnpm --dir packages/standalone exec vitest run tests/gateways/telegram.test.ts
```

### Task 3: Preserve the real production adapter capabilities with a RED wiring test

Files:

- Modify `packages/standalone/tests/cli/runtime/gateway-init-owner-identity.test.ts`
- Modify `packages/standalone/src/cli/runtime/gateway-init.ts`

RED cases:

1. The adapter forwards text/file/image/sticker idempotency keys unchanged.
2. The adapter exposes the real active-turn methods, avoiding same-chat queue re-entry.
3. The adapter forwards the narrow existing-ledger receipt read.

Implementation:

- Preserve every optional argument and method already provided by `TelegramGateway`.
- Keep one adapter object shared by the existing executor and agent loop. Add no new wrapper class.

Gate:

```bash
pnpm --dir packages/standalone exec vitest run tests/cli/runtime/gateway-init-owner-identity.test.ts
```

### Task 4: Orchestrate reserve, send, receipt, confirm/unknown with RED tests

Files:

- Modify `packages/standalone/tests/agent/gateway-tool-executor.test.ts`
- Modify `packages/standalone/src/agent/gateway-tool-executor.ts`

RED cases:

1. Exact Unicode text is reserved before transport and confirmed with the matching ledger identity.
2. Long multi-chunk text stores one exact intent and one delivered receipt.
3. A confirmed exact retry returns success with zero transport calls.
4. A rephrased retry fails with zero transport calls.
5. A target or requested-variant change fails with zero transport calls.
6. A transport error marks unknown and a later exact retry remains reconcile-only.
7. A returned send with no valid ledger receipt marks unknown and does not false-confirm.
8. A definite image rejection followed by file success confirms the actual `file` variant receipt.
9. An ambiguous image error does not fall back or confirm.
10. Legacy confirmed/unknown rows remain no-replay and unobservable.
11. Direct non-owner-event Telegram sends retain their current behavior.

Implementation:

- Canonicalize before reservation, including the existing path boundary and empty-input rejection.
- Add the requested transport variant to the exact intent and track the actual delivered variant
  only for the receipt.
- After the awaited send, require `readOutboundDeliveryReceipt`; validate the delivery ID,
  actual variant, delivered state, payload identity, and timestamp before confirming.
- Missing method or receipt is an unknown effect. The result cannot be upgraded from the returned
  network promise alone.
- Keep the existing failure classification and image fallback. Add the small inline state diagram
  from this plan at the orchestration boundary.

Gate:

```bash
pnpm --dir packages/standalone exec vitest run \
  tests/operator/owner-event-effects.test.ts \
  tests/gateways/telegram.test.ts \
  tests/cli/runtime/gateway-init-owner-identity.test.ts \
  tests/agent/gateway-tool-executor.test.ts
```

### Task 5: Update parity evidence and run regression gates

Files:

- Modify `docs/development/runtime-overhead-canary-remediation-design.md`
- Modify `docs/development/kagemusha-telegram-parity.md`

Documentation:

- Add `variant` to the V1 delivered receipt because image-to-file fallback must record the actual
  ledger key.
- Record TG-01/TG-03/TG-04/TG-06 code/test evidence only. Do not claim merge, release, or canary.
- Record that the production adapter now preserves delivery identity and active-turn delivery.

Regression gates:

```bash
pnpm --dir packages/standalone run typecheck
pnpm --dir packages/standalone run build
pnpm --dir packages/standalone run test
pnpm exec prettier --check \
  packages/standalone/src/operator/owner-event-effects.ts \
  packages/standalone/src/agent/gateway-tool-executor.ts \
  packages/standalone/src/gateways/telegram.ts \
  packages/standalone/src/cli/runtime/gateway-init.ts \
  packages/standalone/tests/operator/owner-event-effects.test.ts \
  packages/standalone/tests/agent/gateway-tool-executor.test.ts \
  packages/standalone/tests/gateways/telegram.test.ts \
  packages/standalone/tests/cli/runtime/gateway-init-owner-identity.test.ts \
  docs/development/runtime-overhead-canary-remediation-design.md \
  docs/development/runtime-overhead-telegram-receipt-plan.md \
  docs/development/kagemusha-telegram-parity.md
git diff --check
```

## Code-path coverage

```text
[+] canonical intent
    |-- text / file / image / sticker
    |-- blank or missing input
    |-- exact retry / changed retry / legacy row
    `-- inbox-retention cleanup

[+] existing Telegram ledger
    |-- text chunks complete -> delivered receipt
    |-- file / image / sticker transport keys
    |-- processing / missing / malformed receipt
    `-- exact binding match / changed binding rejection

[+] executor
    |-- reserve -> send -> receipt -> confirm
    |-- transport failure -> unknown
    |-- returned send + missing receipt -> unknown
    |-- image rejection -> actual file receipt
    `-- confirmed / unknown / legacy retry no-replay

[+] production wiring
    |-- idempotency key forwarded
    |-- active-turn method forwarded
    `-- receipt read forwarded
```

Planned unit/integration coverage: 27/27 branches. One real post-release owner-event delivery remains
live-only evidence.

## Failure modes

| Failure                                    | Existing/new handling                       | Test | User/operator outcome             |
| ------------------------------------------ | ------------------------------------------- | ---- | --------------------------------- |
| Changed body on retry                      | Exact versioned intent mismatch             | Yes  | Tool fails, no second send        |
| Adapter drops delivery ID                  | Adapter forwarding regression               | Yes  | Prevented before release          |
| Telegram accepts but ledger cannot be read | Mark effect unknown                         | Yes  | No false success or resend        |
| Definite photo rejection                   | Existing file fallback, actual file receipt | Yes  | One delivered document            |
| Ambiguous photo outcome                    | Existing no-fallback rule, unknown effect   | Yes  | No second transport               |
| Legacy confirmed row                       | Existing success/no-replay authority        | Yes  | Payload remains unobservable      |
| Legacy unknown row                         | Existing reconcile-only authority           | Yes  | Existing paging/retry path        |
| Inbox retention deletes batch              | Existing trigger deletes effect             | Yes  | Body and receipt age out together |

Critical silent gaps after planned tests: 0.

## NOT in scope

- New SQLite columns or migrations. Existing `intent_json` and `result_json` are sufficient.
- A second delivery ledger, receipt service, worker, queue, timer, or file-snapshot store.
- File-byte hashing or copied outbound files. Existing resolved path plus caption remains identity.
- Telegram provider-side exactly-once guarantees. The existing local at-least-once chunk semantics
  remain unchanged.
- Inferring payloads or receipts for legacy effects.
- Model prompt/tool-definition changes or synthetic Telegram traffic.
- Version bump, install, restart, and canary. Those happen after this PR merges in the shared patch
  release gate.

## Execution strategy

Sequential implementation, no parallelization opportunity. The four steps share the same Telegram
effect contract and must land in dependency order: canonical intent, ledger read, production wiring,
then orchestration. This avoids two competing definitions of delivery identity.

## Review decisions to lock

1. Reuse the existing Telegram message ledger and its SHA-256 payload identity. No new hash path.
2. Keep exact outbound text in bounded owner-effect JSON, never logs or public telemetry.
3. Treat a missing local delivered receipt as unknown even when the send promise returned.
4. Preserve legacy no-replay authority without inventing observability.
5. Fix the lossy production adapter because receipt code that works only in mocks is not a product.

## Engineering review closure

- Step 0, scope challenge: accepted. The diff reuses the existing effect JSON and Telegram ledger;
  no new infrastructure is justified. Although documentation plus tests bring the touched-file
  count above eight, the product code remains four existing modules and zero new classes/services.
- Architecture review: two issues found and incorporated. The production adapter must forward the
  delivery ID/active-turn methods, and the receipt must name the actual transport variant after
  image fallback.
- Code-quality review: clear. Canonical construction/comparison stays beside the effect ledger;
  the already-large executor only orchestrates boundaries.
- Test review: 27/27 planned branches, no uncovered code path after the additions above. No prompt
  or model behavior changes, so no eval suite is required.
- Performance review: clear. The new hot-path work is one bounded JSON-field comparison and one
  in-memory lookup in the existing Telegram ledger. No extra model call, SQLite query loop, file
  read, or network call is added.
- Failure-mode review: zero critical silent gaps.
- TODOS.md: no new deferred item. The remaining release/canary/v1.0 work already belongs to the
  active goal rather than repository debt.
- Outside voice: skipped. Repository policy forbids recursive Codex, and this small sequential
  backend patch has no user-requested subagent review.
- Lake score: 5/5 review decisions choose the complete existing-boundary path without adding
  parallel machinery.

## GSTACK REVIEW REPORT

| Review        | Trigger               | Why                        | Runs | Status         | Findings                                             |
| ------------- | --------------------- | -------------------------- | ---: | -------------- | ---------------------------------------------------- |
| CEO Review    | `/plan-ceo-review`    | Scope and strategy         |    0 | skipped        | Backend remediation scope already approved           |
| Codex Review  | `/codex review`       | Independent second opinion |    0 | prohibited     | Nested Codex is forbidden by repository policy       |
| Eng Review    | `/plan-eng-review`    | Architecture and tests     |    1 | clear          | 2 issues incorporated, 0 unresolved, 0 critical gaps |
| Design Review | `/plan-design-review` | UI/UX gaps                 |    0 | not applicable | No frontend change                                   |
| DX Review     | `/plan-devex-review`  | Developer experience gaps  |    0 | not applicable | No public API or onboarding change                   |

**VERDICT:** ENG CLEARED. Ready for test-first implementation.
