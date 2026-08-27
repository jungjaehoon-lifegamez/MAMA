# MAMA One-Front Team Work Agent

**Status:** Approved product direction; implementation incomplete
**Date:** 2026-08-26
**Scope:** Product identity, v1 team boundary, and the contract that later implementation plans must preserve

## North Star

> MAMA is the work agent behind the messenger. A human team sends requests and real files to one
> MAMA. MAMA remembers the work as a scoped Case, composes the required domain capabilities, and
> returns verified artifacts to the people who are allowed to receive them.

MAMA is one user-facing identity. It may use multiple models, processes, tools, or independent
reviewers internally, but the user does not select or coordinate them. MAMA owns the execution
contract and the final explanation.

## Why this design exists

Real work rarely belongs to one named role or one fixed workflow.

- A feedback PDF may need extraction, Korean translation, comparison with a current asset,
  spreadsheet generation, and Telegram delivery.
- A revised Blender or Spine asset may need lineage recovery, scene inspection, bounded mutation,
  preview, export, and an audit against the original purpose.
- The same Case may continue when another human uploads a new revision or asks whether the previous
  feedback was fully addressed.

Making the user choose a `translator`, `reviewer`, `developer`, or `team lead` exposes an internal
implementation decision and makes the human responsible for orchestration. The user should state
the outcome. MAMA should determine the method.

## Product boundary

### MAMA is

- a messenger-native work agent;
- a local-first, long-running runtime;
- a scoped memory and Work Case system;
- an artifact-aware executor that can inspect, compare, modify, audit, verify, and deliver files;
- one accountable front for a human team;
- a host that composes bounded domain capabilities.

### MAMA is not

- a replacement for Telegram, Slack, Discord, or another messenger;
- a user-facing team of named AI personas;
- an AI organization chart;
- a fixed workflow builder;
- a generic chat UI that requires users to visit another workspace;
- a system where every team member can see all memory or invoke every action;
- a promise that every requested mutation will succeed.

## One front, not one process

```text
Human team
   │
   │ existing messengers + real files
   ▼
MAMA (one identity, one accountable response)
   │
   ├── deterministic tools
   ├── domain runtimes (PDF, spreadsheet, Drive, Blender/Spine, future packages)
   ├── optional read-only or independent review workers
   └── one mutation authority per artifact
   │
   ▼
Verified artifact + receipt + next remembered state
```

One front means one user-facing identity and one final responsibility. It does not prohibit hidden
parallelism. Internal workers are useful only when a task has independent branches, isolated
context, or a genuine independent-review requirement.

The default execution rule is:

1. start with one MAMA run;
2. use deterministic tools before model workers;
3. add internal workers only for independently parallelizable work or independent review;
4. never give two workers concurrent mutation authority over the same artifact;
5. synthesize and verify the result through the MAMA run that owns the Case operation.

## Human team model

The team is made of humans. Each human is a durable principal whose messenger identities are
verified and linked by the host.

```text
principal
  ├── external identities (connector + namespace + upstream user id)
  ├── active/suspended/offboarded lifecycle
  └── grants to scopes and actions
```

Human titles such as designer, marketer, programmer, or team lead are not authorization rules.
Access is expressed as explicit actions over explicit scopes.

Candidate actions:

- `read`
- `request_work`
- `upload_input`
- `propose_change`
- `modify`
- `approve`
- `deliver_external`
- `manage_members`

Candidate scope kinds:

- workspace;
- project;
- Case;
- artifact or artifact family;
- connector source or channel;
- destination.

The exact Phase 2b schema is decided in its implementation design. This product design requires
the following invariant regardless of schema shape:

```text
effective scope
  = authenticated principal grants
  ∩ host-derived connector/source authority
  ∩ active Case/artifact scope
  ∩ role/tool envelope
```

Model or client input may narrow this scope. It may never widen it.

## Work Case

A Work Case is the durable unit connecting requests, files, feedback, decisions, revisions,
verification, and delivery.

```text
Work Case
  ├── purpose and current requested outcome
  ├── participating human principals
  ├── source events and messages
  ├── input artifacts
  ├── feedback and acceptance criteria
  ├── candidate and accepted revisions
  ├── decisions and unresolved blockers
  ├── tool and mutation receipts
  ├── approvals bound to exact revisions
  └── delivery receipts
```

