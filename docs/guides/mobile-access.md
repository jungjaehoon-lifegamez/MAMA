# MAMA Remote and Mobile Access

MAMA no longer ships a browser Viewer. Use an authenticated messenger gateway for conversations,
files, reports, and follow-up work from a phone or another computer.

## Recommended access

Configure a gateway on the host running MAMA:

```bash
mama gateway telegram --token-stdin
mama gateway telegram detect-owner
mama status
```

Slack, Discord, and Chatwork are also supported. Keep each gateway's allowlist and owner identity
configured. Connector sources are managed separately with `mama connector add <name>` and checked
with `mama connector status`.

## Local operational API

The standalone daemon retains its operational API on port 3847. It includes health, runtime
status, reports, tasks, source evidence, graph data, uploads, and native runtime routes. It does
not serve HTML, JavaScript, CSS, a PWA, or UI command routes.

Check the local listener with:

```bash
curl -fsS http://127.0.0.1:3847/health
mama status
```

Authenticated API requests use `MAMA_AUTH_TOKEN` when configured. Keep the default
`127.0.0.1` binding unless a specific operational client needs remote access.

## Remote API safety

The API can reach data and actions owned by the local MAMA runtime. If remote API access is
required:

1. Set `MAMA_AUTH_TOKEN` before starting MAMA.
2. Put the listener behind mTLS, an IP allowlist, or an authenticated access proxy.
3. Keep tunnel URLs and tokens private.
4. Verify `/health` and the exact authenticated route the client needs.
5. Close the tunnel when the temporary access window ends.

Messenger access is the normal mobile workflow. Remote exposure of the operational API is an
administrative integration choice, not a replacement web application.
