---
title: Viewer API
parent: Reference
nav_order: 7
---

# Viewer API

Read the daemon's current board, work, evidence and logs at `http://127.0.0.1:3847`.
`MAMA_API_HOST` and `MAMA_API_PORT` change the listener. The viewer data API accepts GET only;
mutation requests return `405`. It is separate from the [public MCP server](mcp-tools.md).

## Access

Every request must use an allowed Host: `localhost`, `127.0.0.1`, `[::1]`, or an entry in
`MAMA_VIEWER_HOSTNAMES`. A rejected Host returns `421`.

Data routes require authentication. A direct loopback connection without Cloudflare tunnel headers
is accepted locally. Remote or tunneled data requests need `Authorization: Bearer <token>` matching
`MAMA_AUTH_TOKEN`, or a verified Cloudflare Access JWT with the configured issuer and audience.
Header presence alone does not authenticate. Missing credentials return `401`.
`MAMA_VIEWER_OWNER_EMAILS` affects monitoring only.

`GET /health` returns `{"status":"ok"}` without data-route authentication. `/` redirects to
`/viewer`; the static viewer and its assets also sit outside data-route authentication. Static files
support GET and HEAD; OPTIONS returns `204`. Loading the page alone does not establish access to its
data. See [viewer access setup](../guides/viewer.md).

## Current data routes

All paths in this table use GET. Limits outside a route's accepted range return `400`.

| Route                                           | Inputs and result                                                                                                                                                                  |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/graph`, `/api/graph`                          | Graph nodes and edges. `limit` defaults to 300, maximum 2000; `cursor`, `history=current` (otherwise all), and comma-separated `kind` filters. Follow `nextCursor`.                |
| `/graph/detail`, `/api/graph/detail`            | Required `id` as `kind:id`; returns a node with source content or memory provenance where applicable.                                                                              |
| `/graph/similar`, `/api/graph/similar`          | Required `id` as `kind:id`; searches for up to five similar memories. Non-memory references return an unavailable result.                                                          |
| `/checkpoints`, `/api/checkpoints`              | Up to 50 recent checkpoints in the daemon database.                                                                                                                                |
| `/api/mama/search`, `/api/viewer/memory/search` | Optional `q`; `limit` defaults to 20, maximum 200. Omitting `q` lists memory.                                                                                                      |
| `/api/viewer/tasks`                             | Current work items; `limit` defaults to 50, maximum 50.                                                                                                                            |
| `/api/viewer/tasks/<commitmentId>`              | One task with revision history and bounded source evidence for its revisions.                                                                                                      |
| `/api/operator/tasks`                           | Work projected as operator tasks. `limit` defaults to 50, maximum 50; optional `status` and `source_channel`. Source-channel filtering occurs after reading the bounded work page. |
| `/api/viewer/graph`                             | Graph wrapper with a `missing` notice for revision-chain edges. `limit` defaults to 300, maximum 2000; `cursor`, `kind`.                                                           |
| `/api/report`                                   | Current report slots from the report store.                                                                                                                                        |
| `/api/report/events`                            | Server-sent `report-update` events; starts with the current slots and sends keep-alives every 15 seconds.                                                                          |
| `/api/wiki/tree`                                | Wiki paths as a directory tree.                                                                                                                                                    |
| `/api/wiki/page`                                | Required `path`; returns Markdown content, raw page and parsed frontmatter. Reads up to 20,000 characters.                                                                         |
| `/api/runtime/status`                           | Runtime and connector state provided by the daemon.                                                                                                                                |
| `/api/connectors/status`                        | Configured connector status; unavailable result if no provider is wired.                                                                                                           |
| `/api/dashboard/status`                         | Memory statistics from the daemon database.                                                                                                                                        |
| `/api/logs/daemon`                              | Log tail: `tail` (or `limit`) defaults to 500, maximum 2000; `since` is a file modification timestamp in milliseconds.                                                             |
| `/api/security/events`                          | Recent structured security events; `limit` defaults to 50, maximum 2000. A member's refused connection holds only `principalId`, `host` and `time`.                                |

Graph `kind` filters accept `memory`, `case`, `report`, `edge`, `raw`, `registry`, `observation`,
and `entity`. These are graph projection names; task history is stored on work revisions.

Log reads are bounded to 256 KiB. They return `truncated` and may return `total: null` when the full
file was not read. An unchanged `since` request returns JSON with empty `lines`, not HTTP `304`.
A missing log yields an empty unavailable result. Report, wiki, runtime and memory-stat routes
return `503` when their required store or provider is absent. A missing wiki page returns `404`.

## Compatibility stubs

These GET paths remain for the viewer but return empty or null data with an unavailable reason.
They do not prove that the named feature is running.

| Routes                                                             | Response shape                                                  |
| ------------------------------------------------------------------ | --------------------------------------------------------------- |
| `/api/connectors/activity`, `/api/connectors/<name>/feed`          | Empty connector activity or feed.                               |
| `/api/metrics/health`                                              | Null score and empty components/checks.                         |
| `/api/cron`, `/api/cron/<path>`                                    | Empty jobs or logs.                                             |
| `/api/tokens/summary`, `/api/tokens/by-agent`, `/api/tokens/daily` | Empty usage objects or arrays.                                  |
| `/api/skills`, `/api/skills/catalog`, `/api/skills/search`         | Empty skills.                                                   |
| `/api/intelligence/<path>`                                         | Empty activity, summary, projects, pipeline, notices or alerts. |

`/api/operator/summary` is partial: it derives an unconfirmed-task count from at most 50 work items,
but returns null report and trigger fields. Read `/api/report` for real board slots.
Unknown data routes return `404`; there is no generic HTTP action dispatch or configuration writer.

Sources: [route implementation](../../packages/standalone/src/api/viewer-server.ts),
[authentication](../../packages/standalone/src/api/auth-middleware.ts),
[JWT verification](../../packages/standalone/src/api/cf-access.ts),
[Host validation and auditing](../../packages/standalone/src/api/viewer-request-security.ts).
