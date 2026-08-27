# v1 Phase 2b: Human-Team Access Foundation

**Status:** Reviewed plan; implementation starts after the completed v0.39.2 runtime-overhead release and monitor cleanup
**Date:** 2026-08-26
**Depends on:** completed v0.39.2 runtime-overhead release and monitor cleanup; shipped Phase 1 sender boundary; shipped Phase 2a principal registry
**Product authority:** [MAMA One-Front Team Work Agent](2026-08-26-one-front-team-work-agent-design.md)

## Goal

Allow an active human member to contact the same MAMA through a verified messenger identity, use
their own private scope, and receive only shared source or memory context explicitly granted to
that principal. The server, not the model or client, computes effective scope. A grant or
revocation affects the next call and any durable model session that would otherwise retain stale
context.

Phase 2b is an access foundation. It does not expose named AI agents, create a collaboration UI,
or implement generic artifact mutation and approval.

## Existing foundations to reuse

| Existing component                                     | Reuse                                                                 |
| ------------------------------------------------------ | --------------------------------------------------------------------- |
| `principals` and `external_identities` (migration 064) | Human identity and lifecycle authority                                |
| `PrincipalRepository`                                  | Extend with grant reads/writes; do not create a second identity store |
| `PrincipalContext` and connector-specific resolution   | Overlay active member identity before lane admission                  |
| `memory_scopes` and `memory_scope_bindings`            | Existing memory storage boundary                                      |
| `ChannelGrant` and `channelGrantClause`                | One raw-event visibility rule in boolean and SQL form                 |
| `liveBoundaryChannels()`                               | Pattern for fresh, fail-closed authority reads                        |
| `narrowGrantToEnvelope()` and `mirrorReadScopes()`     | Existing source-to-memory read narrowing                              |
| envelope authority/enforcer                            | Final tool and destination ceiling                                    |
| context compile                                        | Scoped evidence selection and provenance                              |
| durable session policy fingerprint                     | Rotate a session when effective authority changes                     |
| P2a connector E2E matrix                               | Extend rather than create connector-specific member paths             |

The current `case_memberships` table is not human authorization. It records which decision, event,
observation, or artifact source belongs to a Case. Phase 2b must not overload it.

## Scope

### Required

- durable `principal_scope_grants` authority;
- stable member-private memory scope derived from the active principal;
- explicit grants for shared or additional connector/channel sources;
- server-computed effective source and memory scope;
- caller input may narrow, never widen;
- one fresh grant evaluation for each user turn or durable workorder;
- grant-policy fingerprint in durable model-session compatibility;
- immediate grant/revocation behavior on the next request;
- result-level re-authorization for memory and raw connector evidence;
- Telegram, Slack, and Discord member-range E2E;
- owner path remains compatible and singular.

### Not in scope

- user-facing named AI personas or an agent selector;
- agent principals;
- Work Case artifact mutation, approval, or delivery grants;
- a new chat UI;
- Redis, WebSocket presence, or multi-node invalidation;
- grant caching;
- organization/tenant hierarchy;
- more than one owner;
- rewriting the Case-first substrate;
- fixed domain workflows.

## Complexity and overhead budget

Phase 2b adds one durable grant authority and one pure effective-scope resolver. It must not add a
worker, queue, timer, cache, invalidation service, model review, or per-tool database lookup.

- read grants once at turn/workorder ingress;
- reuse one immutable snapshot throughout that operation;
- enforce with the existing query, context, envelope, and delivery boundaries;
- perform no model call solely to decide authorization;
- measure added ingress latency and query count before release;
- remove a new check when an existing boundary already proves the same invariant.

The expected steady-state cost is one bounded local SQLite grant read plus pure intersection work
per user turn or workorder. Any implementation that requires more must return to plan review with
measured evidence.

## Authority model

```text
verified connector identity
        │
        ▼
active principal row ── derived self scope ──┐
        │                                    │
        ▼                                    │
fresh shared-source grants ───┐              │
        │                     │              │
configured connector grant   │              │
        │                     │              │
verified request binding ────┴──────────────┘
                       │
                       ▼
        server-computed effective scope
                   │
        ┌──────────┼───────────┐
        ▼          ▼           ▼
   raw events   memory     tool envelope
                   │
                   ▼
       result-boundary authorization
```

