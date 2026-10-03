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

| #     | What changes                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Done when                                                                                                      |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| W35.1 | **Outbound attempt events.** Where native tool calls are traced (`createNativeToolTraceObserver`, carried by the action surface), a native Bash call whose command opens a network connection (an HTTP client, a socket tool, a package install), and its refusal when the result shows one, becomes a security event of a new class with the command summary as traced. Web fetch URLs and web search queries are written to the same log without an alert. Nothing is blocked. | Tests: a refused POST, an allowed fetch and an ordinary local command each produce the expected event or none. |
| W35.2 | **The owner is told.** An outbound attempt event is sent through `delivery.security_alerts` with the run it came from, grouped like the existing classes.                                                                                                                                                                                                                                                                                                                        | A test with a fake messenger receives one alert for two attempts within ten minutes.                           |
| W35.3 | **Cutover in the testbed.** Deploy; the owner asks for the same POST test in Telegram.                                                                                                                                                                                                                                                                                                                                                                                           | The owner receives the alert; the event is in `security-events.jsonl`; `daemon.log` is clean.                  |

## Out of scope

- Blocking or narrowing web fetch and web search.
- Alerts for the content of a web fetch URL or a search query; that waits for recorded cases.
- The Codex backend's shell network setting, which was not checked.
