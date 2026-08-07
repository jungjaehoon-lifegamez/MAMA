# MAMA Mobile Access Guide

Complete guide for accessing the MAMA Viewer from any device.

---

## ⚠️ Requirements

| Feature                           | Claude Code Plugin | Claude Desktop (MCP) |
| --------------------------------- | ------------------ | -------------------- |
| MCP Tools (/mama-save, etc.)      | ✅                 | ✅                   |
| Viewer (Knowledge > Memory/Wiki)  | ✅                 | ✅                   |
| **Operator board and agent runs** | ✅                 | ❌                   |

**The Operator group requires the MAMA OS daemon and a backend CLI:**

- The daemon runs `claude` (or `codex`/`cline`) as a subprocess to produce the report slots,
  task board and triggers
- **Not available under Claude Desktop alone** (MCP servers only, no daemon)
- Knowledge (Memory, Wiki) and System work in both: they read what is already stored

---

## ⚠️ Security Warning

**IMPORTANT: Read before exposing MAMA to the internet!**

MAMA is designed for **localhost use only** by default. External access via tunnels (ngrok, Cloudflare) **exposes your local machine** to the internet.

### What Can Be Accessed

When you expose MAMA externally, attackers can access:

- 🔓 The agent-driving HTTP and WebSocket APIs (the browser chat UI is gone; the endpoints are not)
- 🔓 Decision database (`~/.claude/mama-memory.db`)
- 🔓 **Your local file system** (via Claude Code Read/Write tools)
- 🔓 **Command execution** (via Claude Code Bash tool)

### Required: Set Authentication Token

**Before using external tunnels, ALWAYS set `MAMA_AUTH_TOKEN`:**

```bash
# Generate a strong random token
export MAMA_AUTH_TOKEN="$(openssl rand -base64 32)"

# Then start MAMA OS
mama start
```

**Without this token, anyone with your tunnel URL can access your computer.**

📖 **See [Security Guide](./security.md) for detailed security information.**

---

## Overview

MAMA Mobile provides a web-based interface for:

- **Operator:** Board (four live report slots: briefing, action required, decisions, pipeline), Tasks, Triggers
- **Knowledge:** Memory, Wiki
- **System:** Runtime, Connectors, Logs

Access all of it at `http://localhost:3847/viewer`, which opens on the operator board.

---

## Starting the HTTP Server

### Option 1: MAMA OS (Recommended)

```bash
mama start
```

MAMA OS starts with:

- API/UI: `http://localhost:3847/viewer`
- WebSocket: `ws://localhost:3847/ws`
- Embedding server: `http://127.0.0.1:3849`

### Option 2: Legacy MCP HTTP Mode (Not Recommended)

```bash
MAMA_MCP_START_HTTP_EMBEDDING=true npx @jungjaehoon/mama-server
```

This mode is for compatibility only. Use MAMA OS for the full Viewer, including the Operator group.

### Verify Server is Running

```bash
# Check if server is listening
curl http://localhost:3847/viewer

# Check API health
curl http://localhost:3847/health
```

---

## Local Access

### Desktop Browser

1. Start the HTTP server
2. Open `http://localhost:3847/viewer` - it opens on the operator board
3. Move between groups in the rail: **Operator** (Board, Tasks, Triggers), **Knowledge**
   (Memory, Wiki), **System** (Runtime, Connectors, Logs)
4. Each view has its own hash route, so you can bookmark or share one directly, e.g.
   `http://localhost:3847/viewer#knowledge/memory`

To talk to MAMA, use a chat gateway (Discord, Slack, Telegram, or Chatwork). The Viewer has no
chat surface: it shows what the agent has published and what the system holds.

### Mobile Device (Same Network)

1. Find your computer's IP address:

   ```bash
   # Linux/Mac
   hostname -I | awk '{print $1}'

   # Or check network settings
   ```

2. On your mobile device, open:

   ```
   http://YOUR_IP_ADDRESS:3847/viewer
   ```

3. Install as PWA (optional):
   - Chrome: Menu → "Install app" or "Add to Home Screen"
   - Safari: Share → "Add to Home Screen"

---

## External Access

⚠️ **CRITICAL:** When exposing MAMA externally, attackers can take **complete control** of your computer.

**Choose your access method based on use case:**

### 🌟 Option 1: Cloudflare Zero Trust (Production - RECOMMENDED)

**Use this for:**

- ✅ Real deployment (long-term use)
- ✅ Accessing from untrusted networks (public WiFi, cafes)
- ✅ Maximum security

**What you get:**

- ✅ Google/GitHub account authentication
- ✅ 2FA automatically enforced
- ✅ Only YOUR email can access
- ✅ No token management needed
- ✅ Enterprise-grade security (FREE!)
- ✅ Protected `/api/*` routes work without a second Bearer token when MAMA trusts Cloudflare Access

#### Quick Setup (15 minutes)

**Step 1: Install cloudflared**

```bash
# Download from: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/

# Verify
cloudflared --version
```

