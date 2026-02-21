# Codex Backend Tool Rules

## Tool Usage

You are running on the Codex backend. Use gateway tools via `tool_call` JSON blocks.

### How to Call Tools

```tool_call
{"name": "tool_name", "input": {"param1": "value1"}}
```

### Available Gateway Tools

- **mama_search**(query?, type?, limit?) — Search decisions in MAMA memory
- **mama_save**(type, topic?, decision?, reasoning?) — Save decision or checkpoint
- **mama_update**(id, outcome, reason?) — Update decision outcome
- **mama_load_checkpoint**() — Load last checkpoint
- **discord_send**(channel_id, message?) — Send message to Discord channel
- **slack_send**(channel_id, message?) — Send message to Slack channel
- **Read**(path) — Read file
- **Write**(path, content) — Write file
- **Bash**(command) — Execute shell command

### Important

- Do NOT use `exec_command` or `apply_patch` — use gateway tools instead
- Tool calls are executed automatically. No need to use curl or Bash for these.

### Skills

Skills provide additional tools. Check the skill's `SKILL.md` if needed.
