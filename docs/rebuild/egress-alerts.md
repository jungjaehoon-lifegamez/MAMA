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

| #     | What changes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Done when                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| W35.1 | **Outbound attempt events.** `runtime/outbound-attempts.ts` wraps each run's native trace observer (`createNativeToolTraceObserver`, built by the action surface). A native shell call (Claude `Bash`, Codex `commandExecution`, which arrives as one `/bin/zsh -c "..."` string) is an attempt when a network client (curl, wget, nc, ssh, scp, rsync, ftp, telnet, httpie, rclone, gsutil), a package install, a git remote operation, `gh api`/`gist`/`release upload`, `aws s3` copy, or a script calling an HTTP or socket library stands in command position: at the start, after a separator, a line break or an opening quote, optionally behind sudo/env/time/xargs and a directory. It is `outbound_send` when the command sends data and `outbound_attempt` otherwise, with the command as traced (bounded, secrets masked), the run and the call id (the trace's `gateway_call_id`). It is reported when the call starts, refused or not, once per call. Web fetch and web search stay in `tool_traces` only. Nothing is blocked. | Tests: uploads in each form (including `/usr/bin/curl`, a Codex-wrapped command and a second script line) are sends; a GET, `curl -D`, installs and fetches are attempts; `grep curl`, `which curl`, `echo "use curl"`, `urllib.parse` and a script that prints links are not; a secret stays masked; a call announced twice reports once; the sink is reached through the action surface and the daemon.                   |
| W35.2 | **The owner is told.** `createOutboundEventRecorder` (`api/security-events.ts`, sharing the file and alert gate with the viewer recorder) appends every event to `security-events.jsonl` and sends it through `delivery.security_alerts`. An `outbound_send` alert is never grouped, so a harmless request cannot hide an upload after it; `outbound_attempt` alerts within one minute are counted on the next one. Replay turns record without alerting. The viewer's security table shows the command for these events.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Tests with a fake messenger: a GET followed by two uploads gives three alerts; three plain attempts, two within a minute, give two alerts and three lines; replay sends none; the daemon's owner runtime reaches the security log and the owner.                                                                                                                                                                            |
| W35.3 | **Cutover in the testbed.** Deploy; the owner asks for the same POST test in Telegram.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | The owner receives the alert; the event is in `security-events.jsonl`; `daemon.log` is clean.                                                                                                                                                                                                                                                                                                                               |
| W35.4 | **The sandbox's own network is seen.** A command can hide its client (a script file written first and run after). The daemon starts a deny-all proxy on two loopback ports (`runtime/egress-proxy.ts`: HTTP CONNECT and plain requests, SOCKS5) and writes them into the owner workspace's Claude settings (`sandbox.network.httpProxyPort`/`socksProxyPort`), so every connection from inside the shell sandbox, from any client or script, reaches it. It refuses each one (403, SOCKS reply 2) and records an `outbound_connect` event with the method and destination (a plain request's path is left out). A tunnel's content is encrypted, so whether it sends data is unknown; a plain POST, PUT or PATCH sends. Connections are grouped in a burst like plain attempts; a known send always alerts. The proxy closes after the owner runtime.                                                                                                                                                                                         | Tests: a tunnel, a plain POST sent in pieces and two SOCKS5 forms are refused and reported; the settings carry the ports only when given; the recorder alerts a connection with its destination; a daemon boot test refuses a tunnel through the ports the owner runtime received and the owner is told. Live (2026-10-03 experiment): a Python script's POST and a curl inside it reached the proxy as `CONNECT host:443`. |

## Paths out of the shell, and what sees them

Checked on the Claude backend, 2026-10-03, by tests and one sandboxed experiment; no bypass was
attempted on the owner's machine.

| Path                                                        | Blocked by                                               | Seen by                                                              |
| ----------------------------------------------------------- | -------------------------------------------------------- | -------------------------------------------------------------------- |
| A network client in the command (curl, wget, git, pip, ...) | MAMA's proxy refuses it                                  | the command alert (W35.1) and the proxy alert (W35.4)                |
| A script file written first and run after                   | MAMA's proxy refuses it                                  | the proxy alert, with the destination                                |
| A subagent's shell                                          | the same sandbox and proxy                               | the same alerts; its traces carry its own run                        |
| A direct socket that ignores the proxy settings             | the operating system sandbox (`Operation not permitted`) | the kernel log (`deny(1) network-outbound`, port only); no alert yet |
| Web fetch and web search                                    | not blocked (the owner's work needs them)                | `tool_traces` only                                                   |
| Files and messages to the owner                             | only the owner's messengers, board and wiki              | receipts and `tool_traces`                                           |

## Known limits

- The command alert reads the command, not the network: a client it does not name or an
  obfuscated command is missed there; the proxy alert sees its connection if it honours the
  sandbox proxy.
- A tunnel's content is encrypted: the proxy sees the destination, not whether data was sent.
- A direct socket that ignores the proxy is refused by the operating system and only appears in
  the kernel log, without its address; attributing those lines to MAMA's processes is not built.
- The proxy does not know the run; the alert time correlates with `tool_traces`.
- A client named inside a quoted example (`echo "curl ..."`) is reported; one alert is the cost.
- The Codex backend keeps its own sandbox network setting and is not covered by the proxy.

## Out of scope

- Blocking or narrowing web fetch and web search.
- Alerts or a security log line for web fetch URLs and search queries: they stay in `tool_traces`;
  an alert waits for recorded cases.
- The Codex backend's shell network setting, which was not checked.
