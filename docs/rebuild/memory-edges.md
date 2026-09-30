# Edge tools — plan

Status: v6 after review · 2026-09-30 · loop: plan → review → build → review → PR → review → merge →
release. Evidence and the earlier benches: [memory-edges-evidence.md](memory-edges-evidence.md).

Purpose (owner, 2026-09-29/30): records are connected by edges that the agent follows itself;
search is only the way in. An edge an agent wrote after judging the relation is the ground for
reaching the record of fact (item → linked item's revisions → their source messages); a vector
search returns similar text, which is no such ground. Following edges is faster than verifying
the raw sources again. The work is the **tools** that let the agent connect records efficiently
and read them, in MAMA OS and in the Claude Code MAMA MCP.

Records and edges are never edited (owner, 2026-09-30): the agent appends, so the history shows
what changed and why, with its evidence. Edges were written by the host (the revision chain,
similarity links) because agents could not choose them; models can now choose their edges, so the
host writes no edge the agent did not state, and a correction is a newer edge with its reason.
Edges that record an act the agent named (`amends` from an outcome update or a retirement,
`supersedes` from `replaces`) are the agent's statement and stay. The `status`, `outcome` and
`superseded_by` columns those acts set are projections of the appended records; each amendment
record keeps the values it replaced.

## How others do it (research, 2026-09-30)

| System                      | Connect                                                               | Read                                                                                                      | An edge carries                                                            | A wrong edge                                  |
| --------------------------- | --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- | --------------------------------------------- |
| MCP reference memory server | `create_relations {from, to, relationType}`, apart from entity writes | `open_nodes(names)`: the nodes and the relations among them; `search_nodes`                               | relation type only                                                         | `delete_relations`                            |
| Graphiti (Zep)              | `add_triplet` (source → fact → target), or extraction from an episode | `search_memory_facts` around `center_node_uuid`; `get_entity_edge`; `get_episode_entities` for provenance | `name`, `fact` sentence, `episodes` (source ids), `valid_at`, `invalid_at` | `invalid_at` / `expired_at` set, history kept |
| A-MEM                       | the LLM picks links among embedding top-k when a note is written      | top-k notes                                                                                               | a bare link set                                                            | notes evolve                                  |
| Mem0 graph memory           | memories sharing an entity are linked automatically                   | links only change ranking; no relation payload is returned                                                | —                                                                          | —                                             |
| Wikidata                    | a statement with references (`stated in`, `reference URL`)            | the statement with its references                                                                         | provenance per statement                                                   | `deprecated` rank, not deletion               |

Taken: an edge is written by its own tool, apart from node updates (MCP `create_relations`,
Graphiti `add_triplet`); it carries the sentence of why and its evidence (Graphiti `fact` and
`episodes`, Wikidata references); reading starts from a node and returns its edges (`open_nodes`,
`center_node_uuid`); a wrong edge is kept, and what replaces it is recorded with its reason
(Graphiti's `invalid_at`, Wikidata's `deprecated` rank). In MAMA that record is a newer edge,
because nothing is edited. Not taken: links made by the host from similarity or co-occurrence
(A-MEM's candidate pass, Mem0): owner rule W22, and the development memory's host similarity links
join related decisions in 13 of 30 samples.

## Tools today

MAMA OS and core:

- Connect: only `work.revise` `links`. Each link writes a new revision, so the item counts as
  changed in reports and daily pages; the target's revision id must be looked up first; a wrong
  link cannot be corrected; person nodes cannot be created by the owner agent (`graph.node.put`
  not granted, `action-surface.ts:44-78`).
- `twin_edges` is written by the judgment link insert (`judgments.ts:527`), by the migration 099
  backfill at every adapter open (`commitment-revision-migration.ts:41-45`,
  `node-sqlite-adapter.ts:840-852`), and by the public `insertTwinEdge` export (no caller).
  `twin_edges` already carries `agent_id`, `model_run_id`, `authority_scope_json`,
  `evidence_refs_json` and `content_hash`. A link may target an edge (`referenceExists` kind
  `edge`, existence only, no scope check).
- Automatic edges: every `work.revise` and withdraw gets a host `builds_on` to the previous
  revision (`judgments.ts:857-868`, source `code`, reason taken from the revision's reasoning;
  612 live rows). The core evolution engine (`evolution-engine.ts:98-155`) supersedes raw
  conversation by its extraction, links same-topic memories (`supersedes` "Updated fact",
  `builds_on` "Related but distinct") and vector neighbours ≥ 0.82 (`builds_on` "Semantically
  similar"); `promoteMemoryStatus` writes them and has no runtime caller; `evolveMemory` is a
  public export.
- Unused edge mutators exported from core: `decision-edges.ts:47-205` (insert-or-replace,
  approve, reject, deprecate). The legacy `relationships` save path writes a fixed reason
  (`write-adapters.ts:185`) and has no caller.
- Read: `graph.query neighbors` needs every revision id of an item as a seed and mixes source
  links and the revision chain into the result (10 of 331 live `graph.query` calls since 09-26).
  From a linked item to its facts, `work.list detail` (revisions with their evidence) and
  `source.read` already work.
- Amendments: `applyAmendment` overwrites `outcome` and `status` (`judgments.ts:408-424`) and the
  outcome amendment's payload keeps only the new values (`write-adapters.ts:258-266`).

Claude Code MAMA MCP:

- Connect: `save` has no link field. "builds_on: id" at the end of the reasoning is parsed only by
  the global `mama-server` 1.12.1 that runs today (86 of 155 decisions since 09-01 use it); the
  source (2.2.2) ignores it, and four instructions still ask for it (`mama-api.ts:549-555`,
  `server.js:117`, `save-decision.js:115-116, 134`). No tool adds a link after a save. The public
  save input already has `links` and `replaces` (`types.ts:306-308`) that reach `twin_edges` for
  any caller (`memory/api.ts:714-715`); `mama.save` does not pass them.
- `decision_edges` (primary key from, to, relationship; `created_by` only `llm` or `user`) cannot
  keep a history of one pair or name who wrote a row; the 690 host similarity rows say `user`.
- Read: no tool reads one decision by id or lists its edges; search rows return `related_to` and
  `edge_reason` as null (`memory/api.ts:2738-2741`).
- The development database is at schema 80; a build with this plan runs migrations 81–099 on it.

## Work items

| #   | Build                                                                                                                                                                                                                                                                                                                                                                                                                   | Check                                                                                                                                                                                       | Deletes                                                                                                                                                    |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| E1  | Core: a link command — one `twin_edges` row appended between existing records, no new record: relation, required `reason` (stored in `reason_text` and `attrs.reason`), evidence refs, agent and run from the command. The row is its own receipt: `edge_id` derives from principal and command id, and the stored `content_hash` tells a replay from a conflict. Both ends must be visible to the caller. No migration | Core tests: the same command id returns the same edge; a different payload under it is a conflict; an end outside the caller's scopes is refused; no record, revision or other edge changes | The public `insertTwinEdge` export                                                                                                                         |
| E2  | Core: correction — a link command from the item's head record to an earlier edge (`{kind: 'edge'}`) with `contradicts` and its reason, both ends of the target edge checked for visibility (`visibleTwinRefKeysRecursive`); host chain edges can be corrected too. Graph reads add one indexed query per page for such corrections and return `correctedBy {edgeId, reason, at}` on the corrected edge                  | Core tests: the corrected row is unchanged; neighbors and detail show the correction                                                                                                        | —                                                                                                                                                          |
| E3  | Standalone: `work.link {from, to, relation, reason, evidenceRefs?}` over E1/E2 — `from` an item (its head record), `to` an item, a registry node or an edge (a correction)                                                                                                                                                                                                                                              | Action tests: no revision is added to either item                                                                                                                                           | The instruction to link through `work.revise`                                                                                                              |
| E4  | Standalone: `work.list view: 'links'` (prototype exists): both directions, relation, reason (`attrs.reason`, else `reason_text`), `source`, evidence refs, the other end (item title and status, person name, or observation), `correctedBy`, the graph page's coverage; named in the work.list summary                                                                                                                 | Action tests, including a link read from an item's head after later revisions                                                                                                               | The optional `queryGraph` port and its runtime throw                                                                                                       |
| E5  | Procedure: help topic `cases` (indexed by the question: whether something like this happened before, how it ended, what an item relates to): read the item's links first; when an answer confirms an earlier case of the same kind, `work.link` it with the reason                                                                                                                                                      | Topic test                                                                                                                                                                                  | The draft lines under `record` and `sources`                                                                                                               |
| H1  | Core: no host edge on revise or withdraw; migration 099 stops writing and only stamps its version; the record topic keeps asking the agent to choose the relation to an earlier record with its reason. Existing chain rows stay. The viewer draws stored edges only (drawing revision order as edges would show links nobody stated); an item's revision order is in `work.show` history                               | Revision-history reads use `commitment_assignments` (`commitments.ts:326-360`, graph-query hydration 1426-1446); tests rewritten: `viewer-data.test.ts`, `commitment-write.test.ts`         | The host link at `judgments.ts:857-868`; the 099 edge insert and its backfill module; the viewer's dead "Earlier records" block; the viewer note rewritten |
| H2  | Core: no evolution edges                                                                                                                                                                                                                                                                                                                                                                                                | `module-exports.test.js` updated; core major version, named in the release notes                                                                                                            | `resolveMemoryEvolution`, `evolveMemory` (public export and the `mama` object), `promoteMemoryStatus` (no runtime caller)                                  |
| H3  | Core: an outcome or status amendment keeps the values it replaces in its payload                                                                                                                                                                                                                                                                                                                                        | Test: the earlier outcome reads back from the amendment record                                                                                                                              | —                                                                                                                                                          |
| M1  | MCP `save`: `links [{id, relation, reason}]` and `replaces [{id, reason}]` passed through `mama.save` to the public save input (`twin_edges`)                                                                                                                                                                                                                                                                           | MCP tests: a save with links reads back with its reasons                                                                                                                                    | The legacy `relationships` path; the unused `decision-edges.ts` mutators and their exports; the four "builds_on: id" instructions (with M1, not after M3)  |
| M2  | MCP `link {from, to, relation, reason}` over E1/E2: a link after a save, or a correction                                                                                                                                                                                                                                                                                                                                | MCP tests                                                                                                                                                                                   | —                                                                                                                                                          |
| M3  | MCP `get_decision {id}`: the decision, `supersedes` and `superseded_by`, every incoming and outgoing edge with relation, other id, topic, one line, reason, source and `correctedBy`; legacy `decision_edges` rows shown with `source: host` when their reason starts with "Semantically similar", "Updated fact", "Related but distinct" or "Auto-detected from reasoning"                                             | MCP tests                                                                                                                                                                                   | —                                                                                                                                                          |
| M4  | Development environment: replace the global `mama-server` 1.12.1 with the M1–M3 build (owner approval). Before approval: a named backup of `~/.claude/mama-memory.db`, migrations 81–099 run on a copy, record and edge counts compared                                                                                                                                                                                 | Counts match on the copy; a save with links reads back through M3                                                                                                                           | —                                                                                                                                                          |
| R   | Release: mama-core major (E1, E2, H1–H3, M1), mama-os (E3–E5), mama-server and plugin (M1–M3)                                                                                                                                                                                                                                                                                                                           | CI, CodeRabbit on the PR and locally, one real owner turn with a clean `daemon.log` and a DB read-back                                                                                      | `readGraphSimilarityEdges` and `memory.read:graph view: similarity` (no caller, no trace)                                                                  |

## Checks

Each tool is checked by its tests and, after release, by one real owner turn (AGENTS.md: owner
turn, clean `daemon.log`, DB read-back). No agent bench is part of this plan; if one is needed, its
number of runs, cost and peak memory go to the owner before it runs.

Out of scope: people as nodes (W2), a linking pass over September data, removing the development
memory's host similarity edges (the owner's decision; that database is not disposable).
