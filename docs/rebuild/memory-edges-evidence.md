# Edge tools — evidence

Benches run 2026-09-29/30 for plan v1–v4 of [memory-edges.md](memory-edges.md). They measured agent
behaviour, not the tools, and are kept as evidence only. 59 completed `claude -p` runs on Sonnet 5
(`--model sonnet`; the daemon runs `claude-sonnet-5-5`), `judge` off, about $28.6 at API price
(cache reads 50.7M, cache writes 3.0M, output 0.67M tokens); nine parallel runs froze the owner's
16 GB machine and 16 P7 runs were stopped.

- Harness: a live database copy per run, the target item rolled back and everything after the
  order's time removed; the order and standing prompt built by the product's own builders; from
  batch x on, the only tool was `mcp__mama__code_act` served like the live action server.
- Record turns (P4, 18 runs over three harness batches): 0 precedent links and 0 people, though
  every run read the procedure line; one run linked two items that one message set a rule for.
- Owner questions with no links (12 runs): 12 named at least one real precedent and how it ended;
  one answer stated that the submitted file was the latest without reading the source (it was
  tk1) and led with an unrelated case from search.
- Answer turns with the `cases` topic (12 runs): 12 wrote links through `work.revise`; 16 of 17
  links pointed at a real precedent; one run attached them to the sibling item (TF instead of BC).
  Under `sources` ("reading source messages"), 1 of 6 read the line and linked.
- Later questions (P7, 11 of 27 runs): every question started from an item without links, so no
  run followed a link to reach facts; a question on an unlinked item re-read raw sources 10–17
  times.
- Harness defects found on the way: a kagemusha channel key without its connector, a wall-clock
  window, no stored-source reader, a heredoc wrapper refused by the permission check.
