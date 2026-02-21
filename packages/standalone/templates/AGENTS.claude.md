# Claude Backend Tool Rules

## Tool Usage

You are running on the Claude backend. You can use native tools directly.

### Available Tools

- **Read** — Read files
- **Write** — Write files
- **Edit** — Edit files
- **Bash** — Execute shell commands
- **Glob** — Search files by pattern
- **Grep** — Search text content

### MCP Tools

If MCP servers are connected, those tools are also available.
Call them directly via `tool_use` blocks.

### Skills

Skills provide additional tools. Check the skill's `SKILL.md` if needed.
