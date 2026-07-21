# Configuration Options Reference

Complete reference for all MAMA configuration options.

---

## Configuration File Location

```
~/.mama/config.json
```

**Format:** JSON

---

## All Options

### Core Settings

| Option            | Type    | Default                          | Description                         |
| ----------------- | ------- | -------------------------------- | ----------------------------------- |
| `disable_hooks`   | boolean | `false`                          | Disable automatic context injection |
| `embedding_model` | string  | `"Xenova/multilingual-e5-small"` | Embedding model name                |
| `db_path`         | string  | `"~/.claude/mama-memory.db"`     | SQLite database path                |
| `search_limit`    | number  | `10`                             | Max results returned                |
| `debug`           | boolean | `false`                          | Enable debug logging                |

### Search Configuration

| Option                 | Type   | Default | Description               |
| ---------------------- | ------ | ------- | ------------------------- |
| `recency_weight`       | number | `0.3`   | Recency importance (0-1)  |
| `recency_scale`        | number | `7`     | Days until 50% decay      |
| `recency_decay`        | number | `0.5`   | Score multiplier at scale |
| `similarity_threshold` | number | `0.5`   | Minimum similarity (0-1)  |

### Performance Tuning

| Option         | Type    | Default | Description             |
| -------------- | ------- | ------- | ----------------------- |
| `force_tier_2` | boolean | `false` | Force exact match mode  |
| `lazy_load`    | boolean | `true`  | Load model on first use |
| `cache_size`   | number  | `100`   | Max cached embeddings   |

### Hook Settings

| Option         | Type   | Default           | Description           |
| -------------- | ------ | ----------------- | --------------------- |
| `hook_path`    | string | `"scripts/hooks"` | Custom hook directory |
| `hook_timeout` | number | `500`             | Hook timeout (ms)     |

---

## Example Configurations

### Speed-Optimized

```json
{
  "embedding_model": "Xenova/multilingual-e5-small",
  "search_limit": 5,
  "recency_weight": 0.1
}
```

### Accuracy-Optimized

```json
{
  "embedding_model": "Xenova/gte-large",
  "search_limit": 20,
  "recency_weight": 0.3,
  "similarity_threshold": 0.6
}
```

### Privacy-Focused

```json
{
  "disable_hooks": true,
  "db_path": "/encrypted/volume/mama-memory.db"
}
```

---

## Environment Variables

| Variable                       | Override        | Example                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------ | --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MAMA_DISABLE_HOOKS`           | `disable_hooks` | `export MAMA_DISABLE_HOOKS=true`                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `MAMA_DB_PATH`                 | `db_path`       | `export MAMA_DB_PATH=/custom/path`                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `MAMA_FORCE_TIER_2`            | `force_tier_2`  | `export MAMA_FORCE_TIER_2=true`                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `MAMA_DEBUG`                   | `debug`         | `export MAMA_DEBUG=true`                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `MAMA_PERSONA_NATIVE_TOOLS`    | — (env only)    | `export MAMA_PERSONA_NATIVE_TOOLS=1` — re-enable Claude Code built-in tools in main-persona sessions (default: blocked; gateway tools are the only surface)                                                                                                                                                                                                                                                                                                                                    |
| `MAMA_REPORT_WALL_SECONDS`     | — (env only)    | `export MAMA_REPORT_WALL_SECONDS=900` — operator report envelope budget in seconds (min 60, max 1800, default 900)                                                                                                                                                                                                                                                                                                                                                                             |
| `MAMA_SECURITY_LOG_DIR`        | — (env only)    | `export MAMA_SECURITY_LOG_DIR=/tmp/x` — redirect security telemetry (events/incidents/denylist). Test suites set this so fixtures never pollute live logs                                                                                                                                                                                                                                                                                                                                      |
| `MAMA_SECURITY_ALERT_CHANNELS` | — (env only)    | `export MAMA_SECURITY_ALERT_CHANNELS="telegram:<chat_id>"` — comma-separated `gateway:channel` targets for security + system-audit MAJOR alerts                                                                                                                                                                                                                                                                                                                                                |
| `MAMA_STAGE2_WORKORDERS`       | — (env only)    | `export MAMA_STAGE2_WORKORDERS=shadow` — Stage-2 workorder migration, TRI-STATE `off\|shadow\|on` (deliberate deviation from the `=1` convention; malformed values fail the boot). `shadow` dual-runs the BOARD only: legacy publishes live while the workorder consumer captures to `~/.mama/operator/shadow-capture.jsonl`; wiki/promotion stay legacy until `on`. Transition flag — removed at cutover                                                                                      |
| `MAMA_TEMPORAL_RECONCILE`      | — (env only)    | `export MAMA_TEMPORAL_RECONCILE=on` — temporal owner-task reconciliation, `off\|on`, default `off`. `on` requires `MAMA_STAGE2_WORKORDERS=on`, envelope issuance enabled, a Claude/Codex backend, the trusted `task_temporal_reconcile` transport tool, and the Stage-2 consumer. Malformed flags, disabled envelope issuance, or a Stage-2 mismatch fail before timer-bearing daemon services start; a mismatch first pauses open temporal attempts. `off` pauses them for safe later resume. |
| `MAMA_OPS_ALERT_CHAT`          | — (env only)    | `export MAMA_OPS_ALERT_CHAT=<chat_id>` — telegram chat for workorder retries-exhausted/stale-claim alarms. Falls back to `MAMA_TRIGGER_LOOP_REPORT_CHAT`; unset = log-only (boot says so loudly)                                                                                                                                                                                                                                                                                               |

**Priority:** Environment variables override config file.

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

Trello remains untrusted connector evidence, Kagemusha remains read-only project-task truth, and
the native task ledger remains owner-task truth. The flag does not enable direct Trello writes,
cross-store lifecycle copying, or exactly-once external alarm delivery.

---

## See Also

- [Configuration Guide](../guides/configuration.md) - Detailed configuration guide
- [Performance Tuning](../guides/performance-tuning.md) - Optimization strategies
