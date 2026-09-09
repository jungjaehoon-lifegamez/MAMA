# One MAMA autonomy audit — local candidate 0.52.0-local.1

Status: investigation and revised acceptance direction; no new implementation or deployment in this audit.
Intent v6: I-01/I-02/I-06/I-07, TG-03/TG-04/TG-05/TG-06. Report style is one failure case, not the product objective.

## Acceptance principle supplied by the owner

The agent must complete work from a short objective, accessible evidence, and reusable experience.
A host that prescribes the action sequence and then checks whether the agent followed it is not the
intended agent. Unify access to state and experience; do not replace the agent's judgment with a
central host planner, classifier, or mandatory per-turn reviewer. No intent expansion is needed.

## Owner clarification: hint, progressive investigation, action, evolution

The intended cycle is: related situation → small applicable hint → progressive investigation of
available evidence → agent judgment and action → observation of actual results → correction of the
reusable experience → improved hint on the next related situation.

A hint supplies relevance, applicability, the prior experience and where to look next. It is not a
full injected manual, fixed tool sequence, precomputed answer or an instruction to manufacture work.
The agent can dismiss an irrelevant hint, investigate contrary evidence, and decide that no change is
needed. Progressive access must make the underlying originals and history reachable rather than trap
the agent in a host-selected summary. Observed outcomes and original owner feedback must remain linked
so the agent can revise the hint and its underlying procedure with evidence. Evolving guidance must
preserve scope and cannot create new authority.

Judge the entire cycle, including the next related task, not each storage API in isolation. Current
breaks include independently injected policy/brief/trigger content, the unattended instruction against
recording lessons, and outcomes outside a common discoverable work/experience history. A short prompt
without usable hints and evidence access would be another incomplete implementation.

## What is already shared

`owner-runtime.ts` defines owner:runtime and the owner role projection. Chat, owner events, and
workerRun reach AgentLoop under that identity. Chat priority is already 100. Source/channel is not
supposed to grant or remove ordinary business authority. These improvements remain useful.

## Remaining divisions and concrete consequences

| Division                                                                | Live/source evidence                                                                                                                                                                               | Consequence                                                                                                                                                                                                                                             |
| ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Scheduled learning contradicts chat learning                            | workorder-consumer.ts SCHEDULED_TURN_PREAMBLE says to state a lesson in the final message instead of recording it; standing policy administration is owner-interactive                             | Tools allow correction while a code-owned prompt discourages learning during unattended work. This directly conflicts with learning from recurring outcomes.                                                                                            |
| Persona, brief, policies, and procedures coexist as instructions        | agent-loop.ts loadComposedSystemPrompt; message-router.ts buildSystemPrompt; procedure-runtime.ts prepareContext                                                                                   | There is no complete replacement relationship across the current active instructions. The latest report contained both the new correction and the older style rules.                                                                                    |
| Legacy append instruction survives                                      | console-brief.ts modernizeLegacyBriefMechanism requires a five-line exact historical introduction; the operating file has the three-line variant                                                   | Installed rendering still says to append while preserving everything above. The actual owner correction used append, creating owner-console-brief r1 rather than revising the conflicting rule.                                                         |
| Keyword observer remains a separate authority writer                    | turn-observer.ts observeOwnerTurn and learning-markers.ts detectDurableInstruction create policy/lesson rows by marker and text hash                                                               | A differently worded correction is another record; model-owned procedure revision does not replace this producer. Learning-context can re-inject old rows unless their IDs are explicitly superseded.                                                   |
| Multiple skill/experience paths                                         | installed skill catalog/PromptEnhancer, procedure catalog, legacy trigger body/ref, policy/lesson context                                                                                          | Discovery and applicability are split. At audit time the live procedure store has only owner-console-brief r1; it is excluded from the procedure catalog, so the actual report saw an empty learned-procedure catalog.                                  |
| Outcome records do not complete the common learning loop                | owner-event-loop forwards outcomes to TriggerRegistry; procedure-runtime records outcomes through procedure_observe; chat observer processes only owner text                                       | The new procedure outcome table has zero rows in this live sample. Existing receipts and correction failures are not uniformly discoverable as a procedure's execution history. Empty observations do not mean successful behavior.                     |
| Same session, different prompt assembly                                 | chat builds persona/brief policy; workerRun prepends the complete brief and a kind-specific section to each work order; owner-event-prompt independently combines brief/lessons/skill/trigger text | Shared identity does not prevent duplicated context or competing instructions. Captured maintenance input sizes were 20,215 and 13,815 characters.                                                                                                      |
| Host-generated behavioral recipes remain                                | workorder-consumer.ts buildTurnKindBody and owner-event-prompt.ts prescribe starting tools, lookup order, publication shape, and completion wording                                                | Long instructions turn an open objective into a prescribed procedure. Resource authority, immutable effect receipts, and truthful completion are infrastructure requirements; tool order and scenario-specific scripts must not be conflated with them. |
| Unrelated alarm is inserted into a direct request                       | message-router.ts memoryNoticeQueue/formatAuditNotice prepended a stale wiki-claim alarm to the owner's report-style correction                                                                    | After saving the correction the model investigated wiki/daemon/audit state, delaying the reply and mixing two separate purposes.                                                                                                                        |
| Discovery contract differs from effect-tool policy                      | Code-Act tool-policy validates requestedAllowedTools against HostBridge registry; intrinsic tool_search is not a registry effect tool                                                              | A model's allowedTools:[tool_search] call failed although tool_search itself worked without that option. Repeated discovery then continued.                                                                                                             |
| Scheduling is priority-based but not interruptible between model rounds | concurrency/lane-manager.ts runs await entry.task(); chat lanePriority=100 only orders queued entries                                                                                              | Owner correction waited about 162 seconds for an already-running board job. Increasing priority again would not fix that wait.                                                                                                                          |