**Step 2: Create Named Tunnel**

```bash
# Login to Cloudflare
cloudflared tunnel login

# Create tunnel
cloudflared tunnel create mama-mobile

# Note the tunnel ID shown in output
```

**Step 3: Configure Tunnel**

Create `~/.cloudflared/config.yml`:

```yaml
tunnel: YOUR_TUNNEL_ID # From Step 2
credentials-file: ~/.cloudflared/YOUR_TUNNEL_ID.json

ingress:
  - hostname: mama.yourdomain.com # Your subdomain
    service: http://localhost:3847
  - service: http_status:404
```

**Step 4: Set up DNS**

```bash
cloudflared tunnel route dns mama-mobile mama.yourdomain.com
```

**Step 5: Configure Zero Trust Access**

Go to **Cloudflare Dashboard** → **Zero Trust** → **Access** → **Applications**

1. Click "Add an application" → "Self-hosted"
2. Application Configuration:
   - Name: `MAMA Mobile`
   - Domain: `mama.yourdomain.com`
3. Identity Provider: Choose **Google** (or GitHub)
4. Access Policy:
   - Name: `Allow My Email Only`
   - Include: `Emails` → `your-email@gmail.com`

**Step 6: Start Everything**

```bash
# Trust Cloudflare Access identity headers from the local tunnel process
export MAMA_TRUST_CLOUDFLARE_ACCESS=true

# Start MAMA OS
mama start &

# Start tunnel
cloudflared tunnel run mama-mobile
```

**Step 7: Access**

```
https://mama.yourdomain.com/viewer

→ Cloudflare login screen appears
→ Login with your Google account
→ If your email is allowed → Access granted ✅
→ If not → Access denied ❌
```

**Free Tier:** Up to 50 users, unlimited bandwidth, all features!

