# Channel Key Backfill

**Category:** Operations (Runbook)
**Audience:** Operators of a live MAMA OS install
**Script:** `packages/standalone/scripts/backfill-channel-keys.ts`

---

## What this repairs

Six of seven connectors wrote `item.channel` as a human **display name**, while
`~/.mama/connectors.json` declares the same channel under the upstream's stable **id**.
Channel binding absorbed the difference with a name fallback, so nothing ever looked broken —
and every reader downstream compared a display name against a config key and matched nothing.

On the install this was found on, that was 15,279 indexed events belonging to channels the
owner had configured, sitting unreadable.

`canonicalChannelKey` (v0.29.0) fixes this at the write boundary, but only for newly polled
events. Rows already in the index stay unreadable until they are moved. That is what this
script does.

**You do not need this script on a fresh install.** It repairs history written by a build
older than v0.29.0.

## Preconditions

### The daemon must be stopped

This is the one that matters. The running daemon's poller upserts `channel` from the
connector on every re-fetch of an existing `source_id` — and 42% of Slack rows have been
re-upserted at least once. A repair applied under a live daemon is undone one row at a time,
silently, with no error.

```bash
mama stop
# launchd-managed installs respawn on a plain kill; unload the job instead:
launchctl bootout gui/$(id -u)/com.mama.server
```

The script refuses to `--apply` while it can see a live pid in `~/.mama/mama.pid`. Treat that
refusal as correct and stop the daemon properly rather than working around it.

> The refusal is only as good as the check. Until v0.29.0 it read the pid file as a bare
> integer while the daemon wrote JSON, so it evaluated to `NaN` and the guard never fired
> once. If you are on an older build, stop the daemon yourself and do not rely on the rail.

### Take your own backup

The script writes one with `VACUUM INTO` before it changes anything. Take your own as well;
a repair over a database you cannot restore is a one-way door.

## Running it

**Dry run is the default.** It prints the plan and changes nothing:

```bash
cd packages/standalone
pnpm exec tsx scripts/backfill-channel-keys.ts
```

Read the plan. Each entry is `connector: from -> to (N events)`. A channel it cannot resolve
to a configured key is reported and **skipped** — the script never guesses a key and never
invents one.

To apply:

```bash
pnpm exec tsx scripts/backfill-channel-keys.ts --apply
```

`MAMA_DB_PATH` overrides the database location; it defaults to `~/.mama/mama-memory.db`.

## What moves together

The channel value is a join key in more than one place, and the one that matters is not a
table:

- `connector_event_index.channel` — the rows themselves, renumbered within the merged
  partition so the unique sequence index does not collide.
- `memory_scope_id` — on channel-scoped rows this equals `channel`. Moving one without the
  other leaves a row holding two names for its own channel, which the pre-grant readers still
  consult.
- **The delta cursors** in `~/.mama/operator/trigger-loop-cursors.json`. `ConnectorDeltaRepo`
  keys its partitions `connector\0channel`, and `drainNew` starts from 0 when a key is
  absent. Every re-keyed partition has a live cursor there. Re-keying the rows without
  carrying the cursors would redeliver months-old events as news and compose owner reports
  out of them.

The cursor file is backed up alongside as `trigger-loop-cursors.json.before-channel-rekey`.

## After applying

1. Restart the daemon.
2. Confirm the poller is not re-eroding the repair — re-run the dry run and check that the
   plan is now empty.
3. Confirm the reader can see the rows: a `context_compile` over the affected connector
   should return raw candidates where it previously returned none.

## Known limits

- The cursor carry happens **after** the database transaction commits. A crash between the
  two leaves the index re-keyed with stale cursors. If that happens, restore
  `trigger-loop-cursors.json.before-channel-rekey` is NOT the fix — the cursors must be
  carried forward, so re-run the script, which is idempotent for rows already moved.
- The daemon check is taken once, before the work starts. On a launchd-managed install,
  `mama stop` can be followed by an immediate respawn; use `launchctl bootout` and verify
  with `launchctl list | grep com.mama.server` before applying.
