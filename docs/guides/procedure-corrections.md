# Persistent procedure corrections

MAMA exposes the same scoped procedure catalog to chat, report, and event execution. The agent
chooses relevant guidance by its purpose, applicability, and exclusions. A saved procedure does
not grant new access or require every request to follow that procedure.

For example, an instruction about report layout should change reports while leaving ordinary
conversation outside its scope. Owners can correct an existing procedure; the runtime preserves
the original instruction, immutable revisions, evidence references, and the authorized scope.
Repeated work outcomes can also inform a correction. Recording an outcome alone does not prove
that learning occurred: the next relevant task must show the changed behavior.

## Tools

| Tool                | Purpose                                                                                      |
| ------------------- | -------------------------------------------------------------------------------------------- |
| `procedure_list`    | Discover procedures visible to the current authenticated scope.                              |
| `procedure_read`    | Read the complete instruction, current revision, and observations.                           |
| `procedure_update`  | Create with `expected_revision: 0`, or correct the same ID using its current revision.       |
| `procedure_retire`  | Withdraw the specified current revision.                                                     |
| `procedure_observe` | Record evidence and an assessed outcome, including failed, unknown, no-op, or not performed. |

The host supplies principal, project, channel, original stimulus, and retry identity. A tool
argument cannot widen these boundaries. Updating an existing channel-scoped procedure preserves
that channel restriction. An agent's satisfaction assessment is not independent verification.

## Existing operating briefs

Read `procedure_read({id: "owner-console-brief"})` before a targeted correction. It returns the
exact text and `hash`. For a legacy file that has not been imported, revision `0` is a read-only
snapshot: reading does not rewrite the file or create a database revision.

Use `console_brief_update` with `operation: "replace"` or `"retire"`, one exact rule or section
as `target`, and the returned `expected_hash`. A replacement also supplies `replacement`.
The existing `{lesson}` append form remains available for new lessons. Unrelated instructions
and the previous whole document are retained. Whole-document replacement and ambiguous or
partial-rule targets are rejected.

Canonical revisions live in the existing `operator/triggers.db`. The Markdown brief is a
projection. The runtime distinguishes a committed correction from a published projection and
recovers an interrupted publication. If a human edited the file concurrently, the runtime reports
a conflict and preserves that edit; do not treat the conflict as applied behavior.

## Queued work and restart

Existing trigger snapshots retain their original evidence and are imported lazily within their
authorized channel. Pending work rechecks the active revision after admission to the execution
lane. A started run retains its selected revision, but explicit retirement or loss of access is
checked again before a business mutation. Missing or unavailable guidance is identified rather
than silently replaced with another procedure.

A corrected procedure does not re-open the backend thread. The next turn of a live thread is
told the new revision as a hint; a fresh or re-opened thread is told the procedures most
related to its first message. Installation, model replacement, real transport delivery, and
actual artifact quality still need their own verification; tool success is not a substitute.

## Procedure hints per thread (local candidate)

The first prompt of a run carries `<procedure_hints>` once the backend has said whether the
thread is live. A fresh or re-opened thread gets at most three procedures ranked by the current
message (about 1,200 characters) plus the catalog size; a live thread gets only what it has not
been told: new ids, new revisions, or a counted procedure that now looks relevant (about 600
characters). Nothing is repeated to the same thread. `procedure_list` reaches the rest and
`procedure_read` the body. The daemon log records `[experience] thread= fresh= hints= chars=`
per first turn; this shape is reused from the Kagemusha loop's same-session memory hints.

Installed skill descriptions live in the system prompt, with source paths for the owner, and are
not re-sent per turn. Keyword coincidence no longer injects a complete skill as a conversation
instruction. Owners can also page skills with `experience_read({kind: "skills", offset: 0,
limit: 20})`, then read the applicable original.

`experience_read({tool_name: "code_act"})` lists execution metadata. Use a returned `trace_id`
to read the stored input/result JSON progressively: `offset` and `chars` count Unicode code points;
`next_offset` indicates remaining content. Listing metadata does not expose the full payload.
The host supplies owner/project scope, with member channel restrictions where applicable.

Evidence includes hashes and a completeness marker. Credential-bearing, oversized, or
unserializable payloads are explicitly unavailable rather than silently truncated into misleading
evidence. A failed call and a later successful call are observations for the agent to compare,
not an automatically generated solution. Reading past evidence does not recursively save that
payload as another experience. Recent traces are not listed in the prompt; each tool result
carries its own `experience_ref`, and `experience_read` lists scoped runs on demand.

The existing procedure tools let the agent retain, correct or retire reusable guidance from those
observations. Scheduled execution may save procedural learning within existing authority;
membership and access-grant changes remain separately controlled. This capability is not proof
that the agent learned or that report latency improved: verify the next real task and its artifact.

## Where an owner correction goes (2026-09-09)

An owner correction of how the agent works (tone, length, what to check, what to skip) is stored
with `procedure_update` in the turn it arrives, scoped by `when_to_use` / `when_not_to_use`.
`console_brief_update` no longer appends dated lesson lines: it only replaces or retires one exact
rule of the operating brief with `expected_hash`. The persona, SOUL/IDENTITY/USER files, the
per-turn policy/lesson block and the turn observer are no longer injected or written; what data,
tools and stored procedures cannot supply is the only standing text (Code-Act discovery, the
Telegram format guide, the owner runtime rules). A final answer that claims a correction, save,
update or send without a completed durable-write tool in the same run is logged as
`[evidence] completion claim without a durable write`; it is observed, never blocked.
