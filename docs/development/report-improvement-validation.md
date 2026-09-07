# Report improvement candidate validation

최상위 판정은 [INTENT.md](../../INTENT.md)와 [의도 점검 기록](intent-checks.md)을 따른다.
아래 내용은 변경 범위의 검증 근거이며 전체 MAMA 목적의 완료 판정이 아니다.

Candidate base: `381716c0` (mama-os 0.50.0). This candidate was installed locally on 2026-09-07 at the owner's request; it is not published.
The pre-release product evidence gate in [release-process.md](release-process.md) applies.

## Failure reproduction and correction

| User path                                      | Baseline evidence                                                                                                                         | Candidate evidence                                                                                                                           | Limits                                                                            |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| TG-01/04/06 owner input during background send | Registered Telegram ingress, boot router/runtime, actual CodeAct and effect/transport receipt path stalls the send behind model admission | Background-first and inbound-first queued-background tests finish; prepared multipart sends remain contiguous and owner effects confirm once | Model protocol and Telegram API are controlled external doubles; no live messages |
| TG-01/06 ready answer recovery                 | Streaming edit plus periodic recovery sent a duplicate final answer after the queue split                                                 | Live presenter retains ownership until settlement; focused regression passes                                                                 | Restart/uncertain-send semantics remain subject to existing receipt tests         |
| TG-05 queue context and priority               | Recursive queue pumping inherited the previous task context; global queue lost owner priority                                             | Admission context binding and priority propagation pass focused tests                                                                        | No preemption of active or earlier equal-priority owner work                      |
| TG-06 report state                             | Retry-scheduled delivery logged SENT                                                                                                      | Pending remains pending without scheduler credit or SENT                                                                                     | A log is still not a provider receipt                                             |
| TG-03/06 calendar                              | Future-start reader omitted ongoing events; first page omitted continuation; initial patch lost same-ID updates in immutable RawStore     | Real producer -> RawStore -> executor update/cancel, zoned all-day boundaries and cursor-content changes pass focused tests                  | Historical upstream completeness remains unknown                                  |

Calendar task review rejected the first 33-test candidate because its mocked producer and isolated
reader tests missed the immutable storage seam. The corrected 37-test candidate includes that seam.
This is why product-path review precedes release rather than relying on aggregate test counts.

## Judgment evaluation

The versioned synthetic fixtures in `packages/standalone/evals/report-judgment/fixtures.v1.json`
cover month identity, assignment prerequisites/authority, before/after receipt cutoffs, retry/date
confusion, partial absence and positive completion evidence. The harness freezes production full
report guidance before any candidate comparison and records the evaluation protocol separately.

The real gpt-5.6-sol supplied-evidence baseline returned valid responses for all seven fixtures.
Five pass the strict structured labels; two use “unsupported” where the rubric expected
“unconfirmed”. Inspection of those report bodies found that both correctly withheld completion
or reservation-change claims. Structured-label scores are not semantic quality scores. A reviewer
must inspect report text and uncertainty, not merely count matching fields.

This result does not establish a need for a new judgment store, so no such store or speculative
guidance layer is introduced. Supplied-evidence results also do not prove autonomous retrieval.
The separate retrieval runner uses the real model, AgentLoop, CodeAct, TaskLedger and calendar
reader with identical synthetic stores and a restricted read-only tool set. It retains reports,
tool history, fixture/prompt hashes and timings for baseline/candidate semantic review. The actual
reader clocks are recorded and constrained to the same stable fixture-membership interval; they
are not represented as a frozen wall clock.

## Reproduce locally

Run commands from the repository root, serially:

```bash
MAMA_FORCE_TIER_3=true pnpm --dir packages/standalone exec vitest run tests/gateways/telegram-owner-queue.integration.test.ts tests/gateways/telegram.test.ts tests/gateways/telegram-response-presenter.test.ts tests/concurrency/lane-manager.test.ts
MAMA_FORCE_TIER_3=true pnpm --dir packages/standalone exec vitest run tests/connectors/calendar.test.ts tests/agent/schedule-upcoming.test.ts tests/operator/report-run.test.ts tests/operator/operator-trigger-loop-report-delivery.test.ts tests/operator/report-judgment-evaluator.test.ts
```

Actual model comparisons are opt-in, use synthetic data only and require configured Codex auth:

```bash
pnpm --dir packages/standalone exec tsx evals/report-judgment/run.ts --mode=baseline --output=/absolute/private/eval-directory
pnpm --dir packages/standalone exec tsx evals/report-judgment/run-retrieval.ts --mode=baseline --output=/absolute/private/retrieval-directory
pnpm --dir packages/standalone exec tsx evals/report-judgment/run-retrieval.ts --mode=candidate --output=/absolute/private/retrieval-directory
```

The retrieval baseline currently requires the locally installed 0.50.0 package. Its path is
explicit in the harness; it is not a generic CI dependency. Results and isolated runtime state stay
outside commits. No operating source, daemon, task, or Telegram target is used by these commands.

## Actual retrieval comparison

The valid baseline and candidate runs used the same fixture SHA-256 and prompt SHA-256. Both
ran real gpt-5.6-sol with successful CodeAct, task_list and schedule_upcoming calls. The installed
0.50.0 baseline reported the next-month task and zero calendar items, omitting the ongoing
current-month obligation. The candidate reported both distinct obligations, withheld business
completion despite the calendar's confirmed status, and stated that upstream completeness was
unknown. Independent semantic review accepted this specific improvement.

One observed runtime per variant was 95.4 seconds and 82.3 seconds respectively. These are
single-case timings, not a percentile or general performance claim. Earlier harness setup failures
(instruction isolation, missing model-run identity and an expired fixture envelope) are excluded
from the valid pair; they are not product baseline measurements. The scripts retain the actual
responses and histories for audit, and generated auth copies are removed after evaluation.

## Release disposition

Final independent review passed with no unresolved P1/P2 in the reviewed scope. Final root
checks exited 0: typecheck (3 tasks), lint, build (2 tasks), test (7 tasks, 6 cached) and version
synchronization. The changed standalone suite ran 418 passing files / 5,664 passing tests, with
4 files and 7 existing tests skipped. No p95 claim is supported by these small samples, and no
package has been published. The owner-requested local installation retains version 0.50.0 and is identified by matching installed build hashes, not the version string alone. Post-release verification must only
confirm installation/environment behavior; it cannot substitute for the pre-release proof above.
