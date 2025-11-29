# MAMA Mobile Access Guide

Complete guide for accessing MAMA's Graph Viewer and Mobile Chat from any device.

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

# Then start the server
node start-http-server.js
```

**Without this token, anyone with your tunnel URL can access your computer.**

📖 **See [Security Guide](./security.md) for detailed security information.**

---

## Overview

MAMA Mobile provides a web-based interface for:

- **Graph Viewer:** Visualize your decision graph and explore relationships
- **Mobile Chat:** Real-time chat with Claude Code via WebSocket

Access both features at `http://localhost:3847/viewer`

---

## Starting the HTTP Server

### Option 1: Standalone Server (Recommended)

```bash
cd packages/mcp-server
node start-http-server.js
```

The server will start on port 3847 by default:

- Graph Viewer: `http://localhost:3847/viewer`
- WebSocket endpoint: `ws://localhost:3847/ws`

### Option 2: Custom Port

```bash
MAMA_HTTP_PORT=8080 node start-http-server.js
```

### Verify Server is Running

```bash
# Check if server is listening
curl http://localhost:3847/viewer

# Check WebSocket endpoint
curl http://localhost:3847/graph
```

---

## Local Access

### Desktop Browser

1. Start the HTTP server
2. Open `http://localhost:3847/viewer`
3. Navigate between tabs:
   - **Memory:** Browse decision graph
   - **Chat:** Real-time chat with Claude

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

⚠️ **SECURITY CRITICAL:** For access from outside your local network, use a tunnel service.

**⚠️ BEFORE YOU START:**

1. **MUST set `MAMA_AUTH_TOKEN`** (see Security Warning above)
2. Read the [Security Guide](./security.md) thoroughly
3. Understand the risks (file access, command execution)
4. Never share tunnel URLs publicly

### Option 1: Cloudflare Tunnel (Recommended)

#### Quick Tunnel (Testing)

Fast setup for testing, but tunnels expire without warning:

```bash
# ⚠️ STEP 1: Set authentication token FIRST!
export MAMA_AUTH_TOKEN="$(openssl rand -base64 32)"
echo "Save this token: $MAMA_AUTH_TOKEN"

# STEP 2: Install cloudflared
# Download from: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/

# STEP 3: Start tunnel
cloudflared tunnel --url http://localhost:3847 --no-autoupdate

# Output will show your public URL:
# https://random-subdomain.trycloudflare.com
```

Access your mobile chat at:

```
https://random-subdomain.trycloudflare.com/viewer
```

**Limitations:**

- No uptime guarantee
- URL changes on restart
- May expire anytime

#### Named Tunnel (Production)

For reliable long-term access:

1. **Create Cloudflare account** (free)

2. **Create named tunnel:**

   ```bash
   cloudflared tunnel login
   cloudflared tunnel create mama-mobile
   ```

3. **Create config file** (`~/.cloudflared/config.yml`):

   ```yaml
   tunnel: mama-mobile
   credentials-file: /path/to/credentials.json

   ingress:
     - hostname: mama.yourdomain.com
       service: http://localhost:3847
     - service: http_status:404
   ```

4. **Run tunnel:**

   ```bash
   cloudflared tunnel run mama-mobile
   ```

5. **Set up DNS:** Point `mama.yourdomain.com` to your tunnel (via Cloudflare dashboard)

**Benefits:**

- Permanent URL
- Survives restarts
- Better performance
- Access control options

### Option 2: ngrok

```bash
# Install ngrok from https://ngrok.com/download

# Start tunnel
ngrok http 3847

# Use the displayed HTTPS URL
```

---

## Security Considerations

### Authentication (Coming Soon)

Currently, MAMA Mobile has no built-in authentication. When exposing to the internet:

1. **Use MAMA_AUTH_TOKEN** (future feature):

   ```bash
   export MAMA_AUTH_TOKEN="your-secure-random-token"
   node start-http-server.js
   ```

2. **Restrict tunnel access** using Cloudflare Access or ngrok auth

3. **Monitor access logs** regularly

### Best Practices

- ✅ Use Named Tunnels for production
- ✅ Set strong authentication tokens
- ✅ Limit access to specific IP ranges if possible
- ✅ Monitor server logs for suspicious activity
- ❌ Don't share Quick Tunnel URLs publicly
- ❌ Don't use Quick Tunnels for sensitive data

---

## Features

### Graph Viewer

- **Interactive graph:** Pan, zoom, click nodes for details
- **Search:** Find decisions by topic or content
- **Filters:** View by topic, confidence, outcome
- **Node details:** Click any node to see full decision data

### Mobile Chat

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

# Or use different port
MAMA_HTTP_PORT=8080 node start-http-server.js
```

### WebSocket connection fails

**Symptoms:** Chat shows "Not connected" or "Disconnected"

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
   # Linux: Allow port 3847
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
# Change HTTP port (default: 3847)
export MAMA_HTTP_PORT=8080

# Change database path (default: ~/.claude/mama-memory.db)
export MAMA_DB_PATH=/custom/path/mama.db

# Set authentication token (future feature)
export MAMA_AUTH_TOKEN="your-secret-token"
```

### Running as Background Service

**Using systemd (Linux):**

1. Create service file (`/etc/systemd/system/mama-http.service`):

   ```ini
   [Unit]
   Description=MAMA HTTP Server
   After=network.target

   [Service]
   Type=simple
   User=your-username
   WorkingDirectory=/path/to/MAMA/packages/mcp-server
   ExecStart=/usr/bin/node start-http-server.js
   Restart=always
   Environment="MAMA_HTTP_PORT=3847"

   [Install]
   WantedBy=multi-user.target
   ```

2. Enable and start:

   ```bash
   sudo systemctl daemon-reload
   sudo systemctl enable mama-http
   sudo systemctl start mama-http

   # Check status
   sudo systemctl status mama-http
   ```

**Using PM2 (Cross-platform):**

```bash
# Install PM2
npm install -g pm2

# Start server
cd packages/mcp-server
pm2 start start-http-server.js --name mama-http

# Auto-start on boot
pm2 startup
pm2 save

# View logs
pm2 logs mama-http
```

---

## Next Steps

- **For developers:** See [Development Guide](../development/developer-playbook.md)
- **For troubleshooting:** See [Troubleshooting Guide](troubleshooting.md)
- **For MCP tools:** See [MCP Tool Reference](../reference/api.md)