The shared effective scope is an intersection. An empty or malformed grant grants no shared
source. A missing, suspended, or revoked principal is denied entirely. There is no fallback to the
configured owner's channels and no “empty means all” rule.

## Grant storage design gate

The implementation review must choose the smallest schema that represents the Phase 2b grants
without prebuilding later artifact/action authorization.

Minimum semantic fields:

- principal identity;
- grant kind (connector/channel source or shared memory scope);
- canonical scope reference;
- granting owner;
- created and revoked timestamps;
- uniqueness/idempotency for one active logical grant.

Do not add generic ACL expressions, role inheritance, deny rows, group nesting, organization
tables, or a policy language in Phase 2b. Later actions can use a separate additive contract after
the read boundary is proven.

## Member-private memory

Each active member has one stable user memory scope derived from the principal ID. Activation is
the authority to use that self scope; no second grant row is required. Only that principal may
read it by default. Owner access, support access, or administrative export requires a separate
explicit policy or grant; ownership alone must not silently pierce a private scope. A connector
display name or upstream user ID is not the scope authority.

Team-shared/project scopes are explicitly granted. The mere existence of a shared messenger channel
does not grant owner-private, another member's private, or unrelated project memory.

```text
member effective memory
  = own member-private scope
  + explicitly granted shared/project/channel memory scopes
  - everything outside current source/envelope authority
```

## Source grants

Source grants use the same connector/channel identity consumed by `ChannelGrant`. Connector
configuration remains the outer ceiling. A principal grant cannot enable a connector or channel
the owner did not configure.

```text
effective source channels
  = (verified current request source
  ∪ (configured shared sources ∩ principal source grants))
  ∩ current envelope/request narrowing
```

For a direct message, the requester's verified current channel binding is intrinsic to that
request; no duplicate source-grant row is required. A member does not gain sibling channels of the
same connector. Shared channels and other connector sources require explicit grants.

## One-turn authority snapshot

One user turn or durable workorder takes one detached grant snapshot and uses it consistently for:

- source reads;
- memory scope derivation;
- context compilation;
- envelope checks;
- provenance and citation filtering;
- activity logging.

Every tool call and result boundary inside that operation uses the same snapshot. The next turn or
workorder reads fresh authority. This avoids repeated grant queries, prevents one operation from
observing two policies, and guarantees next-request revocation without Redis.

## Durable session compatibility

Messenger session keys remain stable across principal metadata changes. Authority is not encoded
only in the session key.

The sorted effective-grant identity participates in the model-session policy fingerprint:

```text
same grants     → continue the durable backend session
changed grants  → reject/replace the stale backend session once
next unchanged turn → continue the replacement without thrash
```

The replacement rebuild includes only currently authorized bounded history and context. Revoked
sources are excluded before prompt construction.

## Result-boundary authorization

Applying a scope to the initial query is necessary but insufficient. Every memory/raw reference
returned to the model or user is checked once at the common result boundary against the same
effective snapshot before delivery. Individual callers must not add parallel authorization
implementations.

This closes stale index rows, linked graph edges, Case rollups, and provenance paths that could
otherwise pull an out-of-scope source back into a granted result.

## Implementation sequence

### TDD execution order

The numbered sections describe dependency ownership, but strict implementation order is
`Task 1 repository RED/GREEN → Task 2 resolver RED/GREEN → Task 0 full matrix RED → Tasks 3–4
GREEN → Task 5 E2E`. Before Tasks 1–2 there is no real grant/revoke or effective-scope input seam,
so forcing the full Task 0 matrix first would produce missing-method/import failures instead of
observable authorization failures. Tasks 1 and 2 must each start with focused failing tests; the
full matrix then uses those real inputs and remains RED for the still-missing ingress, session, and
shared enforcement wiring.

### Task 0: RED acceptance matrix

Extend the P2a E2E matrix before production code:

- active member with zero shared/source grants sees only the verified current conversation and
  their own private scope;
- one source grant admits only that exact source;
- own private scope is readable; another member's private scope is denied;
- model/client-requested widening is denied;
- owner grant creates access on the next request;
- revoke removes access on the next request;
- revoke rotates stale backend policy exactly once;
- owner behavior is unchanged;
- connector identity isolation remains intact.

