# MAMA OS

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node Version](https://img.shields.io/badge/node-%3E%3D22-brightgreen)](https://nodejs.org)
[![LongMemEval 100Q](https://img.shields.io/badge/LongMemEval%20100Q-93%25-blue)](packages/memorybench/)
[![Tests](https://img.shields.io/badge/tests-6359%20passing-success)](https://github.com/jungjaehoon-lifegamez/MAMA)

> Send MAMA a message and the real files. It remembers the Case, does the work it is
> authorized to do, and sends back a verified artifact. Every claim and mutation links to
> its source.

**MAMA OS is the work agent behind your messenger.** You install one local server and contact one
MAMA through Telegram, Slack, or Discord. Internally it can compose models, bounded workers, and
domain tools, but users do not choose or coordinate an AI team. MAMA remembers work as scoped
Cases and returns reports or real files with receipts. `mama start` brings it up; its Viewer lives
at `localhost:3847`.

![An illustrated morning desk: channel cards (chat, mail, kanban, calendar, notes) send glowing threads into a small box labeled MAMA, which delivers a briefing to the phone: deadline slipped Fri to Wed, B waiting 9h on your quote, invoice paid $1,200 in, while you slept 14 sources read.](docs/website/assets/mama-os-hero-briefing.png)

## The product is work you hand off in a message

Today, the owner-first runtime reads connected sources, performs bounded background work, and
delivers an evidence-linked briefing without being asked:

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

Nobody asked for that report. Overnight, the MAMA server on your machine read 14
sources: Slack, Telegram, Gmail, Trello, Sheets, an Obsidian vault, and more.
It decided what needed you, and wrote it down with links.

It also performs real work through bounded capabilities: filing tasks from conversations, keeping
the daily wiki, rechecking dates, translating feedback, creating files, or invoking a domain
runtime. Internal workers are an execution strategy, not user-facing teammates. MAMA remains the
single accountable front and every durable effect leaves a receipt.

The v1 direction extends that same contract to a human team. An authorized member can continue a
shared Case, submit a new file revision, request an audit or mutation, approve an exact result, and
receive the artifact without learning an agent organization chart.

## What that replaces

- The morning scan across channels that mostly did not change.
- Scrolling back to find out when that deadline moved, and who said so.
- The handoff note you have to write before you step away.
- Re-explaining which feedback belongs to which file revision.
- Choosing and coordinating a different AI persona for every step of one job.

And four things it is **not**:

- Not a user-facing team of AI personas. MAMA may use hidden workers, but the human delegates the
  outcome, not the orchestration.
- Not a chatbot with good memory. It is a server that can inspect, act, verify, and deliver while
  nobody is looking at a MAMA app.
- Not a memory database. Memory is the substrate; verified work and artifacts are the product.
- Not a hosted service. There is no hosted MAMA account or service. The local MAMA server runs on
  the logins you already have.

## Why not a workflow builder, an agent team, or your chat app's AI?

All exist and all are useful. They just assign the coordination cost differently.

- **A workflow builder requires the steps up front.** Real work changes after the agent reads the
  feedback and the current file. MAMA chooses the tool composition while the host enforces identity,
  file, mutation, approval, and delivery boundaries.
- **A visible agent team makes the human the manager.** MAMA may parallelize independent research
  or use an independent reviewer, but one MAMA owns the user conversation and final result.
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
[Work Agent](docs/explanation/work-agent.md) ·
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
| [mama-os](packages/standalone/) 0.39.3        | The always-on server: connectors, trigger loop, reports, task board, and web UI. "MAMA" means this.            | `mama start`         |
| [mama-core](packages/mama-core/) 2.2.0        | The library underneath: memory, provenance, graph, embeddings. Everything imports it; it imports nothing here. | No binary            |
| [mama-server](packages/mcp-server/) 1.15.0    | A deliberately thin MCP adapter over the core with no independent product logic.                               | As an MCP server     |
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

|                    |                                                                                                                                                                                                                                                                                                                                                                              |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Done (v0.15–v0.29) | Search overhaul → connector framework → operator runtime → owner console → durable workorder pipeline → evidence & effects. Full history in the [CHANGELOG](CHANGELOG.md).                                                                                                                                                                                                   |
| Done (v0.30–v0.37) | Durable event intake → causes wired not relabeled → effect receipts → MAMA-owned owner-event lane (stateless fresh run per batch). The default-off Conductor experiment was retired; MAMA itself owns connector events on Claude, Codex, and Cline.                                                                                                                          |
| **Now**            | v0.39.3 packages the v1.0 Phase 2b release candidate merged in [PR #240](https://github.com/jungjaehoon-lifegamez/MAMA/pull/240): explicit member grants, one server-computed scope snapshot, revoke-aware sessions, and Telegram/Slack/Discord member ingress. Phase 2b is not called shipped until local install, restart validation, and a real human-member canary pass. |
| Next               | Unpacked below.                                                                                                                                                                                                                                                                                                                                                              |
| v1.0               | **One MAMA for a human team.** Members receive explicit project/Case/artifact/action grants. MAMA remembers shared work, keeps private memory private, and performs analysis, mutation, audit, approval, and delivery through bounded domain capabilities. Internal workers stay behind the single MAMA front. One owner, always; multi-organization stays out until v2.     |

The normative product direction is
[MAMA One-Front Team Work Agent](docs/development/2026-08-26-one-front-team-work-agent-design.md).
The current access-foundation release candidate is the
[v1 Phase 2b Human-Team Access Foundation](docs/development/2026-08-26-phase2b-human-team-access-plan.md).

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
pnpm test     # 6,359 passing tests across five packages
```

Guidelines in [CLAUDE.md](CLAUDE.md). _Last updated: 2026-08-27_

## License

MIT
