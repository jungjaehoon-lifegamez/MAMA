# Telegram Outbound Context Inbox Design

**Date:** 2026-08-03

**Status:** Approved direction; implementation pending

**Parity scenarios:** TG-05, TG-06

## Problem

MAMA keeps Telegram user turns in a per-chat model session, but detached operator reports are
generated in the isolated `operator:report` lane and sent directly through Telegram. The full-report
path creates one target-bound carry, while digest delivery intentionally creates none. As a result,
the Telegram user can reply to text that the chat model has never seen.

The role system is outside this phase. The existing conversation boundary remains
`source + channelId`, and Kagemusha stays a configured user-private connector.

## Goals

- Make every final detached Telegram message available to the next turn in the same chat.
- Preserve the isolated, fresh operator-report session and the per-chat user sessions.
- Survive daemon restart and failures between delivery, model execution, and response persistence.
- Reuse the existing target binding, delivery identity, queueing, and carry acknowledgement rules.
- Keep prompt injection bounded while retaining the exact delivered text durably.

## Non-goals

- Per-user owner/admin/member/guest roles or message audiences.
- Per-user private lanes inside one Telegram group.
- Sharing one model session between operator reports and user conversations.
- A general cross-platform event ledger for Discord, Slack, or future gateways.
- Reworking report generation, trigger scheduling, or Telegram delivery semantics.

## Decision

Generalize the current one-record full-report carry into a durable, target-scoped outbound context
inbox. A successful detached Telegram delivery appends one immutable inbox event. The next verified
turn for that exact Telegram chat receives all pending events in delivery order. Events are
acknowledged only after the final assistant response is durably persisted.

This is a bounded phase toward a future conversation-event ledger, not that complete ledger now.

## Data contract

Each inbox event contains:

- schema version;
- `deliveryId`;
- exact Telegram target (`source: telegram`, `channelId`);
- kind (`full`, `digest`, or another final detached message kind);
- delivery timestamp;
- exact delivered text;
- available report provenance when one exists;
- optional consumption timestamp and consuming channel key.

The store rejects reuse of a delivery ID with a different target, kind, text, or provenance. Events
are immutable except for acknowledgement. Existing unconsumed V2 full-report carry is migrated or
read compatibly as one pending `full` event; invalid or unscoped legacy state remains quarantined.

The durable store retains exact text. Prompt projection uses a bounded ordered view with explicit
truncation markers. Initial limits should preserve the most recent events first, cap the combined
projection, and never silently mark a truncated-but-unseen event as fully consumed.

## Data flow

1. The operator composes a prepared report in its existing fresh session.
2. Telegram accepts the target- and payload-bound delivery.
3. After successful send, the host appends the exact delivered artifact to the target inbox.
4. A user message enters the existing per-chat queue.
5. After owner-console verification and before the model call, `MessageRouter` peeks pending inbox
   events for that exact chat and adds a bounded `<recent_outbound_messages>` block to the effective
   user message.
6. The model responds using the visible outbound messages as conversation evidence.
7. `MessageRouter` durably persists the final assistant response.
8. Only then does it acknowledge the exact injected event set.

The peek result therefore carries an ordered list of delivery IDs, not one ID. Acknowledgement must
match the same target, channel key, and complete injected ID set.

## Persistence and restart behavior

- A send failure creates no inbox event.
- A crash after Telegram delivery but before inbox persistence remains the existing narrow delivery
  boundary; production assembly should perform inbox persistence immediately after confirmed send.
- A crash after inbox persistence leaves the events pending for the next turn.
- A model or tool failure leaves the events pending.
- Failure to persist the assistant response leaves the events pending.
- Replaying an already delivered report with the same identity is idempotent and creates no duplicate
  event.
- A new backend session receives pending events through the same next-turn path; it does not depend
  on resuming the old Claude, Codex, or Cline session.

Consumed outbound events must also be represented in durable conversation history used by fresh
session startup, or the startup builder must read the inbox history directly. The implementation
must choose one authoritative read path and prevent the same event from appearing twice.

## Security boundary

- Inbox lookup occurs only after the existing Telegram owner-console trust check.
- Target equality is exact; one chat cannot peek or acknowledge another chat's events.
- Outbound text is wrapped as untrusted historical content, never as instructions or tool authority.
- Inbox contents do not grant tools, connectors, roles, or mutation authority.
- Kagemusha metadata remains available only through the existing private connector policy.

## Error handling

Invalid state fails closed and is not injected. Conflicting delivery identity is an explicit error.
Acknowledgement mismatch leaves all affected events pending. Pruning may remove only acknowledged or
expired records; it must not silently discard active unseen messages.

## Verification

The implementation is complete when focused tests prove:

- **TG-05:** a continued Telegram session receives a newly delivered digest once, without rebuilding
  the full startup prompt.
- **TG-05:** a replacement backend session receives the same pending digest once through bounded
  restoration.
- **TG-06:** full and digest deliveries use the same target-scoped inbox boundary.
- **TG-06:** send rejection, model failure, and assistant persistence failure do not falsely consume
  context.
- Delivery order is preserved for multiple pending messages.
- Duplicate delivery IDs are idempotent only for identical content and target.
- A different Telegram chat, a Telegram group without owner trust, and a non-Telegram turn cannot
  peek or consume owner inbox events.
- Multimodal Telegram turns receive the same outbound context block.
- Restart and concurrent writer tests preserve every confirmed pending event.
- Existing full-report carry compatibility and quarantine tests remain green.

An operational acceptance test sends a detached digest containing a distinctive statement, then asks
an elliptical follow-up such as “왜 그렇게 말했지?” in the same Telegram chat. The response must
identify the delivered statement without inventing missing context, and the following turn must not
receive the same inbox event again.

## Deferred phase

A later authorization phase may add principal IDs, role/audience labels, private group lanes, and
cross-platform projections on top of this target-scoped event shape. None of those fields are needed
to repair the current single-owner Telegram continuity gap.
