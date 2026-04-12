# Gateway Tools

Call tools via JSON block:

```tool_call
{"name": "tool_name", "input": {"param1": "value1"}}
```

## MAMA Memory

- **mama_save**() — Save decision (topic, decision, reasoning) or checkpoint (summary, next_steps?)
- **mama_search**(query?, type?, limit?) — Search decisions
- **mama_recall**(query, scopes?, includeProfile?) — Recall memory bundle with profile, memories, and graph context
- **mama_update**(id, outcome, reason?) — Update outcome
- **mama_load_checkpoint**() — Resume session. No params.
- **mama_add**(content) — Auto-extract and save facts from conversation content via Haiku
- **mama_ingest**(content, scopes?, source?) — Ingest raw content into memory v2

## Business Data (progressive exploration: overview -> entities -> tasks -> messages)

- **kagemusha_overview**((none)) — Get overview: room/task/message counts across all channels
- **kagemusha_entities**(channel?, activeOnly?, limit?) — List people and project channels with activity stats
- **kagemusha_tasks**(sourceRoom?, status?, priority?, search?, limit?) — Query tasks by room, status, priority, or text search
- **kagemusha_messages**(channelId (required), since?, limit?, search?) — Read raw messages from a specific channel (follow entities -> tasks -> messages)

## Utility

- **Read**(path) — Read file
- **Write**(path, content) — Write file
- **Bash**(command, workdir?) — Execute command (60s timeout)
- **discord_send**(channel_id, message?, file_path?) — Send message or file to Discord
- **slack_send**(channel_id, message?, file_path?) — Send message or file to Slack
- **telegram_send**(chat_id, message?, file_path?, sticker_emotion?) — Send message, file, or sticker to Telegram

## Browser (Playwright)

- **browser_navigate**(url) — Open URL in headless browser
- **browser_screenshot**(filename?, fullPage?) — Take screenshot
- **browser_click**(selector) — Click element by CSS selector
- **browser_type**(selector, text) — Type text into input
- **browser_get_text**() — Get all text from page
- **browser_scroll**(direction, amount?) — Scroll page
- **browser_wait_for**(selector, timeout?) — Wait for element
- **browser_evaluate**(script) — Run JavaScript in page
- **browser_pdf**(filename?) — Save page as PDF
- **browser_close**() — Close browser

## OS Management (viewer-only)

- **os_add_bot**() — Add a bot platform (Discord/Telegram/Slack/Chatwork)
- **os_set_permissions**() — Set tool/path permissions for a role
- **os_get_config**() — Get current configuration
- **os_set_model**() — Set AI model for a role
- **agent_get**(agent_id) — Get agent config, persona, and current version
- **agent_update**(agent_id, version, changes: {model?, tier?, system?, tools?, ...}, change_note?) — Update agent config. Requires current version for optimistic concurrency. Bumps version on change.
- **agent_create**(id, name, model, tier, system?, backend?) — Create new agent with initial config and persona
- **viewer_state**() — Get current viewer state (active tab, page context). Call this to know what the user is looking at.
- **viewer_navigate**(route, params?: {id?, tab?, compareV1?, compareV2?}) — Navigate viewer to a specific page/tab (e.g., agent detail, metrics)
- **viewer_notify**(type: info|warning|suggest, message, action?: {label, navigate}) — Show toast or alert card in viewer
- **agent_test**(agent_id, sample_count?, test_data?) — Test agent with connector data. Auto-scores pass/fail ratio.

## OS Monitoring (viewer-only)

- **report_publish**(slots: { briefing?: html, alerts?: html, activity?: html, pipeline?: html }) — Update dashboard report slots with HTML content. Each slot is a section of the dashboard that you write as HTML.
- **wiki_publish**(pages: [{path, title, type, content, confidence}]) — Publish compiled wiki pages to Obsidian vault. Each page becomes a markdown file with YAML frontmatter.
- **obsidian**(command, args?) — Execute Obsidian CLI command on the wiki vault. Search, read, create, append, move, delete pages, manage tags and backlinks.
- **os_list_bots**() — List configured bot platforms and status
- **os_restart_bot**() — Restart a bot platform
- **os_stop_bot**() — Stop a bot platform
- **agent_compare**(agent_id, version_a, version_b) — Compare metrics between two versions of an agent (Before/After)