### Task 1: Add durable grant repository

- one additive mama-core migration after 064;
- repository methods for idempotent grant, revoke, and fresh listing;
- only active member principals can receive member grants;
- only the owner path can mutate grants;
- suspension/offboarding makes every grant ineffective without requiring row deletion;
- no member-controlled identity or scope string reaches a write directly.

### Task 2: Compute effective scope in one host service

Create one pure resolver that accepts:

- active principal;
- current connector/lane/channel facts;
- configured `ChannelGrant`;
- fresh principal grants;
- current envelope/request narrowing.

It returns the effective raw channel grant, memory scopes, and a stable fingerprint. It runs once
at turn/workorder ingress; callers consume the detached value rather than requerying grants or
restating intersections.

### Task 3: Wire ingress and durable-session compatibility

- active members enter one internal member execution policy with their derived self scope, not a
  named persona;
- unregistered, suspended, offboarded, and external senders keep the current safe behavior;
- durable session policy includes the effective-grant fingerprint;
- replacement history is filtered to currently authorized member-visible turns;
- the owner path remains separate and unchanged.

### Task 4: Reuse the enforcement and context boundaries

- feed effective channels into the existing `ChannelGrant` rule;
- derive memory scopes through the existing memory-scope/envelope path;
- make context compile consume the detached snapshot;
- re-authorize the result batch once at the shared model/user delivery boundary;
- ensure write tools never inherit read-only mirrors or ungranted scopes;
- log scope mismatch without logging private content.

### Task 5: Connector and member-range E2E

For Telegram, Slack, and Discord:

1. owner authenticates, registers, and activates the member through existing P2a authority;
2. the active member receives only their derived private scope and verified current conversation;
3. owner grants one shared source;
4. member asks one real-shaped read request;
5. model/context sees only granted evidence;
6. an ungranted-source request fails before an unsafe tool read;
7. owner revokes the source;
8. the next request cannot read it and stale session context does not restore it;
9. another member cannot read the first member's private scope.

Use real repository implementations and current gateway callbacks. Do not mock the identity,
effective-scope, or final enforcement seam independently in the completion E2E.

## Failure modes and required evidence

| Failure                                  | Required behavior                                        | Test level               |
| ---------------------------------------- | -------------------------------------------------------- | ------------------------ |
| Grant DB unavailable                     | Deny member scope; owner runtime remains diagnosable     | integration              |
| Empty/malformed grant                    | Read nothing; never interpret as wildcard                | unit + differential      |
| Connector removed from config            | Fresh effective scope drops it                           | integration              |
| Grant revoked during an operation        | Current operation keeps one snapshot; next turn denies   | concurrency integration  |
| Stale model session retains source       | Fingerprint mismatch replaces once with filtered history | backend E2E              |
| Search/graph links to revoked source     | Result re-authorization removes it                       | integration              |
| Suspended/offboarded principal           | No effective grants                                      | repository + gateway E2E |
| Member asks for write through read grant | Envelope/tool enforcer denies                            | executor integration     |
| Two simultaneous grant mutations         | Transaction preserves one active logical grant           | repository concurrency   |

## Verification gates

- focused principal/grant repository tests;
- effective-scope unit and boolean/SQL differential tests;
- context compile and provenance visibility tests;
- envelope read/write differential tests;
- backend durable-session replacement tests;
- ingress query-count and latency comparison proving one grant read and no model-only validation;
- complete Telegram/Slack/Discord member E2E matrix;
- standalone typecheck, build, lint, changed-file format, and relevant full test gate;
- code review, CI, and PR comments resolved before merge;
- patch release, global install, single launchd restart;
- real human-member messenger canary before Phase 2b is called shipped.

## Completion definition

Phase 2b is complete only when two verified human principals can contact one MAMA and the member:

- sees granted shared/source context;
- sees their own private memory;
- cannot see owner-private, another member's private, or ungranted source context;
- cannot widen scope through prompt, tool arguments, linked results, or stale session history;
- loses revoked access on the next request;
- receives one MAMA response without selecting a named AI agent.
