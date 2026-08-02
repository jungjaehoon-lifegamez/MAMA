# Configuration Options Reference

MAMA has TWO config files that are different things - no doc explained the
split before, and the old version of this page documented 14 keys with zero
readers in the codebase:

| File                  | Owner                       | Format | What it actually holds                                                                                                                                                                                                                                           |
| --------------------- | --------------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `~/.mama/config.json` | mama-core embedding runtime | JSON   | Exactly 5 keys: `configVersion`, `modelName`, `embeddingDim`, `quantized`, `cacheDir` (`packages/mama-core/src/config-loader.ts`). A v1→v2 migration actively rewrites e5-small/384 to e5-large/1024 - do not hand-set the old model.                            |
| `~/.mama/config.yaml` | MAMA OS daemon              | YAML   | Everything else: gateways, connectors, multi-agent personas, timeouts, `conductor.{enabled,tickMs,maxAgeMs,maxTurns,maxTokens}` (default `enabled: false`), report hours. Managed by `mama init`/setup; schema in `packages/standalone/src/cli/config/types.ts`. |

Things the old page claimed that DO NOT exist and were never read by any code:
`disable_hooks`, `db_path` (use the `MAMA_DB_PATH` env var), `search_limit`,
`recency_*`, `similarity_threshold`, `force_tier_2`, `lazy_load`, `cache_size`,
`hook_path`, `hook_timeout`, `debug`. If you set them, nothing happens.

---

## Environment Variables

