# Gateway Tools

Call tools via JSON block:

```tool_call
{"name": "tool_name", "input": {"param1": "value1"}}
```

## Memory

- **mama_search** — Search decisions. Params: query?, type?, limit?
- **mama_save** — Save decision (topic, decision, reasoning) or checkpoint (summary, next_steps?)
- **mama_update** — Update outcome. Params: id, outcome, reason?
- **mama_load_checkpoint** — Resume session. No params.

## Utility

- **Read**(path) — Read file
- **Write**(path, content) — Write file
- **Bash**(command, workdir?) — Execute command (60s timeout)
- **discord_send**(channel_id, message?, file_path?) — Send message or file to Discord. Use file_path to send images/documents (e.g. from ~/.mama/workspace/media/inbound/)
- **slack_send**(channel_id, message?, file_path?) — Send message or file to a Slack channel

## Webchat

- **webchat_send**(message?, file_path?, session_id?) — Send a file or message to the webchat viewer. Copies the file to outbound directory and returns the path for inline rendering. The `message` field in the result should be included in your response text so the viewer can render it.

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

## Playground

- **playground_create**(name, html?, file_path?, description?) — Create an interactive HTML playground. At least one of `html` or `file_path` is required. If `file_path` is provided, it takes priority over `html`. Use `file_path` for large HTML instead of inline `html`.

**IMPORTANT:** When the user asks for a playground, explorer, visualizer, interactive tool, or similar, you MUST use this tool.
Do NOT use Write tool to create HTML files directly — only `playground_create` registers the file in `index.json` so it appears in the Viewer Playground tab.

**Inline HTML example:**

```tool_call
{"name": "playground_create", "input": {"name": "Color Palette Explorer", "html": "<!doctype html><html>..full HTML..</html>", "description": "Color palette exploration tool"}}
```

**File path example (preferred for large HTML):**

First write the HTML file to the workspace, then reference it:

```tool_call
{"name": "playground_create", "input": {"name": "Data Dashboard", "file_path": "~/.mama/workspace/dashboard.html", "description": "Interactive data dashboard"}}
```

**HTML requirements:**

- Self-contained (no external CDN, all CSS/JS inline)
- Structure: Control panel → Live preview → Prompt output (Copy + Send to Chat buttons)
- Send to Chat: `window.parent.postMessage({ type: 'playground:sendToChat', message: text }, '*')` — Viewer receives and forwards to chat
- Never put real newlines inside JS string literals — always use `\n` escape

Returns: `{ success: true, url: "/playgrounds/{slug}.html", slug: "..." }`

## Browser (Playwright)

- **browser_navigate**(url) — Open URL in headless browser. Returns title and final URL.
- **browser_screenshot**(filename?, fullPage?) — Take screenshot. Saved to /tmp/mama-screenshots/. Use discord_send to share the image.
- **browser_click**(selector) — Click element by CSS selector.
- **browser_type**(selector, text) — Type text into input element.
- **browser_get_text**() — Get all text content from current page.
- **browser_scroll**(direction, amount?) — Scroll page. direction: up/down/top/bottom.
- **browser_wait_for**(selector, timeout?) — Wait for element to appear.
- **browser_evaluate**(script) — Run JavaScript in page context.
- **browser_pdf**(filename?) — Save page as PDF (Chromium only).
- **browser_close**() — Close browser. Call when done browsing.

Example workflow: navigate → get_text or screenshot → close.

## PR Review

- **pr_review_threads**(pr_url) — Fetch unresolved review threads from GitHub PR. Returns threads grouped by file with comment body, line, author. Also accepts (owner, repo, pr_number).

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
