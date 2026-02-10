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
- **discord_send**(channel_id, message?, file_path?) — Send to Discord

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