📖 **Full Guide:** See [Security Guide - Cloudflare Zero Trust](./security.md#cloudflare-zero-trust-recommended-for-production)

**Important:** Cloudflare Access login by itself is not enough for protected MAMA API routes. Start MAMA with `MAMA_TRUST_CLOUDFLARE_ACCESS=true` so Access-authenticated requests are accepted without a second Bearer token.

---

### ⚠️ Option 2: Quick Tunnel + Token (TESTING ONLY)

**Use this ONLY for:**

- ✅ Quick testing (few minutes)
- ✅ Temporary debugging
- ✅ Same-day use

**DO NOT use for:**

- ❌ Long-term deployment
- ❌ Public networks
- ❌ Important work

```bash
# STEP 1: Set token
export MAMA_AUTH_TOKEN="$(openssl rand -base64 32)"
echo "Token: $MAMA_AUTH_TOKEN"  # Save this!

# STEP 2: Start MAMA OS
mama start &

# STEP 3: Start Quick Tunnel
cloudflared tunnel --url http://localhost:3847 --no-autoupdate

# STEP 4: Access with token
# https://xxx.trycloudflare.com/viewer?token=YOUR_TOKEN
```

**Limitations:**

- ⚠️ Token alone = weak security
- ⚠️ Tunnel expires randomly
- ⚠️ URL changes on restart
- ⚠️ Anyone with token + URL = full access
- ⚠️ Use token mode here because quick tunnels do not provide Cloudflare Access identity headers

---

### Option 3: ngrok

```bash
# Install from https://ngrok.com/download

# Set token first!
export MAMA_AUTH_TOKEN="$(openssl rand -base64 32)"

# Start tunnel
ngrok http 3847

# Access: https://xxx.ngrok.io/viewer?token=YOUR_TOKEN
```

**Note:** ngrok also offers Zero Trust authentication (ngrok Teams plan)

---

## Configuration

### Disabling Features

You can disable HTTP server or WebSocket via configuration.

**Easy Way: Use `/mama-configure` command (Claude Code only)**

```bash
# View current settings
/mama-configure

# Disable features
/mama-configure --disable-http              # Disable the Viewer and the HTTP API
/mama-configure --disable-websocket         # Disable the WebSocket API only
/mama-configure --enable-all                # Enable everything

# Set authentication token
/mama-configure --generate-token            # Generate random token
/mama-configure --set-auth-token=abc123     # Set specific token
```

**After configuration changes, restart Claude Code for changes to take effect.**

**Manual Way: Edit plugin configuration**

For Claude Code, edit `~/.claude/plugins/repos/mama/.claude-plugin/plugin.json`:

```json
{
  "mcpServers": {
    "mama": {
      "env": {
        "MAMA_DISABLE_HTTP_SERVER": "true",
        "MAMA_DISABLE_WEBSOCKET": "true",
        "MAMA_AUTH_TOKEN": "your-token-here"
      }
    }
  }
}
```

For Claude Desktop, edit `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "mama": {
      "command": "npx",
      "args": ["-y", "@jungjaehoon/mama-server"],
      "env": {
        "MAMA_DISABLE_HTTP_SERVER": "true"
      }
    }
  }
}
```

---

## Security Considerations

### Authentication

MAMA supports token-based authentication for external access:

1. **Generate strong token:**

   ```bash
   /mama-configure --generate-token
   # Or manually: openssl rand -base64 32
   ```

2. **Set token in configuration:**

   ```bash
   /mama-configure --set-auth-token=YOUR_TOKEN
   ```

3. **Restart Claude Code** for changes to take effect

4. **Access with token:**
   ```
   https://tunnel-url/viewer?token=YOUR_TOKEN
   ```

### Best Practices

- ✅ **Use Cloudflare Zero Trust** for production (Google account + 2FA)
- ✅ Use Named Tunnels for long-term deployment
- ✅ Set strong authentication tokens (32+ characters)
- ✅ Monitor server logs for suspicious activity
- ✅ Disable features you don't use (`/mama-configure --disable-websocket`)
- ❌ Don't share Quick Tunnel URLs publicly
- ❌ Don't use Quick Tunnels for sensitive data
- ❌ Don't use weak tokens ("password123", "mama", etc.)

---

## Features

### Operator

- **Board:** four agent-published report slots (briefing, action required, decisions,
  pipeline), updating live over SSE
- **Tasks:** the task board fed from your connected channels
- **Triggers:** the trigger loop's library, with an owner veto tray

### Knowledge > Memory

- **Interactive graph:** Pan, zoom, click nodes for details
- **Search:** Find decisions by topic or content
- **Filters:** View by topic, confidence, outcome
- **Node details:** Click any node to see full decision data
- **Export:** JSON, Markdown, or CSV

### Knowledge > Wiki

- **Obsidian-backed browsing:** navigate the vault the agent writes to

### System

- **Runtime:** the authoritative runtime snapshot - backend, model, gateways, health
- **Connectors:** connector status and last poll time
- **Logs:** daemon logs with filtering, pinning and stats

---

## Troubleshooting

### Server won't start

**Error:** `EADDRINUSE: address already in use`

**Solution:**

```bash
# Find process using port 3847
lsof -i :3847

# Kill the process
kill -9 <PID>

# Or stop existing MAMA process first
mama stop
mama start
```

### Operator board stays empty or stops updating

**Symptoms:** The board shows no slots, or slot content stops changing.

The board is fed by the report SSE stream (`/api/report/events`), not by WebSocket.

**Solutions:**

1. **Check server logs:**

   ```bash
   tail -f /tmp/mama-server.log
   ```

2. **Verify the stream and the API:**

   ```bash
   curl http://localhost:3847/health
   curl -N http://localhost:3847/api/report/events
   ```

3. **Clear browser cache:**
   - Chrome: Ctrl+Shift+R (Windows) / Cmd+Shift+R (Mac)
   - Clear localStorage: DevTools → Application → Local Storage → Clear

4. **Check firewall:**
   ```bash
   # Linux: Allow API/UI port 3847
   sudo ufw allow 3847/tcp
   ```

An empty board can also simply mean the agent has not published yet - the slots show what was
written, and never invent content.

### Service Worker errors

**Error:** `Failed to register ServiceWorker: 404`

**Solution:**

- Hard refresh browser (Ctrl+Shift+R / Cmd+Shift+R)
- Restart HTTP server
- Check server logs for `/viewer/sw.js` requests

### Cloudflare Tunnel disconnects

**Error 1033:** Tunnel expired

**Solution:**

```bash
# Kill old tunnel
pkill cloudflared

# Start new tunnel
cloudflared tunnel --url http://localhost:3847 --no-autoupdate
```

For reliable access, use Named Tunnels instead of Quick Tunnels.

---

## Advanced Configuration

### Environment Variables

```bash
# Change database path (default: ~/.claude/mama-memory.db)
export MAMA_DB_PATH=/custom/path/mama.db

# Set authentication token (required before any external tunnel)
export MAMA_AUTH_TOKEN="your-secret-token"
```

### Running as Background Service

**Using systemd (Linux):**

1. Create service file (`/etc/systemd/system/mama-os.service`):

   ```ini
   [Unit]
   Description=MAMA OS
   After=network.target

   [Service]
   Type=simple
   User=your-username
   ExecStart=/usr/bin/env mama start --foreground
   Restart=always

   [Install]
   WantedBy=multi-user.target
   ```

2. Enable and start:

   ```bash
   sudo systemctl daemon-reload
   sudo systemctl enable mama-os
   sudo systemctl start mama-os
   sudo systemctl status mama-os
   ```

**Using PM2 (Cross-platform):**

```bash
# Install PM2
npm install -g pm2

# Start server
pm2 start "mama start --foreground" --name mama-os

# Auto-start on boot
pm2 startup
pm2 save

# View logs
pm2 logs mama-os
```

---

## Next Steps

- **For developers:** See [Development Guide](../development/developer-playbook.md)
- **For troubleshooting:** See [Troubleshooting Guide](troubleshooting.md)
- **For MCP tools:** See [MCP Tool Reference](../reference/api.md)
