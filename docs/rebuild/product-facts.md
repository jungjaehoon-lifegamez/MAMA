# Product facts for documentation (verified against the code, 2026-09-27)

Every reader-facing document must agree with this page; if the code changes, this page changes first.

## Two products in one repository

- **MAMA OS** (`packages/standalone`, npm `@jungjaehun/mama-os`, CLI `mama`): one owner agent that
  watches the owner's work sources, keeps a work ledger with revisions and evidence, answers through
  Telegram, Discord, or Slack, and learns from corrections. Purpose and owner checks: `INTENT.md`.
- **Development memory for Claude Code** (`packages/claude-code-plugin` + `packages/mcp-server`, npm
  `@jungjaehoon/mama-server`): decisions and checkpoints for coding sessions. The MCP server uses
  `@jungjaehoon/mama-core` in-process; it never needs the MAMA OS daemon. Database: `MAMA_DB_PATH`
  (older name `MAMA_DATABASE_PATH` still read) else `~/.claude/mama-memory.db`, shared with the plugin
  hooks.
- **Shared engine** (`packages/mama-core`): storage, records with revisions and evidence links, memory
  kinds (decision, preference, constraint, lesson, fact, workflow), work items as commitments, search, embeddings
  (`Xenova/multilingual-e5-large`, 1024 dimensions, fixed), runtime drivers for the Claude CLI and the
  Codex app-server, the action catalog and dispatch. Used by other projects through public exports.
- Two data homes, never mixed: `~/.mama/` is MAMA OS state; `~/.claude/mama-memory.db` is development
  memory.

## MAMA OS

- CLI: `mama init` (terminal only; owner types tokens with echo off), `mama secret set <NAME>` /
  `mama secret list`, `mama daemon`, `mama replay`, `mama status` (running/stopped), `mama stop`.
- Files: `~/.mama/config.yaml` (no secrets), `~/.mama/connectors.json` (no secrets), `~/.mama/auth.env`
  (0600, onboarding-managed tokens; the owner agent cannot read it), `~/.mama/start.sh` (sources auth.env, sets PATH),
  launchd `com.mama.server` (KeepAlive) runs start.sh, logs in `~/.mama/logs/` (daemon.log 0600,
  security-events.jsonl 0600), runtime state in `~/.mama/runtime/`, workspace `~/.mama/workspace/`,
  daemon-owned downloads `~/.mama/downloads/` (0700; readable but not writable by the agent).
- config.yaml keys read: `version: 1`, `agent {backend, model, effort, max_turns, timeout,
run_token_budget, codex_home, codex_cwd, codex_sandbox, tools.mcp_config}`, `database.path`,
  `logging {level, file}`, `telegram {enabled, owner_chat_id, allowed_chats, owner_user_ids, polling}`, `discord` and `slack` owner channel and user allowlists, `delivery {reports, notifications, security_alerts}`,
  `jev`, `wiki {enabled, vaultPath, wikiDir}`, `reports {full_report_hours [8,13,18],
reminder_start_hour 9, reminder_end_hour 21}`. Other keys are logged as ignored; `telegram.token` in
  config.yaml is an error (the token lives in auth.env as MAMA_TELEGRAM_TOKEN).
- Secrets (auth.env): MAMA_TELEGRAM_TOKEN (owner messenger), MAMA_TELEGRAM_SOURCE_TOKEN (Telegram
  source connector), MAMA_SLACK_TOKEN, MAMA_SLACK_APP_TOKEN (Socket Mode), MAMA_CHATWORK_TOKEN, MAMA_TRELLO_KEY, MAMA_TRELLO_TOKEN,
  MAMA_NOTION_TOKEN, MAMA_DISCORD_TOKEN, MAMA_AUTH_TOKEN (viewer). Gmail, Drive, Sheets and Calendar
  use the logged-in `gws` CLI and have no MAMA connector token. Non-secret environment: MAMA_CF_ACCESS_ISSUER,
  MAMA_CF_ACCESS_AUD, MAMA_VIEWER_HOSTNAMES, MAMA_VIEWER_OWNER_EMAILS, MAMA_API_HOST, MAMA_API_PORT.
