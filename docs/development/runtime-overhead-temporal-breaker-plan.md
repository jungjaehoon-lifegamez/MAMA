# Runtime overhead PR-B: Temporal contract and circuit breaker plan

> **Status:** reviewed and merged as PR #231, shared release pending
>
> **Date:** 2026-08-26
>
> **Base:** PR-A merge `029da5fa`

This plan executes PR-B from `runtime-overhead-reduction-design.md`. It preserves
TG-03/TG-04 agent composition freedom, TG-05 run-local continuity, and TG-06
receipt-first mutation precedence.

## Non-negotiable contracts

- [x] Explicit scope or connector widening remains fail-closed.
- [x] Only trusted `hostToolExecutions` can classify a deterministic repeat.
- [x] Model prose, JavaScript text, sandbox logs, and error messages are never
      classification authority.
- [x] Mutation terminal codes win before the circuit breaker.
- [x] Provider, capacity, rate-limit, transport, and missing-code failures retain
      current retry behavior.
- [x] Breaker counters live only in one `RunScope`; concurrent and subsequent runs
      start from zero.
- [x] Non-Temporal lanes retain the existing 50-call emergency behavior.
- [x] WorkOrder retry suppression keys only on exact `TOOL_CONTRACT_REPEAT`.

## Task 1: one host-bound `context_compile` contract

RED:

- [x] Add coherence assertions covering the canonical registry, Code-Act HostBridge,
      and Temporal managed brief.
- [x] Assert Temporal tells the model to omit `scopes`, `connectors`, and raw seeds;
      the host supplies current grants and the active task seed.
- [x] Keep explicit widening denial tests green.

GREEN:

- [x] Add a small shared contract module.
- [x] Make `tool-registry.ts` and `code-act/host-bridge.ts` consume the same description.
- [x] Make `temporal-worker.ts` consume the Temporal-specific host-bound instruction.

## Task 2: pure deterministic failure classifier

RED:

- [x] Same ordered deterministic failed `{tool, code}` audit produces one stable
      SHA-256 fingerprint.
- [x] A different order or code produces a different fingerprint.
- [x] Successful, missing-code, provider/transport, or unallowlisted failures do not
      produce a deterministic fingerprint.
- [x] Same fingerprint reaches terminal only on the third consecutive observation.
- [x] Success, no fingerprint, or a different fingerprint resets the consecutive count.
- [x] Separate state objects never share counters.

GREEN:

- [x] Implement the closed allowlist and pure transition helpers in a dedicated module.
- [x] Return only a short non-sensitive fingerprint prefix in terminal metadata.

## Task 3: `RunScope` integration and outer-call ceiling

RED:

- [x] Three differently written Temporal Code-Act programs with the same trusted nested
      denial terminate as `TOOL_CONTRACT_REPEAT`.
- [x] The ninth Temporal outer Code-Act attempt terminates before executor invocation.
- [x] A success or different fingerprint resets the streak.
- [x] Missing-code/provider failures do not trip the deterministic breaker.
- [x] A mutation terminal result on the third attempt keeps its existing mutation code.
- [x] A following Temporal run starts with empty counters.
- [x] Existing non-Temporal distinct programs and 50-call emergency cap stay unchanged.

GREEN:

- [x] Add only `codeActCalls`, `lastDeterministicFingerprint`, and
      `consecutiveDeterministicFailures` to `RunScope`.
- [x] Count Temporal outer Code-Act calls before execution.
- [x] Convert only breaker decisions into structured non-retryable terminal results.

## Task 4: backend terminal propagation

RED/GREEN:

- [x] Add `TOOL_CONTRACT_REPEAT` to `HostToolTerminalCode` and `AgentErrorCode`.
- [x] Pin Claude parsed-tool propagation through `AgentLoop`.
- [x] Pin Codex app-server interrupt propagation.
- [x] Pin Cline projected custom-tool propagation.

## Task 5: receipt-first WorkOrder retry policy

RED:

- [x] Exact `AgentError.code === TOOL_CONTRACT_REPEAT` exhausts one Temporal generation
      without creating another model run.
- [x] Plain text containing the code does not suppress retry.
- [x] An unrelated `retryable: false` error does not suppress retry.
- [x] Existing ambiguous mutation codes remain no-retry and keep precedence.

GREEN:

- [x] Pass a fixed safe failure reason only after exact code validation.
- [x] Keep durable receipt/generation arbitration before failure transition.
- [x] Report deterministic-contract suppression separately from ambiguous mutation.

## Task 6: verification and handoff

- [x] Focused PR-B suites pass.
- [x] Standalone typecheck and build pass.
- [x] Full standalone tests pass.
- [x] Root typecheck, build, and tests pass.
- [x] Changed-file Prettier and `git diff --check` pass.
- [x] Update the design and Kagemusha TG-03/TG-04/TG-05/TG-06 evidence.
- [x] Run diff review, clear all findings, open PR-B, clear CI and review comments,
      then merge before the single shared release.
