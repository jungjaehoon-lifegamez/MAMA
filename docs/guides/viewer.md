---
title: Inspect work in the viewer
parent: Guides
nav_order: 11
---

# Inspect work in the viewer

With the daemon running, open `http://127.0.0.1:3847/viewer` on the same machine.
The viewer is read-only: use Telegram to ask MAMA to correct work or publish a new
report.

Browse Board, Tasks, Memory, Wiki, Runtime, Connectors and Logs. The board shows
published report slots; tasks and memory expose stored work, revisions and linked
evidence. Wiki displays the configured Markdown vault. Runtime and Connectors
help distinguish a running process from collection health. Daemon logs and
`GET /api/security/events` support investigation.

`MAMA_API_HOST` and `MAMA_API_PORT` select the listener; defaults are `127.0.0.1`
and `3847`. Direct loopback requests without tunnel headers need no bearer token.
Treat processes that can reach that local listener as trusted.

## Enable remote access

Keep the origin on loopback and put a Cloudflare Tunnel and Access application in
front of it. Setup reads these non-secret settings from the environment and writes them into
`start.sh`:

- `MAMA_CF_ACCESS_ISSUER`: the Access application's HTTPS issuer origin.
- `MAMA_CF_ACCESS_AUD`: its audience value.
- `MAMA_VIEWER_HOSTNAMES`: allowed viewer hostnames, comma-separated without URLs (setup takes
  one).
- `MAMA_VIEWER_OWNER_EMAILS`: optional expected identities for monitoring.

Configure the tunnel and Access policy separately, then restart the daemon. The
origin verifies the Access JWT's signature, issuer, audience, time and email
claims. Missing verification configuration fails closed. A forwarded email or
Cloudflare header alone cannot authenticate a request.

The owner-email setting is observation only, not a second access allowlist.
Cloudflare Access policy controls who may enter. Every request must also pass the
Host allowlist; an unknown or malformed Host receives HTTP 421.

For API clients, a valid `MAMA_AUTH_TOKEN` is an alternative to Access. Set or
rotate it with `mama secret set MAMA_AUTH_TOKEN`, restart, and send it through the
Authorization bearer header. Keep it out of URLs, chat messages and saved records.
Onboarding generates an initial token in `auth.env`.

## Verify the protected data

After login, open the board and a known task; a successful `/health` response alone
is insufficient. Health, static assets and OPTIONS retain public route semantics
but still pass Host validation. Data routes require authentication for remote or
tunnel-shaped requests and allow GET only.

Tunnelled or refused requests create security events; suspicious event classes
can alert the owner on Telegram. The log tail is bounded to 256 KiB and 2,000
lines. Protect those logs as private data. Some compatibility routes, including
cron, token summaries and connector feeds, return explicit unavailable results;
they are not active product features. See the
[viewer API reference](../reference/viewer-api.md) and [Security](security.md).
