---
title: Memory and search
parent: Explanation
nav_order: 4
---

# Memory and search

Use memory to retain decisions and corrections, the work ledger to retain progress, and source
reads to inspect the originals. Retrieval brings evidence to the agent; the agent decides what
it means for the current request.

## Keep the right kind of record

Memory supports `decision`, `preference`, `constraint`, `lesson`, `fact` and `workflow`. A record
has a topic, summary, details, scope, origin and status. Active, superseded, contradicted and stale
records remain distinct. Work commitments have their own revision history and searchable judgment
records; they are not a memory kind.

A correction should keep its original scope. Name the record it replaces or the relationship it
changes. Reusing a topic or finding similar text does not automatically supersede an earlier
record. Explicit links preserve how a conclusion evolved, including failed approaches and the
reason for changing direction.

MAMA OS uses `memory.save`; the development-memory MCP uses `save`. Their schemas and default
databases differ. See [actions](../reference/actions.md) and [MCP tools](../reference/mcp-tools.md).

## Choose the read that answers the question

| Need                                                 | Read path                                                                |
| ---------------------------------------------------- | ------------------------------------------------------------------------ |
| A related decision, correction or past work judgment | `memory.search` with a natural-language query                            |
| Records filed under a known topic prefix             | `memory.search` without a query, with `topicPrefix`                      |
| Current work and its progress                        | `work.list`, then `work.show` or the detail view                         |
| Evidence behind a memory                             | `memory.read:provenance`                                                 |
| A preserved message or source change                 | `source.search`, then `source.read`                                      |
| A wiki page                                          | `manage.wiki.read`, starting from `Home.md` when its location is unknown |

Memory search combines vector and lexical candidates, applies scope and status filters, and can
include related graph records. Ranking is not confidence that the content is true. Read the
history and original evidence before treating an old statement as a current fact.

Source search is a separate path over the retained source index. It supports connector, channel
and source-time filters, substring text matching and pagination. Results include source and
observation times, a preview and the handle for a bounded original read. A complete result page
does not promise complete upstream collection.

## Local embeddings

The product uses `Xenova/multilingual-e5-large`, quantized to q8, with 1,024-dimensional vectors.
Stored passages use the `passage:` prefix and queries use `query:`. The model loads on demand in
the process doing the embedding, and caches model files and vectors. MAMA declares the model
cache at `~/.cache/huggingface/transformers`, outside `node_modules`.

There is no product embedding-model selector or search tier. Core also exports `createEmbedder`
for consumers that supply their own model and dimension. A direct embedding failure throws;
the current hybrid recall path logs vector-search failures and can still return lexical hits.
Treat that as reduced retrieval evidence when investigating a missed match. Do not infer working
semantic retrieval from a successful search response alone.

Multilingual vectors help retrieve related wording across languages. Quality and latency depend
on the actual corpus, query and runtime; verify important searches with real titles, feedback
phrases and known relevant records.

## Carry a correction into a later turn

For an owner message, a delta's notify turn and its record turn, the runtime runs one
`memory.search` with the turn's text and shows at most three active `lesson`, `preference`,
`constraint` or `workflow` records in search order, at most 1,200 characters, without
related-graph expansion. A record already shown is not shown again in the same session on the same
local day. This is a relevance hint, not proof that every saved correction will be recalled or
applied. Record turns and the full-report procedure also list every rule the owner gave in chat,
with its topic and when it applies, and the agent reads the ones that apply with
`memory.search({topicPrefix})`. Rules that always apply belong in the owner policy file instead.

Check the whole cycle: applicable hint, access to the original experience, agent judgment,
observed result, scoped correction and a better result on the next related request. Repeat in a
fresh session and after restart. Check an unrelated request as well. See
[corrections and learning](../guides/corrections-and-learning.md) and the
[intent workflow](../development/intent-workflow.md).

Implementation: [memory API](../../packages/mama-core/src/memory/api.ts),
[embedder](../../packages/mama-core/src/embedding/embedder.ts),
[stored-source reader](../../packages/standalone/src/api/stored-source-reader.ts), and
[owner runtime](../../packages/standalone/src/runtime/owner-runtime.ts).
