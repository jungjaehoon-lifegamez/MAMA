# What MAMA is for

Version 8 · 2026-09-29 (replaces v7 of 2026-09-25)

MAMA is a persistent agent that keeps watching and remembering the owner's work. Nobody has to
explain things from the beginning again: it knows the current situation, reports it, and does the
work it is given.

## What we are building

It starts from what Kagemusha already does and adds two things.

- **What Kagemusha does:** watches changes in connected conversations and work tools and
  recognises the work in them. It creates and updates tasks, refreshes the board and the scheduled
  reports, and forwards feedback and files.
- **Addition 1 — a wiki and memory that carry over:** the wiki lets a person see how the work
  went; memory connects the records and the owner's corrections as nodes and edges so related data
  is found fast. Both survive new sessions, restarts and model changes.
- **Addition 2 — task history (the differentiator):** for every task it keeps how it progressed,
  what changed, what the feedback was, and who did what. It can also find **similar past cases**
  and reuse how their feedback went and how they ended.

## The engine is shared

mama-core is not MAMA's private internals. A separate project must be able to
connect to it and build its own records: its own storage, its own principals, its own sources, with history,
evidence links and search. It does this without MAMA's product code or MAMA's data. Records,
revisions, evidence and search belong to the engine. Each product's work vocabulary (task
fields, roles, boards, reports) belongs to that product.

## Order — the owner's work comes first

A team only works on top of one owner whose work carries over without breaks. Team sharing,
member permissions and non-owner input wait until the checks below pass on real data.

## When the owner's work counts as carried

1. **Recognise** — read the originals and decide which piece of work and which stage they belong
   to. Keep observations and notes apart from work that was actually handed over.
2. **Attach** — attach new information to existing work. Each piece of work keeps, in one place:
   its purpose, its materials and file versions, decisions, who does what (making, coordinating,
   reviewing) with the evidence for it, its status, corrections, and what is left.
3. **Answer** — for "who is working on this?", "how did X go?", "what was the feedback?", read the
   stored record first and answer with evidence. A new session or a restart gives the same answer.
4. **Report** — the scheduled reports and the board show the same state as the tasks.
5. **Learn** — an owner correction changes the next related action, does not spill into unrelated
   situations, and survives a restart.

## A task is the container for a case

- Everything about one piece of work lives in the task and its revision history. There is no
  separate Case object.
- History is written **when the change happens**, on that revision: what changed, the feedback,
  the source evidence, who did it. "We can re-read the originals later" is not a reason to skip it.
- Roles are context for the work, not a judgment of people. Record the evidence cross-checked in
  conversation. If it is not confirmed, mark it unconfirmed. An assignee field in a tool such as
  Trello is one piece of evidence, not the answer.
- The tasks and the board are the agent's tools for organising the present. The tasks hold each
  piece of work and its revisions; the board is the live view, written after reading the tasks and
  the conversations, so it shows the same state as the tasks.
- The wiki is for people: it lets a person see and understand the history. It is gathered and
  rewritten from many messages, never a dated copy of events. A daily page sums up each day (what
  mattered, what the owner decided, what was missed and learned), and a project page keeps the
  knowledge that stays true (terms, decisions and specifications, how a client works).
- Memory connects the records as nodes and edges (work and its revisions, source messages, people,
  lessons and corrections) so the agent finds related data fast. Similar past cases are reached
  through it and through semantic search over tasks and their history: how earlier work
  progressed, what the feedback was, who did what and how it ended.
- Jev, when the owner turns it on, is a classifier that makes this linking and finding faster and
  easier. Everything works without it.

## Data and the present moment

- Keep every original and every change from the connected sources. Record collection coverage,
  gaps and failures as separate things.
- Do not read everything every time. Go from an overview down through search to the originals, as
  far as needed. The agent pulls each next step itself; the host offers indexes and bounded reads
  and never pushes whole ledgers or procedures into a turn.
- An import of past data (the September replay) seeds the records; live changes and owner
  corrections complete and correct them. Judge accuracy on the running flow over time, not on the
  seed alone.
- Keep occurrence time, observation time and period of validity apart. Old material is not a
  current fact. A collection gap is not "no change" and not "done".

## Real work and files

- Keep originals. Save results as distinct new versions. Record on the task which request and
  which base version led to the change, who made it, and who it was sent to.
- Large files (PSD, ZIP, video) go to Drive, and the link is sent.
- If a delivery result is uncertain, do not mark it as sent and do not send it again. Check the
  original receipt.

## Learning

- Owner corrections and repeated experience collect in one place and reach the agent in the next
  related situation.
- A correction keeps the scope of the existing rule and replaces, merges or retires only the part
  that was wrong. Do not widen a task-specific instruction to every conversation, and do not pile
  up contradicting sentences.
- Learning is done when the next related situation turns out differently, not when something is
  saved.

## What the agent decides and what the host provides

- The agent decides what material means and how relevant and important it is, where one piece of
  work ends and another begins, roles, and what to report and do.
- The host provides collection, storage, search, execution, permissions, messaging and recovery,
  and keeps the records and receipts the agent writes.
- When a fixed host procedure (a set order, a call quota) is removed, the domain knowledge and
  owner corrections it carried move to a place that still reaches the agent. They are never just
  deleted.

## When the purpose is met

- Judge it with real data and real owner questions. Passing tests, structure checks and receipts
  are supporting evidence.
- Reference questions: "How did X progress, and what was the feedback?", "Was there a past case
  like this feedback?", "Who is working on what right now?"
- Finishing a sub-task is not finishing this purpose.

## After that — the v1 destination

Once the owner's work carries over, widen it so that several authenticated team members use the
same MAMA in real work, repeatedly. Keep personal memory apart from shared material. Record
requester, executor, approver and recipient separately. A permission change must show up in what
can actually be read and done.

Development checks: [intent workflow](docs/development/intent-workflow.md),
[corrections and learning](docs/guides/corrections-and-learning.md).
