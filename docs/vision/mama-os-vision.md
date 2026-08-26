# MAMA OS Vision

## The work agent behind your messenger

MAMA is one local, always-on work agent for a human team. People contact it through the messengers
they already use, attach the real files, and state the result they need. MAMA remembers the ongoing
Case, uses the required domain capabilities, and returns verified artifacts.

> Humans describe the work. MAMA decides how to execute it. Internal coordination is not a task
> the user should have to perform.

## The problem

Work is split across messages, files, tools, and time.

- Feedback arrives in a PDF.
- The current asset lives in Drive or a Blender project.
- A teammate remembers which revision was sent.
- Another teammate knows what the client meant.
- A model can inspect one piece, but the next session starts from zero.
- The human carries files and context between every tool.

Adding a visible team of named AI personas often moves the coordination burden rather than removing
it. The human must decide which agent owns the work, transfer context at every handoff, and resolve
conflicting answers.

The real missing system is one accountable worker that can continue the same Case across people,
messages, files, and domain tools.

## The product promise

```text
message + actual files
        ↓
MAMA remembers the purpose, Case, people, and artifact lineage
        ↓
MAMA inspects, compares, modifies, audits, verifies, or delivers
        ↓
verified artifact + receipt + remembered next state
```

Examples:

- Read a client feedback PDF, translate it into Korean, turn the requirements into an Excel audit,
  compare them with the latest received file, and send the results through Telegram.
- Open a character asset through blenderSpine, inspect the actual CharacterJob, make an authorized
  candidate revision, verify the preview and export, and return the files with evidence.
- Continue a Case when another authorized human uploads the next revision or asks whether every
  feedback item was resolved.

## One MAMA

The product exposes one MAMA identity.

Internally, MAMA may use:

- deterministic tools;
- provider models;
- domain runtimes;
- read-only parallel workers;
- an independent reviewer;
- background workorders.

Those are implementation details. The user does not select a translator, developer, reviewer, or
team lead. MAMA owns the final answer, the artifact state, and the truthful report of what did or
did not complete.

```text
one user-facing MAMA
one Case owner for the operation
one writer per artifact lineage
many optional internal workers
one verified result
```

## The team is human

Each human has a durable principal linked to verified messenger identities. The owner grants
access to concrete work, not AI personas.

Permissions answer:

- Which projects and Cases may this person read?
- Which inputs may they upload?
- Which artifacts may they ask MAMA to modify?
- Which exact revisions may they approve?
- Which destinations may receive the result?

Shared work and private memory remain distinct. A member who can inspect a shared Case does not gain
access to the owner's private record or another member's direct messages.

## Work Cases and artifacts

A Work Case is the durable thread of purpose:

- requests and source messages;
- input files and feedback;
- artifact revisions and lineage;
- decisions and unresolved blockers;
- inspection, mutation, and verification receipts;
- revision-bound approvals;
- final delivery.

MAMA does not place every file into model memory. Files remain in bounded artifact storage or a
domain store. MAMA remembers stable references, digests, purpose, lineage, decisions, and evidence.

The existing Case-first memory substrate already groups decisions, events, observations, and
artifact sources. Human authorization is a separate principal-grant boundary and must not be
conflated with source membership in a Case.

## Domain runtimes

MAMA does not need to reimplement every professional tool.

Domain runtimes provide bounded capabilities:

```text
PDF/spreadsheet    extract · translate · compare · render · verify
Drive              find · download · upload within host authority
blenderSpine       inspect · propose · compile · preview · export · verify
future domains     expose the same artifact-and-receipt contract
```

A domain UI appears only when the artifact requires human visual or spatial judgment. Blender's
Guided Workspace is an example. It is not a second agent front. Messenger remains the normal place
to request work, receive progress, make simple approvals, and receive final artifacts.

## Memory changes the worker

Memory gives MAMA continuity across tasks and people.

- It knows which feedback belongs to which revision.
- It knows why the team accepted or rejected a change.
- It remembers recurring delivery formats and project rules.
- It can distinguish a current decision from a superseded one.
- It can continue from another authorized member's request without exposing private context.

Memory remains local-first and model-provider independent. Selected prompts and compiled context
may go to the configured model provider, but the durable record remains under the operator's
control.

## Autonomy with authority boundaries

MAMA chooses the execution method. Humans and host policy control authority.

- Inspection and audit are read-only by default.
- Mutation requires explicit intent and requester authority.
- Mutation creates a new revision rather than overwriting the source.
- Two workers do not write the same artifact lineage concurrently.
- Approval is bound to an exact revision.
- External delivery requires an authorized destination and receipt.
- Missing evidence produces a blocker, not a success claim.

## Why messenger-first

Messenger already supplies the essential front-end primitives:

- describe a goal;
- attach a file;
- answer a clarification;
- receive progress;
- approve a decision;
- receive the result.

MAMA does not need to become another chat product. Complexity belongs in the runtime and domain
tools. The front should expose work state and evidence, not an AI organization chart.

The Viewer remains an operator and inspection surface for board, tasks, memory, connectors,
runtime status, and logs. It is not the primary place a team must visit to delegate work.

## What is shipped

Current releases already provide important foundations:

- messenger gateways and sender boundaries;
- an owner-first MAMA runtime;
- local memory and Case-first state;
- durable owner/member principals and external identities;
- connector event provenance;
- workorders, model/tool traces, and external-effect receipts;
- bounded Code-Act composition and private media paths;
- one supervised single-daemon deployment.

These foundations do not prove the full human-team product.

## What v1 still requires

1. principal scope grants and server-computed effective scope;
2. member-private and source grants;
3. immediate grant/revocation behavior;
4. team-safe context compilation and result re-authorization;
5. Work Case binding for principals, artifacts, actions, approvals, and deliveries;
6. stale-base conflict handling for concurrent human requests;
7. one real domain pilot exchanging and continuing actual files through a messenger;
8. repeated multi-person use before the v1.0 claim.

## What we deliberately do not build

- a replacement messenger;
- user-facing named AI teams;
- an agent marketplace or organization chart;
- a generic workflow designer;
- Redis, presence, typing, or multi-node infrastructure before a measured need;
- a generic replacement for mature domain state;
- multi-organization tenancy before the one-owner human-team model works.

## The one-line vision

**MAMA is the work agent behind your messenger: one accountable front that remembers the Case and
finishes real artifact work for a human team.**

See the normative [One-Front Team Work Agent design](../development/2026-08-26-one-front-team-work-agent-design.md).
