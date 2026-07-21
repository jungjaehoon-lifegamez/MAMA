# Codex Backend Tool Rules

## Tool Usage

You are running on the Codex backend. MAMA exposes the tools permitted for this run as native host tools. Call those tools directly through the model tool interface.

Do not print Markdown tool blocks or JavaScript as a substitute for a tool call. The available native tool set is injected for each run and already reflects the current role and channel permissions.

### Skills

Skills provide additional tools. Check the skill's `SKILL.md` if needed.
