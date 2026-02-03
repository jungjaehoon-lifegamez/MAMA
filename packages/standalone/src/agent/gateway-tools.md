# Gateway Tools Reference

## Important: Gateway Tools vs Skills

- **Gateway Tools**: Programmatic functions that execute code and return structured data
- **Skills**: Markdown templates triggered by keywords (different system)

---

## How to Call Gateway Tools

Output a JSON block in this EXACT format:

```tool_call
{"name": "tool_name", "input": {"param1": "value1"}}
```

The system will:

1. Parse your tool_call block
2. Execute the tool via GatewayToolExecutor
3. Return the result in the next message

---

## MAMA Memory Tools

### mama_search

Search decisions and checkpoints semantically.

| Parameter | Type   | Required | Description                                  |
| --------- | ------ | -------- | -------------------------------------------- |
| query     | string | No       | Search query. Empty = list recent            |
| type      | string | No       | 'decision', 'checkpoint', or 'all' (default) |
| limit     | number | No       | Max results (default: 10)                    |

### mama_save

Save a decision or checkpoint.

| Parameter | Type   | Required | Description                |
| --------- | ------ | -------- | -------------------------- |
| type      | string | Yes      | 'decision' or 'checkpoint' |

**For decision:**

| Parameter  | Type   | Required | Description              |
| ---------- | ------ | -------- | ------------------------ |
| topic      | string | Yes      | Topic identifier         |
| decision   | string | Yes      | The decision made        |
| reasoning  | string | Yes      | Why this decision        |
| confidence | number | No       | 0.0 - 1.0 (default: 0.5) |

**For checkpoint:**

| Parameter  | Type   | Required | Description                   |
| ---------- | ------ | -------- | ----------------------------- |
| summary    | string | Yes      | Session state summary         |
| next_steps | string | No       | Instructions for next session |
| open_files | array  | No       | Currently relevant files      |

### mama_update

Update a decision's outcome.

| Parameter | Type   | Required | Description                       |
| --------- | ------ | -------- | --------------------------------- |
| id        | string | Yes      | Decision ID                       |
| outcome   | string | Yes      | 'success', 'failed', or 'partial' |
| reason    | string | No       | Explanation                       |

### mama_load_checkpoint

Load the last saved checkpoint. No parameters.

---

## Browser Tools (Playwright)

### browser_navigate

Navigate to a URL.

| Parameter | Type   | Required | Description        |
| --------- | ------ | -------- | ------------------ |
| url       | string | Yes      | URL to navigate to |

### browser_screenshot

Take a screenshot.

| Parameter | Type    | Required | Description       |
| --------- | ------- | -------- | ----------------- |
| filename  | string  | No       | Output filename   |
| full_page | boolean | No       | Capture full page |

### browser_click

Click an element.

| Parameter | Type   | Required | Description  |
| --------- | ------ | -------- | ------------ |
| selector  | string | Yes      | CSS selector |

### browser_type

Type text into an element.

| Parameter | Type   | Required | Description  |
| --------- | ------ | -------- | ------------ |
| selector  | string | Yes      | CSS selector |
| text      | string | Yes      | Text to type |

### browser_get_text

Get page text content. No parameters.

### browser_scroll

Scroll the page.

| Parameter | Type   | Required | Description                   |
| --------- | ------ | -------- | ----------------------------- |
| direction | string | Yes      | 'up', 'down', 'top', 'bottom' |
| amount    | number | No       | Pixels to scroll              |

### browser_wait_for

Wait for an element.

| Parameter | Type   | Required | Description   |
| --------- | ------ | -------- | ------------- |
| selector  | string | Yes      | CSS selector  |
| timeout   | number | No       | Timeout in ms |

### browser_evaluate

Execute JavaScript in the page.

| Parameter | Type   | Required | Description     |
| --------- | ------ | -------- | --------------- |
| script    | string | Yes      | JavaScript code |

### browser_pdf

Generate a PDF of the page.

| Parameter | Type   | Required | Description     |
| --------- | ------ | -------- | --------------- |
| filename  | string | No       | Output filename |

### browser_close

Close the browser. No parameters.

---

## Utility Tools

### discord_send

Send a message to Discord.

| Parameter  | Type   | Required | Description        |
| ---------- | ------ | -------- | ------------------ |
| channel_id | string | Yes      | Discord channel ID |
| message    | string | No       | Text message       |
| file_path  | string | No       | File to send       |

