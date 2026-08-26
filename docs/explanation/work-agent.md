# The Work Agent Behind Your Messenger

MAMA is one work agent that lives behind the messengers a human team already uses. People send
requests and real files. MAMA remembers the ongoing Case, uses the required domain tools, and
returns artifacts with evidence.

This is a product boundary, not a claim that one model does everything. MAMA may call deterministic
tools, domain runtimes, or internal workers. The user sees one accountable identity and one final
result.

## The problem

Teams already coordinate work through messages and files:

- a client sends a feedback PDF;
- one teammate asks for a Korean translation and an Excel audit;
- another teammate uploads a revised asset;
- someone asks whether the revision satisfies the feedback;
- a specialist tool modifies the file;
- an authorized person approves and delivers the result.

Today, humans carry the context between every step. They rename files, explain what changed, find
the old feedback, select the next tool, and tell each AI session what happened before.

Named AI teams do not remove this burden when the user must decide which AI role owns each step and
repeat context at every handoff.

## The approach

```text
message + file
     │
     ▼
authenticated human principal
     │
     ▼
MAMA resolves the Work Case and effective scope
     │
     ├── inspect / compare / audit
     ├── create a candidate revision when authorized
     ├── verify with deterministic or domain evidence
     └── request human approval when authority is missing
     │
     ▼
artifact + receipt + remembered Case state
     │
     ▼
authorized messenger destination
```

The user chooses the outcome, not the worker. A request may combine PDF extraction, translation,
spreadsheet generation, Drive access, Blender work, Spine verification, and messenger delivery.
Those are capabilities, not people the user manages.

## One front and optional internal workers

One front means:

- one user-facing MAMA identity;
- one Case owner for the current operation;
- one final explanation;
- one mutation authority per artifact lineage.

It does not mean one process. MAMA may use internal workers when work is genuinely independent or
needs an independent review. Workers return bounded evidence to MAMA and do not take over the user
conversation.

```text
MAMA
  ├── optional read-only analysis worker
  ├── optional independent reviewer
  ├── deterministic tools
  └── one artifact writer
```

This is the manager/agents-as-tools pattern. It preserves internal specialization without turning
the product into an AI organization chart.

## The human team

Humans, not AI personas, form the team. Each human has a durable principal linked to verified
messenger identities.

Permissions answer concrete questions:

- May this person read this project or Case?
- May they upload an input?
- May they ask MAMA to modify an artifact?
- May they approve this exact revision?
- May they send the result to this destination?

Job titles are not authorization rules. The server computes effective scope from principal grants,
the connector/source boundary, the active Case, and the tool envelope.

## Cases and artifacts

A Case connects purpose and history. An artifact is a real file or domain object with stable
identity and lineage.

```text
Case: Character A client feedback
  ├── original source package
  ├── feedback.pdf
  ├── feedback-ko.xlsx
  ├── candidate revision 2
  ├── audit against feedback
  ├── candidate revision 3
  └── approved export + delivery receipt
```

MAMA remembers the relationship, not a repeated copy of every file in every prompt. Files stay in
bounded artifact storage or a domain store. Memory contains durable instructions, decisions,
lineage, blockers, and verification outcomes.

## Domain runtimes

Some work needs a specialist application. That application is a domain runtime, not another
front-facing agent.

- A PDF/spreadsheet runtime can extract, translate, compare, render, and verify documents.
- blenderSpine can inspect a CharacterJob, propose bounded changes, run Blender, preview motion,
  export a package, and return receipts.
- A Drive capability can read or write only within host-authorized destinations.

A domain UI may appear when a human must inspect spatial or visual evidence. Blender's Guided
Workspace is an artifact review surface. Messenger remains the default request, status, approval,
and delivery surface.

## Autonomy and authority

MAMA has method autonomy. It does not have authority autonomy.

MAMA may decide which safe tools to compose. It may not invent permission to mutate, approve,
share, or deliver.

- “Look at this file” is read-only by default.
- “Fix this file” may create a candidate revision when the requester has `modify` authority.
- Approval applies to an exact revision.
- External delivery requires destination authority and a receipt.
- Missing evidence is a blocker, not a success claim.

## Current state and v1 goal

Current MAMA releases provide the owner-first runtime, messenger gateways, local memory, Cases,
principal identities, workorders, Code-Act tools, and effect receipts. They do not yet provide the
complete multi-human Work Case contract described here.

The next access foundation is Phase 2b: principal grants, server-computed effective scope,
member-private/source grants, and immediate grant/revocation behavior. Shared Work Cases, artifact
approval, and a real multi-human file-work pilot build on that boundary.

The normative design is [MAMA One-Front Team Work Agent](../development/2026-08-26-one-front-team-work-agent-design.md).