| Variable                              | Override     | Example                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MAMA_DB_PATH`                        | `db_path`    | `export MAMA_DB_PATH=/custom/path`                                                                                                                                                                                                                                                                                                                                                                                        |
| `MAMA_DEBUG`                          | `debug`      | `export MAMA_DEBUG=true`                                                                                                                                                                                                                                                                                                                                                                                                  |
| `MAMA_PERSONA_NATIVE_TOOLS`           | — (env only) | `export MAMA_PERSONA_NATIVE_TOOLS=1` — re-enable Claude Code built-in tools in main-persona sessions (default: blocked; gateway tools are the only surface)                                                                                                                                                                                                                                                               |
| `MAMA_REPORT_WALL_SECONDS`            | — (env only) | `export MAMA_REPORT_WALL_SECONDS=900` — operator report envelope budget in seconds (min 60, max 1800, default 900)                                                                                                                                                                                                                                                                                                        |
| `MAMA_SECURITY_LOG_DIR`               | — (env only) | `export MAMA_SECURITY_LOG_DIR=/tmp/x` — redirect security telemetry (events/incidents/denylist). Test suites set this so fixtures never pollute live logs                                                                                                                                                                                                                                                                 |
| `MAMA_SECURITY_ALERT_CHANNELS`        | — (env only) | `export MAMA_SECURITY_ALERT_CHANNELS="telegram:<chat_id>"` — comma-separated `gateway:channel` targets for security + system-audit MAJOR alerts                                                                                                                                                                                                                                                                           |
| `MAMA_STAGE2_WORKORDERS`              | — (env only) | RETIRED in v0.28.0 — the workorder pipeline is the only system run path. Unset or `on` boots fine; an explicit `off`/`shadow` (the removed legacy/dual-run modes) fails the boot loudly instead of silently running the pipeline                                                                                                                                                                                          |
| `MAMA_TEMPORAL_RECONCILE`             | — (env only) | `export MAMA_TEMPORAL_RECONCILE=on` — temporal owner-task reconciliation, `off\|on`, default `off`. `on` requires envelope issuance enabled, a Claude/Codex/Cline backend, the trusted `task_temporal_reconcile` transport tool, and the Stage-2 consumer. Malformed flags or disabled envelope issuance fail before timer-bearing daemon services start. `off` pauses open temporal attempts for safe later resume.      |
| `MAMA_OPS_ALERT_CHAT`                 | — (env only) | `export MAMA_OPS_ALERT_CHAT=<chat_id>` — telegram chat for workorder retries-exhausted/stale-claim alarms. Falls back to `MAMA_TRIGGER_LOOP_REPORT_CHAT`; unset = log-only (boot says so loudly)                                                                                                                                                                                                                          |
| `MAMA_TRIGGER_LOOP`                   | — (env only) | Proactive connector monitoring is on by default. Set `MAMA_TRIGGER_LOOP=0` only to opt out. When `MAMA_TRIGGER_LOOP_REPORT_CHAT` is absent, the sole positive-ID entry in `telegram.allowed_chats` is used as the private owner report destination; ambiguous/group allowlists require an explicit report chat.                                                                                                           |
| `MAMA_TRIGGER_LOOP_REPORT_CHAT`       | — (env only) | `export MAMA_TRIGGER_LOOP_REPORT_CHAT=<chat_id>` — explicit Telegram destination for proactive and on-demand owner reports. The value must be a positive private-chat ID present in `telegram.allowed_chats`; it takes precedence over the sole-positive-ID allowlist fallback. If unset, MAMA uses that fallback only when it is unambiguous, otherwise report delivery stays disabled and logs the missing destination. |
| `MAMA_OCR_PYTHON`                     | — (env only) | Python executable for the owner image-translation tools. It must provide EasyOCR and Pillow. Resolution otherwise checks `~/.mama/ocr-env/bin/python3`, then `python3`; legacy local migration paths may also be recognized without being advertised.                                                                                                                                                                     |
| `MAMA_IMAGE_SCRIPT_DIR`               | — (env only) | Optional override for the packaged `ocr-image.py` and `fb-overlay.py` directory. Normally unset.                                                                                                                                                                                                                                                                                                                          |
| `MAMA_TELEGRAM_MEDIA_TTL_MS`          | — (env only) | Retention for inbound Telegram documents kept available to the active agent; default 24 hours.                                                                                                                                                                                                                                                                                                                            |
| `MAMA_TELEGRAM_MEDIA_MAX_TOTAL_BYTES` | — (env only) | Cumulative private Telegram-media quota; default 256 MiB. Expired and oldest files are removed first.                                                                                                                                                                                                                                                                                                                     |

**Priority:** Environment variables override config file.

## Agent backend keys

These keys live under `agent` in `~/.mama/config.yaml`:

| Key              | Values / purpose                                                                |
| ---------------- | ------------------------------------------------------------------------------- |
| `backend`        | `claude`, `codex`, or `cline`                                                   |
| `model`          | Backend model identifier                                                        |
| `timeout`        | Full prompt-operation deadline in milliseconds                                  |
| `cline_command`  | Optional absolute Cline CLI executable path                                     |
| `cline_provider` | Cline provider identifier; defaults to `cline`                                  |
| `cline_data_dir` | Optional isolated Cline state directory; `~` expands against the real user home |

Managed agents may independently set `backend: cline`. Their `tool_permissions` are translated to
Cline native tools, while `gateway_tool_permissions` remains the separate Code-Act host-function
surface. Blocked native permissions take precedence and delegation still requires Tier 1 plus
`can_delegate: true`.

The legacy `io.context_threshold_tokens` and `io.max_context_tokens` keys (and their
`MAMA_IO_CONTEXT_THRESHOLD_TOKENS` / `MAMA_IO_MAX_CONTEXT_TOKENS` overrides) remain parseable only
for configuration compatibility. They are deprecated no-ops: Claude Code, Codex app-server, and
Cline Hub own compaction for their durable sessions. A future breaking release may remove these
keys after the compatibility window.

### Temporal Reconciliation Runtime

The temporal scanner interval and safety limits are currently fixed host contracts rather than
configuration knobs:

- scan every 60 seconds;
- admit at most four exact/deferred and one date-only candidate per scan;
- allow at most ten open temporal workorders;
- retry each occurrence at most three times, including stale-claim recovery;
- keep exhausted generations terminal and schedule deferred results as distinct future
  generations;
- stop new admission and durably pause open temporal attempts before awaiting worker drainage.

`due_at` accepts only valid RFC 3339 instants with `Z` or an explicit numeric offset. Legacy
`YYYY-MM-DD` deadlines remain supported and retain date-only precision. The read-only
`temporal_state` category is a separate projection that never mutates lifecycle status; `closed`
reflects `done`/`cancelled`, but no configuration maps overdue to `blocked` or elapsed time to
`done`.

Trello and any configured private connector remain untrusted read-only evidence, while the native
task ledger remains owner-task truth. The flag does not enable direct connector writes,
cross-store lifecycle copying, or exactly-once external alarm delivery.

---

## See Also

- [Configuration Guide](../guides/configuration.md) - Detailed configuration guide
- [Performance Tuning](../guides/performance-tuning.md) - Optimization strategies
