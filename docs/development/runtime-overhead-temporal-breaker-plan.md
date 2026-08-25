# Runtime overhead PR-B: Temporal contract and circuit breaker plan

> **Status:** approved design, implementation in progress
>
> **Date:** 2026-08-26
>
> **Base:** PR-A merge `029da5fa`

This plan executes PR-B from `runtime-overhead-reduction-design.md`. It preserves
TG-03/TG-04 agent composition freedom, TG-05 run-local continuity, and TG-06
receipt-first mutation precedence.

## Non-negotiable contracts

- [ ] Explicit scope or connector widening remains fail-closed.
- [ ] Only trusted `hostToolExecutions` can classify a deterministic repeat.
- [ ] Model prose, JavaScript text, sandbox logs, and error messages are never
      classification authority.
- [ ] Mutation terminal codes win before the circuit breaker.
- [ ] Provider, capacity, rate-limit, transport, and missing-code failures retain
      current retry behavior.
- [ ] Breaker counters live only in one `RunScope`; concurrent and subsequent runs
      start from zero.
- [ ] Non-Temporal lanes retain the existing 50-call emergency behavior.
- [ ] WorkOrder retry suppression keys only on exact `TOOL_CONTRACT_REPEAT`.

## Task 1: one host-bound `context_compile` contract

RED:

- [ ] Add coherence assertions covering the canonical registry, Code-Act HostBridge,
      and Temporal managed brief.
- [ ] Assert Temporal tells the model to omit `scopes`, `connectors`, and raw seeds;
      the host supplies current grants and the active task seed.
- [ ] Keep explicit widening denial tests green.

GREEN:

- [ ] Add a small shared contract module.
- [ ] Make `tool-registry.ts` and `code-act/host-bridge.ts` consume the same description.
- [ ] Make `temporal-worker.ts` consume the Temporal-specific host-bound instruction.

## Task 2: pure deterministic failure classifier

RED:

- [ ] Same ordered deterministic failed `{tool, code}` audit produces one stable
      SHA-256 fingerprint.
- [ ] A different order or code produces a different fingerprint.
- [ ] Successful, missing-code, provider/transport, or unallowlisted failures do not
      produce a deterministic fingerprint.
- [ ] Same fingerprint reaches terminal only on the third consecutive observation.
- [ ] Success, no fingerprint, or a different fingerprint resets the consecutive count.
- [ ] Separate state objects never share counters.

GREEN:

- [ ] Implement the closed allowlist and pure transition helpers in a dedicated module.
- [ ] Return only a short non-sensitive fingerprint prefix in terminal metadata.

## Task 3: `RunScope` integration and outer-call ceiling

RED:

- [ ] Three differently written Temporal Code-Act programs with the same trusted nested
      denial terminate as `TOOL_CONTRACT_REPEAT`.
- [ ] The ninth Temporal outer Code-Act attempt terminates before executor invocation.
- [ ] A success or different fingerprint resets the streak.
- [ ] Missing-code/provider failures do not trip the deterministic breaker.
- [ ] A mutation terminal result on the third attempt keeps its existing mutation code.
- [ ] A following Temporal run starts with empty counters.
- [ ] Existing non-Temporal distinct programs and 50-call emergency cap stay unchanged.

GREEN:

- [ ] Add only `codeActCalls`, `lastDeterministicFingerprint`, and
      `consecutiveDeterministicFailures` to `RunScope`.
- [ ] Count Temporal outer Code-Act calls before execution.
- [ ] Convert only breaker decisions into structured non-retryable terminal results.

## Task 4: backend terminal propagation

RED/GREEN:

- [ ] Add `TOOL_CONTRACT_REPEAT` to `HostToolTerminalCode` and `AgentErrorCode`.
- [ ] Pin Claude parsed-tool propagation through `AgentLoop`.
- [ ] Pin Codex app-server interrupt propagation.
- [ ] Pin Cline projected custom-tool propagation.

## Task 5: receipt-first WorkOrder retry policy

RED:

- [ ] Exact `AgentError.code === TOOL_CONTRACT_REPEAT` exhausts one Temporal generation
      without creating another model run.
- [ ] Plain text containing the code does not suppress retry.
- [ ] An unrelated `retryable: false` error does not suppress retry.
- [ ] Existing ambiguous mutation codes remain no-retry and keep precedence.

GREEN:

- [ ] Pass a fixed safe failure reason only after exact code validation.
- [ ] Keep durable receipt/generation arbitration before failure transition.
- [ ] Report deterministic-contract suppression separately from ambiguous mutation.

## Task 6: verification and handoff

- [ ] Focused PR-B suites pass.
- [ ] Standalone typecheck and build pass.
- [ ] Full standalone tests pass.
- [ ] Root typecheck, build, and tests pass.
- [ ] Changed-file Prettier and `git diff --check` pass.
- [ ] Update the design and Kagemusha TG-03/TG-04/TG-05/TG-06 evidence.
- [ ] Run diff review, clear all findings, open PR-B, clear CI and review comments,
      then merge before the single shared release.
