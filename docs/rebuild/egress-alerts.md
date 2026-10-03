# W35 — Outbound attempts are seen, not blocked

Owner decisions, 2026-10-03:

- **Web fetch and web search stay open.** Blocking them would stop the agent from doing the
  owner's work.
- **An attempt to send data out is seen.** To meet an owner request, the agent may try to
  publish or upload something on the web. Today such an attempt, refused or not, reaches no one.
- **Done** means an outbound attempt the agent makes in an owner turn reaches the owner as a
  security alert, and the event is in `logs/security-events.jsonl`.

Evidence:

- On 2026-10-03 the owner asked the agent to test the shell: a GET and a POST with an empty body
  were both refused with 403 by the sandbox proxy, and no alert was sent. The refusals are in
  `tool_traces` (native Bash, bounded input summary) and nowhere else.
- The sandbox allows no network host (`~/.mama/workspace/.claude/settings.json` has no network
  entries), so the shell cannot send today; native web fetch and web search run outside it.
- A security event path exists: `api/security-events.ts` writes `security-events.jsonl` and sends
  the owner an alert through `delivery.security_alerts`, grouping repeats of a class within ten
  minutes. Its classes are viewer requests only.
- The owner's standing rule for safety features is observation and alarm; enforcement only for
  irreversible sends.

## Work

| #     | What changes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Done when                                                                                                                                                                                                                                                                   |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| W35.1 | **Outbound attempt events.** `runtime/outbound-attempts.ts` wraps each run's native trace observer (`createNativeToolTraceObserver`, built by the action surface). A native shell call (Claude `Bash`, Codex `commandExecution`) whose command names a network client (curl, wget, nc, ssh, scp, rsync, ftp, telnet), a package install, a git remote operation, or a script calling an HTTP or socket library becomes an `outbound_attempt` event with the command as traced (bounded, secrets masked), whether it sends data, the run and the call id (the trace's `gateway_call_id`). It is reported when the call starts, refused or not; a call announced twice is reported once. Web fetch and web search stay in `tool_traces` only. Nothing is blocked. | Tests: a refused POST, a GET, an install and a git push are attempts; a local command, a script that only prints links, and web fetch or search are not; a masked secret stays masked; a call announced twice reports once; the sink is reached through the action surface. |
| W35.2 | **The owner is told.** `createOutboundEventRecorder` (`api/security-events.ts`, sharing the file and alert gate with the viewer recorder) appends the event to `security-events.jsonl` and sends it through `delivery.security_alerts`. Attempts within one minute of an alert are counted on the next alert instead of each sending one; replay turns record without alerting. The viewer's security table shows the command for these events.                                                                                                                                                                                                                                                                                                                 | Tests with a fake messenger: three attempts, two within a minute, give two alerts and three lines; replay sends none.                                                                                                                                                       |
| W35.3 | **Cutover in the testbed.** Deploy; the owner asks for the same POST test in Telegram.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | The owner receives the alert; the event is in `security-events.jsonl`; `daemon.log` is clean.                                                                                                                                                                               |

## Known limits

- Detection names network clients; a client it does not name (or an obfuscated command) is
  missed. It reads the command, not the network: a refused and a completed attempt look the same
  in the alert, and the trace row has the outcome.

## Out of scope

- Blocking or narrowing web fetch and web search.
- Alerts or a security log line for web fetch URLs and search queries: they stay in `tool_traces`;
  an alert waits for recorded cases.
- The Codex backend's shell network setting, which was not checked.