The existing `case_truth` substrate already groups decisions, events, observations, and artifact
sources. Its `case_memberships` table means source membership in a Case, not human authorization.
Human access must remain a separate principal-grant contract. Reusing the word `membership` must
not blur these two authorities.

This design does not require replacing the existing Case substrate. The Phase 2b and Work Case
plans must define the smallest additive bridge from current Cases to human principals and artifact
operations.

## Artifact contract

Files are not copied into conversational memory. They remain artifacts in a bounded workspace or
domain store.

MAMA remembers:

- stable artifact identity;
- content digest;
- media type and domain kind;
- source and current location;
- parent/base revision;
- producing request, tool run, and principal;
- current state and verification receipts;
- supersession and delivery relationships.

The generic invariant is more important than one global artifact schema. A domain runtime may own
richer state, such as blenderSpine's `CharacterJob`, while MAMA retains enough stable references
and receipts to continue the Case safely.

### Mutation rules

- Inspection and audit are read-only unless the request explicitly authorizes mutation.
- Original files are not overwritten.
- A mutation produces a candidate revision.
- The mutation records the exact base revision.
- Completion rechecks that the base has not been superseded.
- Conflicting results are preserved as candidates or rebased explicitly; they never silently win.
- Approval is bound to an exact revision and invalidated by a later relevant change.
- External delivery requires a destination-authorized receipt.

```text
read-only operations on one Case       may run in parallel
mutations of unrelated artifacts       may run in parallel
mutations of the same artifact lineage serialize
final publish/delivery                  has one authority
```

## Memory contract

MAMA has one memory system, not one visibility domain.

```text
workspace shared
project/Case shared
member private
owner private
```

Context compilation intersects the requester's effective scope with the Case scope before any
memory, source event, or artifact-derived evidence reaches the model. Candidate search results are
re-authorized before delivery to the model or user.

MAMA should remember durable instructions, decisions, artifact lineage, unresolved work, and
verification outcomes. It should not repeatedly place whole files or unrelated chat history into
the model context.

Grant or membership changes must affect the next call. Revocation invalidates affected cached
context and durable model-session policy. A multi-node invalidation bus is not required for the
current single-daemon product.

## Domain capabilities

Domain runtimes are capabilities, not user-facing agents.

Examples:

```text
PDF/feedback
  extract → translate → compare → structure → workbook → verify

blenderSpine
  inspect files → open CharacterJob → analyze → propose → compile/rebind
  → preview → export → verify package

delivery
  reserve occurrence → transmit → read local receipt → confirm Case effect
```

MAMA chooses the composition. Host code provides bounded tools, trusted identity, file authority,
idempotency, and receipts. Domain tools must return structured evidence rather than success prose.

Specialized visual tools may provide a domain UI. Blender's Guided Workspace is an artifact review
and approval surface, not a second agent front. Messenger remains the default place to request
work, receive status, approve simple decisions, and receive final files.

## Work lifecycle

```text
authenticated request + inbound files
        │
        ▼
resolve principal and candidate Case
        │
        ├── confident match ──────────────┐
        └── ambiguous → ask once          │
                                           ▼
compile purpose, artifact refs, grants, and current Case state
        │
        ▼
inspect / compare / decide
        │
        ├── read-only result → verify → deliver
        ├── mutation allowed → new revision → verify → approval/deliver
        └── authority or evidence missing → explicit blocker
        │
        ▼
commit receipts, Case state, and durable memory
```

The host does not hard-code every domain workflow. Skills and tool descriptions guide composition;
deterministic lifecycle rules protect identity, files, mutation, approval, and delivery.

## Notifications

MAMA does not broadcast every event to every member.

- completion goes to the requester;
- a shared Case update goes to its subscribed/participating members;
- approval requests go only to principals with the matching action grant;
- failures and conflicts go to the requester and any required approver;
- final artifacts go only to an authorized destination.

Notification preference is not authorization. A muted member may still retain access, and a
notified member does not gain access.

## Current implementation foundations

The following are shipped foundations, not proof that the v1 team product is complete:

