# Personal connectors — a person connects their own source from their DM

Status: design, not built. Owner request, 2026-11-20: from a personal DM, connect any of the person's
own channels and sources (not only Discord: every kind MAMA can collect), collect them, and report on
them in that DM. The owner picked option B of the research below: collected (ingested) personal
sources, not live reads. One mechanism serves every connector kind; each kind only says how its
credential is entered and checked and which channels it can read.

This serves INTENT's recognise, answer and report checks for a person's own work. The data is that
person's, like their DM chat today: the common session, reports and other people do not see it.

## Research (2026-11-20)

No product was found that both adds a source by conversation and ingests it privately for one person.

- Admin adds, content ingested and shared, results filtered by permission: Dust connections, Onyx
  (`MANAGE_CONNECTORS` on `POST /admin/connector`), Glean, Notion AI, Slack enterprise search.
- Each user connects their own account, content read live: Dust personal tools, Claude connectors,
  Microsoft federated connectors, Composio (a connect link in the chat; credentials never pass the
  model).
- Each user's own content ingested and scoped to that user: Microsoft 365 Copilot self-serve sync. The
  admin enables the connector, the user authenticates, only recent data is crawled, and disconnecting
  removes the indexed content (learn.microsoft.com/microsoft-365/copilot/connectors/overview).
- Self-hosted agents (OpenClaw, Hermes Agent, Letta): channels and sources are added by the operator in
  CLI or config, never from chat.

MAMA takes Microsoft's self-serve model, with P2's Telegram prompt as the connect step.

## Program evidence

- Connectors are built once at boot from `connectors.json` (`runtime/connectors.ts`
  `startConnectorRuntime`, `connectors/config-loader.ts`): one `ConnectorRegistry`, one
  `PollingScheduler`, one `poll-state.json`, tokens from `auth.env`. Every batch goes to
  `acceptSourceDelta`, the common session's intake (`cli/commands/daemon.ts`).
- No action adds a connector; source actions only read (`source.search`, `source.read`,
  `source.recent`, `source.attachment.*`). `config.yaml` and `auth.env` are inside the credential
  denies, so a DM agent cannot change them.
- Personal scope exists for chat only: a person's DM chat is stored with `memoryScopeKind: 'user'`
  (`storage/chat-sources.ts`), exported and erased by scope (`api/member-records.ts`,
  `rawStore.exportScope('chat', 'user', id)`).
