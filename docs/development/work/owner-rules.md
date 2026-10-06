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
- What the host attaches differs by turn kind. The policy file goes to every turn. The top three
  recalled lessons go to owner message, delta notify and delta record turns. The rule index goes
  to record orders and comes back from `help('full-report')`. Reminder and daily turns get no
  rule and no index.
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

- The update action is the only writer. Each change is saved as a memory record (kind `decision`,
  topic `owner-policy`) that holds the full new text and the reason. It replaces the previous
  record, and its source is the owner message: the same supersession and provenance a correction
  has in memory (W5).
- When a rule moves into the file, its memory record is retired with the reason "moved into the
  owner policy". A new standing rule gets no separate lesson.
- Reason: with one writer, the file and its history cannot diverge. A rule kept in two places
  would drift, and the agent would see it twice.

## Work

| #     | What changes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Done when                                                                                                                                                                                                                                                        |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| W37.1 | `manage.policy.read` returns the policy text and its fingerprint. `manage.policy.update({text, fingerprint, reason})` replaces the text and saves the revision record. It is refused outside an owner chat turn (`ownerSpeaking`, `runtime/owner-authority.ts`, owner decision 2026-10-01). It is also refused when the fingerprint differs, because the owner edits the file by hand (its first line says so) and an update must not drop that edit. The write is atomic. In the standing prompt's corrections section, a correction that always applies is written with `manage.policy.update`; one that fits a situation is saved with `memory.save`, as now. Backend-agnostic (`ownerSystemLayers`); checked live on Claude only | Tests under a temporary `$HOME`: refused in record, report and replay turns and for a subagent; refused on a stale fingerprint; an update changes the next turn's system layer and opens a new session; the record chain gives each text with its source message |
| W37.2 | Merge in the testbed: the owner asks in Telegram; the agent reads the owner rules, moves the standing ones into the file in one update, merges overlaps with existing lines, retires the moved records with their reason and leaves situational ones in memory                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | The file holds each moved rule once; every retired record names the move; `daemon.log` is clean; the owner reads the file and accepts it                                                                                                                         |
| W37.3 | Live: every turn kind carries a moved rule                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | The owner session's transcript shows the moved rule in the system prompt of owner message, notify, record, report, reminder and daily turns, and in a session opened after the update                                                                            |
| W37.4 | Delete after W37.3: the record order's `ownerRuleIndex` and its rule read (`runtime/stimulus-delivery.ts`); `ownerRules` and `ownerRuleLines` (`runtime/owner-runtime.ts`); `ownerRulesBlock` and `guidance.ownerRules` (`runtime/turn-orders.ts`); `helpTopicContext` (`owner-runtime.ts:355`, the `action-surface.ts` option); the tests that pin them. Rewrite "When corrections reach the agent" in [corrections-and-learning.md](../../guides/corrections-and-learning.md)                                                                                                                                                                                                                                                      | Lines deleted and added are counted in the PR; typecheck, lint and the standalone suite run from inside the package                                                                                                                                              |

Open (owner's call): the record order's lesson recall, also added in #414. Kagemusha has none on
reconcile turns. Here 8 of 108 record turns carried any lesson, and in 27 of the 32 notify turns
that had lessons, the record turn that followed received none. Recommendation: remove it in W37.4.

Measure after: sessions opened per day. Whether turns follow a moved rule is model behavior: it is
observed, and it is not a done condition.