- sender authentication and isolated public lanes;
- durable owner/member principals and external identities;
- local Case-first memory substrate;
- connector event indexing and provenance;
- owner-event intake handled by MAMA itself;
- durable workorders and structured model/tool traces;
- external effect and delivery receipts;
- Code-Act domain tool composition;
- bounded private media and workspace paths;
- one healthy single-daemon deployment model.

## Missing contracts

The v1 team product remains incomplete until plans and E2E evidence cover:

1. principal scope grants and server-computed effective scope;
2. member-private and shared source grants;
3. requester/case/artifact/action authorization;
4. immediate grant and revocation reflection;
5. artifact version, mutation, approval, and delivery binding across at least one domain runtime;
6. concurrent human requests and stale-base conflict handling;
7. team-safe context compilation and result re-authorization;
8. requester, executor, approver, and delivery attribution;
9. real messenger E2E across a human team;
10. a pilot demonstrating repeated multi-person use.

## Compatibility surfaces awaiting migration

Some shipped prompts and configuration files still describe the former user-facing agent-team
experiment. They are compatibility surfaces, not product authority:

- `packages/standalone/src/onboarding/complete-autonomous-prompt.ts` still offers named
  Conductor/Developer/Reviewer/Architect/PM personas and retired orchestration choices;
- `packages/standalone/src/agent/os-agent-capabilities.md` still carries older capability language;
- legacy multi-agent configuration remains available for existing installations even though it is
  not the v1 interaction model.

Their eventual migration must remove contradictory user promises without deleting reusable
internal execution mechanisms. This documentation alignment does not authorize that code change.

## Roadmap alignment

### Current release line

The current runtime-overhead remediation release and real-event canary are complete. v1 Phase 2b
is implemented and reviewed in PR #240, but merge, patch release, install, restart validation, and
a real human-member canary remain. Do not infer the complete v1 team product from code/test evidence
alone.

### v1 Phase 2b: access foundation

- Follow the reviewed
  [human-team access plan](2026-08-26-phase2b-human-team-access-plan.md).
- `principal_scope_grants` or an equivalent explicit grant authority;
- server-computed effective scope;
- member-private and source grants;
- next-call grant/revocation behavior;
- member-range E2E across supported messenger identities;
- no user-facing agent selection.

### Following v1 slices

- bridge current Case memory to human principals and Work Case operations;
- shared knowledge with explicit sharing, revocation, and unshare;
- revision-bound approvals and scoped notifications;
- one domain pilot that exchanges real files through a messenger;
- repeated human-team use and migration rehearsal before v1.0.

The implementation sequence must be reviewed separately. This product design does not authorize
new schemas, services, timers, queues, or infrastructure beyond what a concrete contract requires.

## Explicitly not in scope

- a new chat or collaboration application;
- Redis or multi-node deployment for the current single-daemon product;
- WebSocket team presence or typing;
- user-facing AI personas or an agent directory;
- exposing internal delegation or model selection;
- a generic workflow builder;
- two concurrent writers to the same artifact lineage;
- replacing mature domain state such as blenderSpine's `CharacterJob` with a generic MAMA copy;
- multi-organization tenancy before the single-owner workspace model is proven with human members.

## Documentation authority

For product direction, this document supersedes the former complete identity of MAMA as only an
owner-operator report system. Historical plans and archived multi-agent guides remain useful for
implementation history but do not define the v1 product.

Documentation layers should derive from this source:

```text
this design (normative product contract)
  ├── README and website (short product promise + honest current status)
  ├── vision and explanation docs (conceptual model)
  ├── Phase 2b implementation plan (data flow, schema, tests)
  └── guides/reference (only shipped behavior)
```

If shipped behavior differs, reference documentation follows code and labels the missing design
contract explicitly. Marketing must not present a planned v1 contract as already available.

## Success criteria

The direction is implemented, not merely documented, when a real human team can:

1. contact one MAMA through existing messengers;
2. submit files and requests into a shared Case;
3. continue work from another authorized human identity;
4. keep owner-private and member-private context isolated;
5. inspect, modify, audit, approve, and deliver a versioned artifact through at least one domain;
6. observe exact attribution and receipts without seeing internal worker orchestration;
7. revoke a grant and prove the next request cannot read or act beyond the new scope.
