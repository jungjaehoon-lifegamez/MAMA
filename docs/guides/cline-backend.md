# Cline Backend

MAMA can use the Cline CLI as a main or per-agent backend. The default Cline model selected by
`mama init --backend cline` is `deepseek/deepseek-v4-flash` through Cline's hosted provider.

## Setup

```bash
npm install -g cline
cline auth cline
mama init --backend cline
```

Cline's hosted free-model catalog and quota can change. Confirm the model remains available in
your Cline account before relying on it for unattended work.

The equivalent manual configuration is:

```yaml
agent:
  backend: cline
  model: deepseek/deepseek-v4-flash
  cline_provider: cline
  # cline_command: /absolute/path/to/cline
  # cline_data_dir: ~/.mama/.cline
```

Managed agents can select Cline independently:

```yaml
multi_agent:
  agents:
    reviewer:
      backend: cline
      model: deepseek/deepseek-v4-flash
      useCodeAct: true
```

## Runtime contract

- MAMA loads the companion `@cline/core` runtime shipped with the configured Cline CLI and attaches
  to Cline's official Hub. It does not spawn a one-shot `cline --json` process for each message.
- A live MAMA route stays bound to one Cline Hub session. The full policy is installed when the
  session starts; later turns send only the new user message. If the Hub session is gone, MAMA
  rebuilds the current policy and bounded persisted conversation exactly once in a replacement
  session. A MAMA daemon restart may also take this bounded rebuild path.
- MAMA projects Code-Act as a session-bound Cline custom tool. The call returns through the active
  prompt's host bridge, so it does not depend on child-process MCP environment variables or a
  second tool protocol parser.
- Cline auto-approves only the native tools projected from the active MAMA role or managed-agent
  `tool_permissions`. Canonical permissions such as `Read`, `Grep`, `Bash`, and `Write` are mapped
  to Cline's native tool names; blocked tools take precedence. Delegation is enabled only for a
  Tier-1 managed agent with `can_delegate: true`. The verified owner role is not a wildcard bypass.
- MAMA gateway functions invoked through Code-Act still enforce their existing role, envelope,
  connector, and prompt-attempt context boundaries.
- Prompt-attempt execution context is bound to the active Hub session tool callback and is retired
  when that prompt completes. A deadline, owner cancellation, Hub transport failure, or daemon
  shutdown waits a bounded interval for an already-started mutation to settle. Ambiguous outcomes
  are structural, non-retryable failures so workorders cannot replay them automatically.
- A timed-out or interrupted Hub session is quarantined before the next turn. The next turn starts
  a replacement session with the complete current policy and bounded persisted conversation.
- Provider failures are classified without copying raw provider payloads into logs or activity
  storage. Cline hosted daily-limit failures surface as retryable rate limits with a bounded
  duration hint when one is present.
- Setup, scheduled jobs, and conversation-memory extraction use isolated Cline Hub runners when
  Cline is the configured primary backend. They do not probe or launch Claude as a side channel;
  the Claude OAuth keepalive is disabled on Cline installations.
- Telegram, Discord, and Slack image blocks remain on the private workspace media path and are
  presented to Cline through its permitted native `read_files` capability. The Anthropic vision
  client is used only when the configured primary backend is Claude.

This follows Cline's own connector architecture: connectors retain a Hub session client and send
later input to the bound session rather than using CLI `--id` as a per-message resume shortcut. See
the official [Hub-and-spoke architecture](https://docs.cline.bot/sdk/architecture/hub-spoke) and
[Cline CLI source](https://github.com/cline/cline/tree/main/apps/cli/src/connectors).

If startup reports that Cline is missing, set `agent.cline_command` or
`MAMA_CLINE_COMMAND` (legacy alias: `CLINE_COMMAND`) to an executable path.