- One owner agent session. Backends: `claude` (Claude CLI; MAMA actions as MCP tools with a caller hook;
  sandboxed Bash, workspace-only writes, WebFetch/WebSearch; subagents run inside the turn) or `codex`
  (Codex app-server; dynamic tools; shell and web search; permission profile). Both: the backend gets the
  daemon environment without secret-shaped names; credential files are unreadable to the agent.
- Gateway: Telegram, Discord, and Slack. Only the owner (allowed channel + owner user id) is answered; others are dropped
  and logged with hashed ids. Files the owner sends are downloaded under `~/.mama/downloads/<messenger>/`;
  copy into `workspace/files/` before modifying, unzipping, or delivering them.
- Connectors: chatwork, slack, trello, discord, telegram source, and notion (API tokens); kagemusha
  (read-only local bridge); calendar (multiple labelled calendars), iCal (per-feed URL secrets),
  gmail, drive, and sheets (logged-in `gws` CLI); obsidian,
  imessage, and claude-code (selected local sources). Channel roles: truth, hub, deliverable, spoke,
  reference, ignore.
- Owner actions (25): graph.query; source.search/recent/read; schedule.upcoming; source.attachment.list/download;
  work.create/revise/list/show; memory.save; memory.search; memory.read:record;
  memory.read:provenance; memory.retire; memory.checkpoint.list;
  report.read/publish; manage.wiki.publish/read/update; deliver.telegram.file, deliver.discord.file,
  deliver.slack.file.
- Per turn: a new owner session receives one scoped index line per active lesson, preference, constraint,
  or workflow, plus recent owner exchanges; later turns in that session receive only added, revised, or
  retired guidance. Scheduled, source-delta, and native-event turns use the same index and delta rule;
  guidance is not recalled from stimulus text. Older entries without an applies-when line show their
  summary. Third-party content (source, attachment, wiki, board reads and delta text) arrives wrapped as
  untrusted. Answers carry no ids.
- Reports: live source deltas end `[notify] <text>` (sent to `delivery.notifications`) or `[ack]` (logged), then a board
  turn republishes the four slots (briefing, action_required, decisions, pipeline); full report at
  8/13/18 KST; hourly reminder 9–21 including gathered non-urgent changes; an hour is recorded only after
  delivery via `delivery.reports` succeeds. Security alerts use `delivery.security_alerts`.
- Replay: historical days replayed through the same owner session (day windows, journal and wiki pages).
  Its provider key is read separately from `jev.keyFile`; onboarding does not populate that file.
- Viewer: `127.0.0.1:3847` (MAMA_API_HOST/PORT), GET only: board, work, memory graph, wiki, logs,
  security events. Remote access through a tunnel requires a verified Cloudflare Access JWT or
  MAMA_AUTH_TOKEN; Host allowlist; every tunnelled or refused request is a security event; suspicious
  classes alert the owner through `delivery.security_alerts`.
- Traceability: model_runs, tool_traces (catalog and native tools, parent and child runs), mailbox rows,
  the shared owner-message ledger (reply state, destination, outbound keys and chunk progress), board slot writers, daemon.log
  lines with stimulus and model run ids, security event ids = alert keys.

## Development memory (plugin + MCP)

- MCP tools: save (decision | checkpoint | ingest), search, update, search_decisions_and_contracts,
  case_timeline_range; load_checkpoint.
- Plugin commands: /mama:decision, /mama:search, /mama:checkpoint, /mama:resume, /mama:configure (shows
  the effective settings). Hook: SessionStart only (read, edit and compaction hooks removed 2026-10-01).
  Switches: MAMA_DISABLE_HOOKS=true; MAMA_HOOK_FEATURES under MAMA_DAEMON=1; MAMA_DEBUG.
