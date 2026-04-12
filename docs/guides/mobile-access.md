# MAMA Mobile Access Guide

Complete guide for accessing MAMA's Viewer and floating chat shell from any device.

---

## ⚠️ Requirements

| Feature                      | Claude Code Plugin | Claude Desktop (MCP) |
| ---------------------------- | ------------------ | -------------------- |
| MCP Tools (/mama-save, etc.) | ✅                 | ✅                   |
| Graph Viewer                 | ✅                 | ✅                   |
| **Mobile Chat**              | ✅                 | ❌                   |

**Mobile Chat requires Claude Code CLI:**

- Uses `claude` command as subprocess for real-time communication
- **Not available in Claude Desktop** (MCP servers only, no CLI)
- Graph Viewer works in both (read-only decision visualization)

---

## ⚠️ Security Warning

**IMPORTANT: Read before exposing MAMA to the internet!**

MAMA is designed for **localhost use only** by default. External access via tunnels (ngrok, Cloudflare) **exposes your local machine** to the internet.

### What Can Be Accessed

When you expose MAMA externally, attackers can access:

- 🔓 Chat sessions with Claude Code
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

- **Viewer tabs:** Dashboard, Memory, Feed, Wiki, Agents, Logs, Settings
- **Floating Chat:** Real-time chat with Claude Code via WebSocket

Access both features at `http://localhost:3847/viewer`

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

This mode is for compatibility only. Use MAMA OS for the full Viewer plus floating chat shell.

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
2. Open `http://localhost:3847/viewer`
3. Navigate between tabs such as **Memory**, **Feed**, **Wiki**, or **Agents**
4. Open the floating chat button when you want real-time chat with Claude

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
/mama-configure --disable-http              # Disable Graph Viewer + Mobile Chat
/mama-configure --disable-websocket         # Disable Mobile Chat only
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

### Graph Viewer

- **Interactive graph:** Pan, zoom, click nodes for details
- **Search:** Find decisions by topic or content
- **Filters:** View by topic, confidence, outcome
- **Node details:** Click any node to see full decision data

### Floating Chat

- **Real-time messaging:** WebSocket-based chat with Claude Code
- **Voice input:** Press microphone button to speak (Korean optimized)
- **Text-to-Speech:** Hear Claude's responses with adjustable speed (1.8x default)
- **Hands-free mode:** Auto-listen after TTS completes
- **Slash commands:** `/save`, `/search`, `/checkpoint`, `/resume`, `/help`
- **Auto-checkpoint:** Saves session state after 5 minutes idle
- **Session resume:** Automatically detect and resume previous sessions
- **MCP tool display:** See real-time tool execution (Read, Write, Bash, etc.)
- **Long press to copy:** Hold message for 750ms to copy

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

### WebSocket connection fails

**Symptoms:** The floating chat shell shows "Not connected" or "Disconnected"

**Solutions:**

1. **Check server logs:**

   ```bash
   tail -f /tmp/mama-server.log
   ```

2. **Verify WebSocket endpoint:**

   ```bash
   curl http://localhost:3847/ws
   ```

3. **Clear browser cache:**
   - Chrome: Ctrl+Shift+R (Windows) / Cmd+Shift+R (Mac)
   - Clear localStorage: DevTools → Application → Local Storage → Clear

4. **Check firewall:**
   ```bash
   # Linux: Allow API/UI port 3847
   sudo ufw allow 3847/tcp
   ```

### Service Worker errors

**Error:** `Failed to register ServiceWorker: 404`

**Solution:**

- Hard refresh browser (Ctrl+Shift+R / Cmd+Shift+R)
- Restart HTTP server
- Check server logs for `/viewer/sw.js` requests

### Voice recognition not working

**Requirements:**

- HTTPS connection (or localhost)
- Microphone permission granted
- Supported browser (Chrome, Edge, Safari)

**Check:**

```javascript
// In browser console
console.log(
  'Speech Recognition:',
  'webkitSpeechRecognition' in window || 'SpeechRecognition' in window
);
```

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

## Recent Bug Fixes (v1.5.1)

The following critical bugs were fixed:

### WebSocket Session Management

**Fixed:** Session ID parameter mismatch

- **Issue:** Server looked for `?session=xxx` but client sent `?sessionId=xxx`
- **Fix:** Updated `websocket-handler.js:45` to use correct parameter name
- **Impact:** WebSocket connections now properly attach to sessions

### Service Worker 404 Errors

**Fixed:** Missing PWA asset routes

- **Issue:** `/viewer/sw.js` and `/viewer/manifest.json` returned 404
- **Fix:** Added routes in `graph-api.js:822-846`
- **Impact:** PWA installation now works correctly

### Unknown Message Type Error

**Fixed:** Missing WebSocket message handler

- **Issue:** `'connected'` message type not recognized by client
- **Fix:** Added handler in `chat.js:239-241`
- **Impact:** Eliminates console errors on connection

### Status Display Bug

**Fixed:** Null reference error in status indicator

- **Issue:** `querySelector('span:last-child')` failed due to HTML structure
- **Fix:** Changed to `querySelector('span:not(.status-indicator)')` in `chat.js:688`
- **Impact:** Connection status now displays correctly

### Session Error Handling

**Fixed:** Missing error response for expired sessions

- **Issue:** Server didn't notify client when session not found
- **Fix:** Added error message in `websocket-handler.js:115-127`
- **Impact:** Client now auto-creates new session when old one expires

---

## Advanced Configuration

### Environment Variables

```bash
# Change database path (default: ~/.claude/mama-memory.db)
export MAMA_DB_PATH=/custom/path/mama.db

# Set authentication token (future feature)
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
