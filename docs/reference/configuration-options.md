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

| Variable                       | Override        | Example                                                                                                                                                     |
| ------------------------------ | --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MAMA_DISABLE_HOOKS`           | `disable_hooks` | `export MAMA_DISABLE_HOOKS=true`                                                                                                                            |
| `MAMA_DB_PATH`                 | `db_path`       | `export MAMA_DB_PATH=/custom/path`                                                                                                                          |
| `MAMA_FORCE_TIER_2`            | `force_tier_2`  | `export MAMA_FORCE_TIER_2=true`                                                                                                                             |
| `MAMA_DEBUG`                   | `debug`         | `export MAMA_DEBUG=true`                                                                                                                                    |
| `MAMA_PERSONA_NATIVE_TOOLS`    | — (env only)    | `export MAMA_PERSONA_NATIVE_TOOLS=1` — re-enable Claude Code built-in tools in main-persona sessions (default: blocked; gateway tools are the only surface) |
| `MAMA_REPORT_WALL_SECONDS`     | — (env only)    | `export MAMA_REPORT_WALL_SECONDS=900` — operator report envelope budget in seconds (min 60, max 1800, default 900)                                          |
| `MAMA_SECURITY_LOG_DIR`        | — (env only)    | `export MAMA_SECURITY_LOG_DIR=/tmp/x` — redirect security telemetry (events/incidents/denylist). Test suites set this so fixtures never pollute live logs   |
| `MAMA_SECURITY_ALERT_CHANNELS` | — (env only)    | `export MAMA_SECURITY_ALERT_CHANNELS="telegram:<chat_id>"` — comma-separated `gateway:channel` targets for security + system-audit MAJOR alerts             |

**Priority:** Environment variables override config file.

---

## See Also

- [Configuration Guide](../guides/configuration.md) - Detailed configuration guide
- [Performance Tuning](../guides/performance-tuning.md) - Optimization strategies
