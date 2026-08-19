# MAMA OS

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node Version](https://img.shields.io/badge/node-%3E%3D22-brightgreen)](https://nodejs.org)
[![LongMemEval 100Q](https://img.shields.io/badge/LongMemEval%20100Q-93%25-blue)](packages/memorybench/)
[![Tests](https://img.shields.io/badge/tests-6080%20passing-success)](https://github.com/jungjaehoon-lifegamez/MAMA)

> Right now, you read every channel yourself so nothing slips past you.
> MAMA reads them instead, and sends you the few things that need you.
> Every claim links to its source.

**MAMA OS is an always-on agent server.** You install it on your own machine, and it
stays running around the clock — like Home Assistant or Plex, but its job is your work
channels. `mama start` brings it up. Its Viewer lives at `localhost:3847`. Its
reports arrive in your chat app.

![An illustrated morning desk: channel cards (chat, mail, kanban, calendar, notes) send glowing threads into a small box labeled MAMA, which delivers a briefing to the phone: deadline slipped Fri to Wed, B waiting 9h on your quote, invoice paid $1,200 in, while you slept 14 sources read.](docs/website/assets/mama-os-hero-briefing.png)

## The product is a message that arrives

You pick the hours. At those hours, in Telegram, Slack, or Discord:

```text
■ Briefing — Wed 08:00
1. The #alpha deadline slipped: Friday → Wednesday            → source
2. B has waited 9 hours for your quote                        → source
3. Client A paid the invoice — $1,200 came in                 → source

■ Needs your action
- Approve the revised scope before the 11:00 call             → thread

■ Recorded yesterday
- Decision: rotate the staging API keys weekly                → source
```

The names are made up. The format is exactly what it sends.

Nobody asked for that message. Overnight, the MAMA server on your machine read 14
sources: Slack, Telegram, Gmail, Trello, Sheets, an Obsidian vault, and more.
It decided what needed you, and wrote it down with links.

It also did the small work already — done by a standing roster of workers,
not one giant bot: a board keeper that files tasks from conversations, a wiki
writer that keeps the daily page, a deadline watcher that rechecks dates, and a
memory curator that decides what deserves to be remembered. Each one leaves
receipts you can open.

## What that replaces

- The morning scan across channels that mostly did not change.
- Scrolling back to find out when that deadline moved, and who said so.
- The handoff note you have to write before you step away.

And three things it is **not**:

- Not a chatbot with good memory. It is a server that runs while nobody is talking to it.
- Not a memory database. Storage is the input; the report is the product.
- Not a hosted service. There is no MAMA account and no MAMA server. It runs on
  the logins you already have.

## Why not a task agent, or your chat app's AI?

Both exist and both are good. They just answer a different question.

- **A task coworker finishes work you already know about.** You still have to notice that
  the deadline moved before you can delegate it. MAMA's job is to notice for you.
- **A chat integration reads Slack when you ask.** But your clients are on Chatwork,
  iMessage, and Telegram DMs. MAMA reads fourteen sources, including the messy ones where
  the money actually talks.
- **Both start from zero every time.** MAMA keeps a record on your disk and answers from
  it, with the source message linked. It does not run a new search that forgets everything
  afterwards.
- **Neither can say "still unanswered after three days."** To say that, you must remember
  yesterday. MAMA remembers. A scheduled summary starts fresh every time and has nothing to
  compare against.

## Built to be checked, not believed

A system that acts on its own must be easy to check afterwards.

- **No source, no claim.** Every change MAMA makes is saved together with the events
  that caused it. If it cannot name a cause, the change is saved as _unattributed_.
  The database rejects any row that fakes a cause.
- **It drafts; you send.** An agent can write the customer reply from the
  evidence, but sending requires an explicit permission for that destination.
  Memory writes refuse anything shaped like a secret. The system interrupts you for approvals and
  operational alarms such as stale claims, exhausted retries, or unresolved effects; everything
  else waits for the next report.
- **Your record stays on your machine.** The databases are local SQLite and the
  embeddings are computed locally. Network traffic goes to two places only: the
  services you connected (Slack, Gmail, and so on) and your AI provider, through
  the official `claude` or `codex` CLI you already logged into. Nothing is ever
  uploaded to a MAMA server, because there is none.
- **Search shows its work.** Strict mode drops a semantic match that has no text or
  entity evidence behind it. A wrong answer that merely sounds right gets rejected,
  not displayed.

More detail: [Architecture](docs/explanation/architecture.md) ·
[Security guide](docs/guides/security.md)

## Quick start

**The server** — the full product. Install once; it keeps running until you stop it:

```bash
claude auth login            # or: codex login — your existing CLI auth is reused
npx @jungjaehoon/mama-os init
mama start                   # daemon at localhost:3847
```

Operator board at `http://localhost:3847/viewer`: live report slots, the trigger
library, and a task board fed from your channels. Chat surfaces: Discord,
Slack, Telegram. Requires Node >= 22 and an authenticated
[Claude Code](https://claude.ai/claude-code) or
[Codex](https://www.npmjs.com/package/@openai/codex) CLI.

**Claude Code plugin** — decision memory for coding sessions. It works without the
daemon; one hook (conversation ingestion at compaction) uses the daemon when it is
running, and skips quietly when it is not:

```bash
/plugin install mama
/mama:search "authentication strategy"
```

**MCP server** — Claude Desktop or any MCP client:

```json
{ "mcpServers": { "mama": { "command": "npx", "args": ["@jungjaehoon/mama-server"] } } }
```

## The pieces

| Package                                       | What it is                                                                                                     | You run it?          |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | -------------------- |
| [mama-os](packages/standalone/) 0.37.0        | The always-on server: connectors, trigger loop, reports, task board, web UI. 92k lines. "MAMA" means this.     | `mama start`         |
| [mama-core](packages/mama-core/) 2.2.0        | The library underneath: memory, provenance, graph, embeddings. Everything imports it; it imports nothing here. | No binary            |
| [mama-server](packages/mcp-server/) 1.15.0    | A deliberately thin MCP adapter over the core — 3.7k lines, no logic of its own.                               | As an MCP server     |
| [plugin](packages/claude-code-plugin/) 1.11.0 | Claude Code hooks + slash commands. No background process.                                                     | Installed, not run   |
| [memorybench](packages/memorybench/) 1.0.0    | The benchmark harness behind the retrieval numbers.                                                            | To reproduce a score |

Dependency direction is one-way: nothing depends on the daemon.

## Our numbers, including the bad ones

- **93.0%** on a 100-question LongMemEval tool-use sample (Sonnet 4.6, fully
  local) — above SuperMemory (81.6%), below Mastra (94.87%).
  [Reproduce it](packages/memorybench/).
- **84% of trigger-authoring passes create nothing.** A duplicate gate rejects
  near-copies of triggers that already exist. That is correct, but a loop this idle
  should at least say why it declined.
- **Cache reuse is 15.9x** per built context, against 144.8x for a comparable system
  on the same machine. This is our biggest known cost problem.
- **Attribution is wired end-to-end, and the ratio is still low.** Every change now
  carries a cause KIND (`event`/`owner_message`/`clock`/`card_transition` - the DB
  rejects a kind that disagrees with its ids), and judgment runs receive their event
  batch from the host. Connector batches now enter MAMA's durable owner-event journal and
  are handled by the same owner agent identity; the retired default-off Conductor no longer
  splits attribution or action ownership.

## Roadmap

|                    |                                                                                                                                                                                                                                                                                                                            |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Done (v0.15–v0.29) | Search overhaul → connector framework → operator runtime → owner console → durable workorder pipeline → evidence & effects. Full history in the [CHANGELOG](CHANGELOG.md).                                                                                                                                                 |
| Done (v0.30–v0.37) | Durable event intake → causes wired not relabeled → effect receipts → MAMA owner-event sessions. The default-off Conductor experiment was retired; MAMA itself owns connector events on Claude, Codex, and Cline.                                                                                                          |
| **Now**            | v1.0 Phase 1 — sender authentication at every chat ingress: owners are admitted, external senders are diverted, and addressed Telegram group messages enter an isolated public lane. The gate every team feature stands on.                                                                                                |
| Next               | Unpacked below.                                                                                                                                                                                                                                                                                                            |
| v1.0               | **The brain of a team, not just its owner.** The owner registers members and sets each one's level: what they can read, which agents they can use. Shared, scoped knowledge — an owner's private record stays private. Member agents ship behind owner approval. One owner, always; multi-organization stays out until v2. |

Each "Next" item comes from a measurement, or from a competitor doing it better:

- **Stable prompt prefixes for the autonomous lanes.** Cache reuse is 15.9x against a
  comparable system's 144.8x. One prompt cut (231 KB → 57 KB) already halved per-call
  cost. The same discipline applies to the report and board lanes.
- **Zero-yield authoring that says why.** 84% of authoring passes create nothing. A pass
  that declines should record what it rejected, and a near-duplicate should strengthen the
  existing trigger instead of vanishing.
- **A surface that can only answer "nothing" fails the build.** Two shipped APIs turned out
  to be permanently empty. The drift guard that now covers the tool catalog generalizes to
  every advertised surface.
- **Reports that state their own arithmetic.** The daily report should end with what
  it handled for you — tasks filed, dates rechecked, questions closed — in counts, so the
  time it returns is a number, not a feeling.
- **An approval inbox.** Taken from OpenWorker: when the owner is away, the system queues
  the decision instead of raising its own authority.
- **Permissions you can explain in one sentence.** Also from OpenWorker: label every
  action as read, write-local, or external-send. And state the standing rule up front:
  _external sends never happen without explicit permission, by design._
- **A first briefing in the first five minutes.** Taken from Claude's Slack integration:
  one connector, first poll, first report. The product should prove itself before anyone
  has to believe anything.

## Development

```bash
git clone https://github.com/jungjaehoon-lifegamez/MAMA.git
cd MAMA && pnpm install && pnpm build
pnpm test     # 6,080 passing tests across five packages
```

Guidelines in [CLAUDE.md](CLAUDE.md). _Last updated: 2026-08-19_

## License

MIT