### Read

Read a file (restricted to ~/.mama/).

| Parameter | Type   | Required | Description |
| --------- | ------ | -------- | ----------- |
| path      | string | Yes      | File path   |

### Write

Write a file.

| Parameter | Type   | Required | Description  |
| --------- | ------ | -------- | ------------ |
| path      | string | Yes      | File path    |
| content   | string | Yes      | File content |

### Bash

Execute a bash command.

| Parameter | Type   | Required | Description       |
| --------- | ------ | -------- | ----------------- |
| command   | string | Yes      | Command to run    |
| workdir   | string | No       | Working directory |

---

## OS Management Tools (Viewer Only)

These tools are only available from MAMA OS Viewer and require `systemControl` permission.

### os_add_bot

Add a new bot configuration (Discord, Telegram, Slack, Chatwork).

| Parameter          | Type   | Required | Description                                |
| ------------------ | ------ | -------- | ------------------------------------------ |
| platform           | string | Yes      | 'discord', 'telegram', 'slack', 'chatwork' |
| token              | string | Varies   | Bot token (Discord, Telegram, Chatwork)    |
| bot_token          | string | Slack    | Slack bot token                            |
| app_token          | string | Slack    | Slack app token (socket mode)              |
| default_channel_id | string | No       | Default notification channel               |
| allowed_chats      | array  | No       | Telegram: allowed chat IDs                 |
| room_ids           | array  | No       | Chatwork: room IDs to monitor              |

**Example:**

```tool_call
{"name": "os_add_bot", "input": {"platform": "discord", "token": "YOUR_BOT_TOKEN"}}
```

### os_set_permissions

Modify role permissions for agent access control.

| Parameter       | Type    | Required | Description                            |
| --------------- | ------- | -------- | -------------------------------------- |
| role            | string  | Yes      | Role name to modify/create             |
| allowedTools    | array   | No       | Tools to allow (wildcards: "mama\_\*") |
| blockedTools    | array   | No       | Tools to block (takes precedence)      |
| allowedPaths    | array   | No       | Allowed file paths (glob patterns)     |
| systemControl   | boolean | No       | Enable system control operations       |
| sensitiveAccess | boolean | No       | Enable sensitive data access           |
| mapSource       | string  | No       | Map a source to this role              |

**Example:**

```tool_call
{"name": "os_set_permissions", "input": {"role": "custom_bot", "allowedTools": ["mama_*", "Read"], "blockedTools": ["Bash"], "mapSource": "telegram"}}
```

### os_get_config

Get current MAMA configuration (sensitive data masked by default).

| Parameter        | Type    | Required | Description                                    |
| ---------------- | ------- | -------- | ---------------------------------------------- |
| section          | string  | No       | Specific section (agent, roles, discord, etc.) |
| includeSensitive | boolean | No       | Show unmasked tokens (viewer only)             |

**Example:**

```tool_call
{"name": "os_get_config", "input": {"section": "roles"}}
```

---

## OS Monitoring Tools (Viewer Only)

These tools monitor and control running bots. They require `systemControl` permission.

### os_list_bots

List all configured bots and their current status.

| Parameter | Type   | Required | Description                   |
| --------- | ------ | -------- | ----------------------------- |
| platform  | string | No       | Filter by platform (optional) |

**Returns:** Array of bot status objects with:

- `platform`: Bot platform
- `enabled`: Whether bot is enabled in config
- `configured`: Whether bot has configuration
- `status`: 'running', 'stopped', 'error', or 'not_configured'
- `error`: Error message if status is 'error'

**Example:**

```tool_call
{"name": "os_list_bots", "input": {}}
```

### os_restart_bot

Restart a running bot. Requires `systemControl` permission.

| Parameter | Type   | Required | Description                         |
| --------- | ------ | -------- | ----------------------------------- |
| platform  | string | Yes      | Platform to restart (discord, etc.) |

**Example:**

```tool_call
{"name": "os_restart_bot", "input": {"platform": "discord"}}
```

### os_stop_bot

Stop a running bot. Requires `systemControl` permission.

| Parameter | Type   | Required | Description                      |
| --------- | ------ | -------- | -------------------------------- |
| platform  | string | Yes      | Platform to stop (discord, etc.) |

**Example:**

```tool_call
{"name": "os_stop_bot", "input": {"platform": "telegram"}}
```