## Measured latency after local installation

KST 2026-09-08, actual runtime log plus Codex completed tool events. No new synthetic production messages.
Durations below are active lane time or turn completion, not a service p95 or a current Kagemusha benchmark.

| Run                           |                 Active duration | Code-Act calls | Calls containing search/describe | Tool wall time |
| ----------------------------- | ------------------------------: | -------------: | -------------------------------: | -------------: |
| Background board update       |                         287.8 s |             24 |                               16 |        2.687 s |
| Owner report-style correction | 96.0 s, plus about 162 s queued |             13 |                                9 |        0.487 s |
| Owner full report             |                         183.8 s |              8 |                                5 |        0.236 s |
| Following scheduled work      |                         188.0 s |             14 |                                6 |        1.223 s |

Across these four runs: 59 Code-Act calls, 36 containing discovery, 4.633 seconds of tool execution.
The full report spent approximately 27 seconds before its first tool, 28 more seconds in discovery,
59 seconds through evidence gathering/judgment, and 70 seconds from the last read to final completion.
The backend reported 292,444 input tokens (247,424 cached) and 4,377 output tokens including 2,665
reasoning output tokens. Repeated cached context is still counted in those input totals.

The data supports overhead from repeated model/tool discovery, large/repeated context, mixed purposes,
and blocking maintenance. It does not allocate every model second to a particular instruction or prove
that removing all guidance would preserve quality. A policy change caused a fresh session in this sample;
that can be necessary to replace stale instructions and is not proof that every turn resets.

## Revised implementation direction

1. Keep a small stable host contract for authenticated access, tool semantics, source provenance,
   atomic state changes and effect receipts. Remove scenario-specific work recipes from that contract.
2. Give chat, reports and events the same way to discover current work, original owner instructions,
   active agent-owned procedures and past results. Input adapters provide stimulus, source/time,
   requested result and response destination; they do not author another personality or tool sequence.
3. Expose one coherent correction operation across current editable guidance and its origins.
   Preserve original/history, explicit replacement relationships and scope. The agent decides whether
   to keep, narrow, replace or retire a procedure. Existing policy writers must become provenance or
   be retired as independent active instruction producers; adding another store is insufficient.
4. Attach actual work/effect receipts and observed failures to the relevant work and selected procedure
   revision. Make them available to the same agent. Do not automatically label tool success as learning,
   require a new reviewer model every turn, or turn a fixed failure count into a mandatory correction.
5. Retain compact tool names/signatures consistently and load detail when needed. Align intrinsic
   discovery APIs with the visible invocation contract. Measure discovery rounds rather than merely
   whether the final call succeeded.
6. Keep background alarms as separate attention items with provenance and urgency. Let the agent
   judge relevance instead of silently appending an unrelated recheck instruction to the owner's text.
7. Make long background work resumable at safe boundaries when owner input arrives, preserving
   progress and effect receipts. Do not create a competing owner or blindly cancel uncertain writes.

## Required comparison before broad implementation

Freeze the actual failing operating guidance and input cases. Compare the existing candidate against
minimal task framing with the same model, effort, evidence and tool authority. A short frame states the
objective and how to reach prior experience, not a mandated search order or report template. The agent
must choose tools, identify contradictions and revise the applicable procedure itself.

Use report plus non-report work and an unrelated ordinary conversation. After correction, test a fresh
context and new related input. Evaluate factual/artifact quality, actual correction, preserved scope,
work completion, queue-to-delivery time, prompt size, model rounds and cached/uncached usage together.
Do not optimize a screenshot or a token count while degrading work quality. Do not run until a lucky
failure/success appears. A minimal-context comparison is not yet performed by this audit.

Kagemusha also contains code-owned behavioral guidance (agent/system-prompt.ts); its better observed
formatting is not evidence that it has no host constraints. Compare the complete actual work path,
not an idealized architecture or the visual report alone.

## Evidence locations

- Installed runtime: `/private/tmp/mama-correction-local-runtime.log`.
- Actual sessions: ~/.mama/.codex/sessions/2026/09/08, 21:48:42 and 21:55:16 sessions.
- Live state: ~/.mama/operator/triggers.db, read-only counts and scoped revision inspection.
- Prior install evidence: .superpowers/validation/correction-activation/local-install.json.

Operating state was read, not edited or restarted, during this audit. Public release remains pending.
