---
title: Owner turns
parent: Development
nav_order: 7
---

# Owner turns

The owner runtime uses one persistent native session. `owner-runtime.ts` builds the standing
prompt from `owner-system-prompt.ts`; `native-session.ts` adds the current owner policy file as
a separate system layer. The policy provider reads the file for each turn. A changed policy
fingerprint makes `native-prompt.ts` open a session with the full policy again when the backend
reports a mismatch. On a new session, `stimulus-delivery.ts` also prepends a bounded session-start
block to the turn text. A resumed session receives the new turn text.

| Turn kind             | Text assembled for the turn                                                                                                                                              | Further instruction or context                                                                                                                                                                                   |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Owner message         | Messenger, local time, message text and downloaded attachment paths or errors                                                                                            | Up to three matching situational owner rules and learned lessons; the standing prompt points to `help({topic: 'corrections'})` for corrections and `help({topic: 'full-report'})` for an owner-requested report. |
| Delta notify          | Local channel and time, bounded source lines quoted as untrusted content, and the choice between `[notify]` and `[ack]`                                                  | Up to three matching situational owner rules and learned lessons. This turn decides whether to tell the owner; recording follows in another order.                                                               |
| Delta record          | Source channel, local time, observation references and recent source lines, then steps to read context and work, write a revision or `work.no_update`, and reply `[ack]` | No lesson recall or rule index. The record help procedure points to the standing recording rules in the owner policy and to `memory.search` for situational owner rules.                                         |
| Scheduled full report | Local time, previous full-report time or a previous-day fallback, destination messenger and a pointer to `help({topic: 'full-report'})`                                  | The help procedure supplies report steps without a rule index and points to the owner policy and `memory.search` for situational report rules. The scheduled order has no lesson recall.                         |
| Reminder              | Local time, destination messenger and steps to find urgent work, update the board and reply or acknowledge                                                               | The order has no lesson recall or owner-rule index.                                                                                                                                                              |
| Daily                 | Local day, its time bounds, target daily page and `help({topic: 'daily'})`                                                                                               | The daily procedure is returned by help; the order has no lesson recall or owner-rule index.                                                                                                                     |
| Replay window         | Window identity, time, source reading guidance, queue or message lines, current work digest and replay instructions                                                      | The replay text carries its own plan, child assignment and read-back instructions. Source reads have the window's end as their ceiling. There is no lesson recall for this order.                                |
| Session start         | Local time, recent owner exchanges, the latest checkpoint and recent decisions                                                                                           | This block is included only when the native session is new. It calls its contents history and tells the agent to read current state with tools.                                                                  |

The standing prompt covers boundaries, source trust, progressive reads, tool use, continuity and
the names of on-demand help topics. Language, style and report content belong to the owner policy
file. `turn-orders.ts` supplies only the steps and data for the turn at hand, following the
reference implementation's small-order mechanism. Standing owner rules reach every session through
the owner policy; situational rules stay in memory. Owner messages and delta notify orders recall
matching guidance. Recording and full-report procedures direct the agent to read situational owner
rules with `memory.search` before writing. The decision is recorded in
[the owner-rule work item](https://github.com/jungjaehoon-lifegamez/MAMA/blob/main/docs/development/work/owner-rules.md).

Code: [turn orders](../../packages/standalone/src/runtime/turn-orders.ts),
[delivery assembly](../../packages/standalone/src/runtime/stimulus-delivery.ts),
[owner runtime](../../packages/standalone/src/runtime/owner-runtime.ts),
[standing prompt](../../packages/standalone/src/runtime/owner-system-prompt.ts),
[policy provider](../../packages/standalone/src/runtime/owner-policy.ts),
[native session](../../packages/standalone/src/runtime/native-session.ts), and
[native prompt](../../packages/mama-core/src/runtime/native-prompt.ts).