- The mailbox already routes a stimulus to one person's session (`runtime.accept({ ...stimulus,
principalId })`, personal notices, P10.4b).
- A person's own tokens are entered in their DM and stored in `runtime/accounts/` (approvals.md P1, P2,
  #589); every reply to an account prompt stays with the host.
- MAMA loads 14 connector kinds (`LOADABLE_CONNECTORS`, `connectors/index.ts`). By credential:
  - **A token or secret URL a person can paste:** `chatwork` (API token, reads the rooms that account
    is in), `slack` (a user token reads that person's channels and DMs; a bot token only channels it
    joined), `discord` (a bot token; a bot reads only servers it was invited to, and message text only
    with the Message Content intent; user tokens are against Discord's terms), `notion` (integration
    token), `trello` (key and token), `telegram` (a source bot token), `ical` (a secret calendar URL).
  - **A Google login through gws:** `gmail`, `calendar`, `drive`, `sheets`. A person's own Google login
    needs a gws config directory per person, which approvals.md G1 measures first.
  - **Files on the install's machine:** `imessage`, `obsidian`, `kagemusha`. They read the owner
    machine's own stores, so they are not a person's to connect from a DM.

## Decided

- A person connects and disconnects their own source from their own DM. Owner-role people only, as
  for P1; members without the role wait with the team work.
- The credential is entered as in P2 (reply prompt, taken before any turn, deleted, checked with the
  service) and stored in `runtime/accounts/`.
- Collected items are bound to that person: `memoryScopeKind: 'user'`, `memoryScopeId: <person>`.
  Their deltas go to that person's session, never to the common session; the owner agent does not
  read them (P6).
- Disconnecting stops the poll and deletes what it collected (Microsoft's rule). Offboarding does the
  same. Export and erasure include it.
- Personal connectors live in the product database, not in `connectors.json`: the install's
  connectors stay the owner's file.
- Scope (owner, 2026-11-20): every kind whose credential a person can paste (the first group above),
  through one mechanism. Google kinds follow G1. Machine-file kinds are not personal sources.

## Owner decisions, 2026-11-20

1. **A personal source is collected, and reported on schedule.** A new batch starts no turn; it is
   stored with the person's scope and stays searchable. Reports are the person's own personal jobs
   (P10.4a) that read their stored sources (`source.recent`, `source.search`).
2. **The report cadence is agreed with the agent.** When a source is connected, the agent asks the
   person how often and when they want its report and creates the personal job they agree on; the
   person changes it the same way later. The host sets no default cadence. Polling stays the kind's
   own interval.

Builder's calls, open to correction: the first poll reads 7 days back (Microsoft crawls only recent
data); kinds are added in the order Chatwork, Slack (their tokens may already be connected for
sending, P1), Discord, Notion, Trello, Telegram, iCal.

## Work

Order: C1–C6, then C7 kind by kind, then C8. Each row is done when its tests pass and, where it names a live check, one real owner
turn shows it.

| Row | What                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Done when                                                                                                                                                               |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1  | Store: product migration `006-personal-sources`. One row per person and source: principal, connector kind, the channels bound with their names, created, cursor state, last poll and error. Credentials stay in `runtime/accounts/`, one entry per kind (P1's store gains the kinds and multi-field secrets such as Trello's key and token)                                                                                                                            | Store tests: a person's rows are theirs only; removing a source removes its row and leaves the person's other sources                                                   |
| C2  | Connect from the DM, the same for every kind: `source.connect {connector}` asks for the credential with P2's prompt (one reply per field) and checks it with the service; `source.channels {connector}` lists what that credential can read (rooms, channels, servers, boards, pages, chats); `source.bind {connector, channels}` records the pick; `source.disconnect {connector}`; `source.list`. A kind adapter supplies the fields, the check and the channel list | Tests per kind: the credential never reaches a turn; only channels the credential reads can be bound; a person binds only for themselves; the common session is refused |
| C3  | Personal poller: one connector instance per bound row, built from the row and the person's token, polled on the interval the connector uses, with its own poll state keyed by person and connector. Items are stamped `user:<person>` before they are stored                                                                                                                                                                                                           | Tests: items land with the person's scope; one person's failing source does not stop another's or the install's; a removed token stops the poll on its next run         |
| C4  | Routing and reads: a personal batch is stored only, starts no turn (decision 1) and never reaches `acceptSourceDelta`. The person's `source.*` reads include their own sources; the common session's and other people's reads exclude them (verify at the read assembly, not by grep)                                                                                                                                                                                  | Tests: the common session and another owner cannot read the items; the person can                                                                                       |
| C5  | Disconnect, offboard, export, erasure: disconnect stops the poll and deletes the source's raw items and index rows; offboard does it for every source of the person; export includes them; erasure deletes them                                                                                                                                                                                                                                                        | Tests for each; read-back shows no row left with that person's scope for the source                                                                                     |
| C6  | What the agent is told: the action contracts, and one line in the member standing text: a person can connect their own source here, and after connecting the agent agrees the report's cadence with the person and creates that personal job (decision 2). No keyword routing                                                                                                                                                                                          | Standing-text size test passes                                                                                                                                          |
| C7  | Kind adapters, one row each in the order above: Chatwork, Slack, Discord, Notion, Trello, Telegram, iCal. Each reuses its existing connector class with the person's credential and channels                                                                                                                                                                                                                                                                           | Per kind: connector tests with a stand-in API; the class's poll runs unchanged on a personal row                                                                        |
| C8  | Live: the owner connects a personal Chatwork or Slack source from their DM, a message posted there is collected, and a personal job's report in the DM names it                                                                                                                                                                                                                                                                                                        | One owner turn; `daemon.log` clean; a read-back of the stored item with the owner's personal scope                                                                      |

## Left to the builder

- The channel list shows names and ids; the agent asks the person which to bind.
- The personal poller reuses `PollingScheduler` per person if its state file can be keyed; otherwise a
  small scheduler of its own. Measure before choosing.
- Attachments in personal sources follow the person's file paths (P5), not the common downloads.

## Not built

- Personal sources shared to the common session or another person (team work, later).
- Members without the owner role.
- Discord DMs and group DMs: a bot cannot read them.
- Google kinds until G1; machine-file kinds (`imessage`, `obsidian`, `kagemusha`).

## Risks named

- **Cost.** Each personal source adds polls; each agreed report is a personal job turn on the shared login.
- **Credentials that read more than the person means.** A Slack user token reads the person's DMs; a
  Chatwork token reads every room the account is in. Only the bound channels are polled, and the
  channel list shows what will be read before anything is bound.
- **A bot the person runs** (Discord, Telegram source): the person creates it and invites it to a server
  or chat they manage. Without that right there is no source of that kind.
- **Scope leaks.** Any read path that ignores `memory_scope` would show personal items to the common
  session; C4 checks the read assembly.
