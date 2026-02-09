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

- Service name: **mama-os** (NOT "mama")
- Status: `systemctl --user status mama-os`
- Restart: `systemctl --user restart mama-os` (automatic 3s delay — **always confirm with user before executing**)
- NEVER use sudo. NEVER use service name "mama".
- Config: `~/.mama/config.yaml`
- Logs: `~/.mama/logs/daemon.log`
- Home: `~/.mama/`
