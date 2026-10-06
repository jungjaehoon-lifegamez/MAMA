# W37 — The owner's standing rules live in the owner policy

Owner decision, 2026-10-06:

- A rule that always applies goes into `owner-policy.md`, which every turn reads with its system
  prompt. The agent changes that file only in an owner chat turn.
- Whether a correction always applies or fits one situation is the agent's judgment when it saves
  it. Situational rules stay in memory and reach turns as lessons, as now.
- The owner rules saved so far are merged once. After that, the rule index of #414 (record orders)
  and #421 (the full-report procedure) is removed.
- This closes open owner decision 1 in [kagemusha-operator.md](https://github.com/jungjaehoon-lifegamez/MAMA/blob/81695ecbc/docs/rebuild/kagemusha-operator.md#owner-decisions-still-open).

Program evidence (code and the 2026-10-05 21:30 to 10-06 15:34 data, UTC+9; [checks](../checks.md)):

- The home the design gives standing rules has no write path. `owner-policy.md` last changed on
  09-29 at 15:54; the agent writes only inside the workspace, and no action writes the file.
  There are 26 active owner rules (2 from 09-26, 24 from 09-29 to 10-06). None is in the file as
  written; one partly overlaps a policy line.
- What the host attaches differs by turn kind: the policy file goes to every session; recalled
  lessons go to owner message, delta notify and delta record turns; the rule index goes to record
  orders and comes back from `help('full-report')`. The rule index is also the only route by which
  an owner rule reaches report turns today (`runtime/owner-runtime.ts:355`), the fix for C4.
- A wiki publish without `type` is filed as `entity` without a word (`normalizeWikiPageType`'s
  default). That silent default, not the agent, misfiled the 10-04 daily; #415 and #426 answered it
  with call shapes in the procedure.
- Kagemusha keeps its standing rules in its one prompt and gives no lessons on reconcile, report
  or reminder turns.
- A changed policy makes the next turn open a new session: the policy fingerprint no longer matches
  (mama-core `runtime/native-prompt.ts:379`). Baseline: 9 sessions opened in the 18 hours above.
  About 65 owner-rule records were saved from 09-26 to 10-06, so a few standing changes a day are
  expected.

Model behavior, observed and not a reason for this work (owner, 2026-10-06: what a better model
fixes is left out): record turns opened no rule body from the index (0 of 108), and the rule for
finished work was missed at two 10-05 closes.

Where the history lives:

- The update action is the only writer. Each change is saved as a memory record that holds the
  reason in `summary` and the full new text in `details` (the session start shows recent summaries),
  bound to `user:<owner>`. It replaces the previous record, and its provenance is the owner message
  (W38 stores that message first).
- These records are identified by their provenance (written by `manage.policy.update`), not by
  topic. `guardOwnerRules` refuses `memory.save` with `replaces` and `memory.retire` on them, and
  refuses a new record that claims to be one, outside the update action. Today kind `decision` is
  outside `RULE_KINDS`, so any turn could change such a record.
- When a rule moves into the file, its memory record is retired with the reason "moved into the
  owner policy". A new standing rule gets no separate lesson.
- One writer does not make the file and its record one transaction, so the action writes the
  record first and then replaces the file atomically (temporary file and rename).
  `manage.policy.read` reports when the file's fingerprint differs from the latest record: a hand
  edit, or a stop between the two writes. The next update records the file's current text as its
  base before replacing it.

## Work

W38 lands first: the policy record's provenance is the owner message as a stored original.

| #     | What changes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Done when                                                                                                                                                                                                                                                                                                                                                                           |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| W37.1 | `manage.policy.read` returns the policy text and its fingerprint. `manage.policy.update({text, fingerprint, reason})` writes the revision record, then replaces the file by rename. It is refused outside an owner chat turn (`ownerSpeaking`, `runtime/owner-authority.ts`, owner decision 2026-10-01) and when the fingerprint differs, because the owner edits the file by hand. `guardOwnerRules` protects the revision records as above. The `corrections` help topic (`runtime/owner-system-prompt.ts:161`) says: a correction that always applies goes to `manage.policy.update`, one that fits a situation to `memory.save`. Remove the call shapes #416 put into that topic and #415/#426 put into the daily procedure; keep the daily path and type. A wiki publish without `type` is refused instead of filed as `entity` | Tests under a temporary `$HOME`: refused in record, report and replay turns and for a subagent; refused on a stale fingerprint; `memory.save` with `replaces` and `memory.retire` on a revision record refused outside the action; an update changes the next session's policy layer; the record chain gives each text with its source message; a publish without `type` is refused |
| W37.2 | Merge in the testbed: the owner asks in Telegram; the agent moves standing rules into the file in one update and retires the moved records with their reason                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | `manage.policy.read` reports no mismatch; one revision record with an owner-chat source; one retirement per moved rule; every owner rule the index delivers today to record or report turns is either in the file or still active in memory; `daemon.log` is clean; the owner accepts the file                                                                                      |
| W37.3 | Live: each turn kind runs in a session opened with the moved rule                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | The session transcript shows the policy layer with the moved rule for owner message, notify, record, report, reminder and daily turns, including a session opened after the update                                                                                                                                                                                                  |
| W37.4 | Relocate, then delete. First the full-report procedure stops saying the owner's report rules "come with this procedure" (`runtime/owner-system-prompt.ts:146`) and says where situational owner rules are read (`memory.search` for the owner's rules on reports). Then delete the record order's `ownerRuleIndex` and its rule read (`runtime/stimulus-delivery.ts`); `ownerRules` and `ownerRuleLines` (`runtime/owner-runtime.ts`); `ownerRulesBlock` and `guidance.ownerRules` (`runtime/turn-orders.ts`); `helpTopicContext` (`owner-runtime.ts:355`, the `action-surface.ts` option) and the `topicContext` port (`api/help-actions.ts:167`, `:202`); the tests that pin them. Rewrite "When corrections reach the agent" in [corrections-and-learning.md](../../guides/corrections-and-learning.md)                           | Lines deleted and added are counted in the PR; typecheck, lint and the standalone suite run from inside the package                                                                                                                                                                                                                                                                 |

Open (owner's call): the record order's lesson recall, also added in #414. Kagemusha has none on
reconcile turns. Here 8 of 108 record turns carried any lesson, and in 27 of the 32 notify turns
that had lessons, the record turn that followed received none. Removing it leaves record turns no pushed route for situational rules; they would read them with `memory.search`. Recommendation: remove it in W37.4.

Measure after: sessions opened per day. Whether turns follow a moved rule is model behavior: it is
observed, and it is not a done condition.