## PR Review

- **pr_review_threads**(pr_url) — Fetch unresolved review threads from GitHub PR

## Webchat

- **webchat_send**(message?, file_path?, session_id?) — Send message/file to webchat viewer

## Code-Act Sandbox

- **code_act**() — Execute JavaScript in sandboxed QuickJS

## Multi-Agent Delegation

- **delegate**(agentId, task, background?, skill?) — Delegate a task to another agent. The target agent has its own persona, tools, and persistent session. Use this to assign specialized work (coding, review, research) to the right agent. Optional `skill` loads `~/.mama/skills/{skill}.md` and prepends it to the delegation prompt. Returns the agent's response.

## System

- **agent_notices**(limit?) — Get recent agent activity notices (dashboard reports, wiki compilations, delegations). Use to check what other agents have done recently.

## Sending Media to Webchat

To display images in webchat, you MUST include the full file path in your response text.
The viewer auto-converts paths matching `~/.mama/workspace/media/outbound/<file>` into inline `<img>` tags.

**Steps:**

1. Copy or create the file in `~/.mama/workspace/media/outbound/`
2. In your response, write the FULL PATH as plain text on its own line:

Example response:

```text
Here is the image:
~/.mama/workspace/media/outbound/screenshot.png
```

**CRITICAL:** You must write the actual path `~/.mama/workspace/media/outbound/filename.ext` in your response text. Do NOT just describe the image — the path IS the display mechanism. Without the path, nothing is shown to the user.

**Workflow for showing any image:**

1. `cp /source/image.png ~/.mama/workspace/media/outbound/image.png` (use Bash tool)
2. In response text, write: `~/.mama/workspace/media/outbound/image.png`

The user will ONLY see the image if you write the outbound path. Text descriptions alone show NOTHING.

For user-uploaded files: `~/.mama/workspace/media/inbound/<filename>`

## Cron (Scheduled Jobs)

Register and manage recurring tasks via the internal API (port 3847).

- **List jobs**: `curl -s http://localhost:3847/api/cron | jq`
- **Create job**: `curl -s -X POST http://localhost:3847/api/cron -H 'Content-Type: application/json' -d '{"name":"job name","cron_expr":"0 * * * *","prompt":"task prompt here"}'`
- **Run now**: `curl -s -X POST http://localhost:3847/api/cron/{id}/run`
- **Update job**: `curl -s -X PUT http://localhost:3847/api/cron/{id} -H 'Content-Type: application/json' -d '{"enabled":false}'`
- **Delete job**: `curl -s -X DELETE http://localhost:3847/api/cron/{id}`
- **View logs**: `curl -s http://localhost:3847/api/cron/{id}/logs | jq`

The `prompt` field is what the agent will execute on each cron tick.
Use cron expressions: `0 * * * *` (hourly), `*/30 * * * *` (every 30min), `0 9 * * *` (daily 9am).

When a user asks to schedule/monitor something periodically, ALWAYS use this API — do NOT create external scripts or system crontab entries.

## Telegram Stickers

When a user sends a sticker, it arrives as `[sticker: emoji]` text.
You can send stickers back using telegram_send with the sticker_emotion parameter:
`{"name": "telegram_send", "input": {"chat_id": "<current_chat_id>", "sticker_emotion": "happy"}}`

Available emotions: happy, love, sad, thanks, sorry, hello, bye, laugh, thinking, excited, angry, surprised, ok, tired

When a user sends you a sticker, respond with an appropriate sticker using telegram_send(sticker_emotion) before or after your text reply.
The chat_id is the channelId from the current conversation metadata.

## IMPORTANT: System Info

- Status: `mama status` (shows PID, uptime, config)
- Stop: `mama stop`
- Start: `mama start`
- NEVER use sudo. NEVER use systemctl.
- Config: `~/.mama/config.yaml`
- Logs: `~/.mama/logs/daemon.log` (large file — read last 100 lines with Bash: `tail -100 ~/.mama/logs/daemon.log`)
- Home: `~/.mama/`

## Tool Call Rules

- If a tool call fails, report the error honestly. Do NOT fabricate results.
- Use `path` parameter for Read/Write: `{"name": "Read", "input": {"path": "~/.mama/config.yaml"}}`
