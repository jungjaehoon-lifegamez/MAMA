# Security Guide

**IMPORTANT:** MAMA is designed for local use on localhost (127.0.0.1). External access via tunnels (ngrok, Cloudflare, etc.) introduces security risks. Read this guide carefully before exposing MAMA to the internet.

---

## Table of Contents

- [Security Model](#security-model)
- [Localhost-Only Mode (Default)](#localhost-only-mode-default)
- [External Access via Tunnels](#external-access-via-tunnels)
- [Authentication](#authentication)
- [Disabling Features](#disabling-features)
- [Security Best Practices](#security-best-practices)
- [Threat Scenarios](#threat-scenarios)

---

## Security Model

### Design Principles

MAMA follows a **localhost-first security model**:

1. **Default: Localhost Only**
   - HTTP server binds to `127.0.0.1` only
   - No external network access without tunnels
   - No authentication required for local use

2. **Optional: External Access**
   - Requires manual tunnel setup (ngrok, Cloudflare, etc.)
   - **Requires `MAMA_AUTH_TOKEN` for security**
   - User must explicitly choose to expose MAMA

3. **Defense in Depth**
   - Token-based authentication for external requests
   - Rate limiting on failed auth attempts
   - Security warnings when external access detected

---

## Localhost-Only Mode (Default)

### What It Means

By default, MAMA server listens on `127.0.0.1:3847`:

```bash
[EmbeddingHTTP] Running at http://127.0.0.1:3847
```

**This means:**

- ✅ Only apps on your computer can connect
- ✅ No external access possible
- ✅ No authentication needed
- ✅ Safe for development and local use

### Accessing from Your Computer

```bash
# Graph Viewer
http://localhost:3847/viewer

# Mobile chat (same device only)
http://localhost:3847/viewer
```

---

## External Access via Tunnels

### ⚠️ Security Risks

When you use a tunnel (ngrok, Cloudflare, etc.), you expose MAMA to the internet:

**What can be accessed:**

- 🔓 Chat sessions with Claude Code
- 🔓 Decision database (`~/.claude/mama-memory.db`)
- 🔓 **Local file system** (via Claude Code Read/Write tools)
- 🔓 **Command execution** (via Claude Code Bash tool)

**Potential attacks:**

- Unauthorized access to your decisions
- Reading sensitive files from your computer
- Executing commands on your machine
- Data exfiltration via Claude Code

### ⚠️ Required: Set Authentication Token

**Before exposing MAMA externally, you MUST set `MAMA_AUTH_TOKEN`:**

```bash
# Generate a strong random token
export MAMA_AUTH_TOKEN="$(openssl rand -base64 32)"

# Or set a custom token
export MAMA_AUTH_TOKEN="your-very-secret-token-here"

# Restart MAMA server
npx @jungjaehoon/mama-server
```

### Example: Cloudflare Quick Tunnel

```bash
# 1. Set authentication token
export MAMA_AUTH_TOKEN="my-secret-token-123"

# 2. Start MAMA server
npx @jungjaehoon/mama-server &

# 3. Start tunnel
cloudflared tunnel --url http://localhost:3847

# 4. Access with authentication
# Browser: https://xxx.trycloudflare.com/viewer?token=my-secret-token-123
# Or use Authorization header:
curl -H "Authorization: Bearer my-secret-token-123" https://xxx.trycloudflare.com/viewer
```

### Security Warnings

When MAMA detects external access, it will show warnings:

```
⚠️  ========================================
⚠️  SECURITY WARNING: External access detected!
⚠️  ========================================
⚠️
⚠️  Your MAMA server is being accessed from outside localhost.
⚠️  This likely means you are using a tunnel (ngrok, Cloudflare, etc.)
⚠️
⚠️  ❌ CRITICAL: MAMA_AUTH_TOKEN is NOT set!
⚠️  Anyone with your tunnel URL can access your:
⚠️    - Chat sessions with Claude Code
⚠️    - Decision database (~/.claude/mama-memory.db)
⚠️    - Local file system (via Claude Code)
⚠️
⚠️  To secure your server, set MAMA_AUTH_TOKEN:
⚠️    export MAMA_AUTH_TOKEN="your-secret-token"
⚠️
⚠️  ========================================
```

---

## Authentication

### How It Works

MAMA uses simple token-based authentication:

```javascript
// Request from localhost -> Always allowed
if (req.remoteAddress === '127.0.0.1') {
  return true;
}

// External request -> Check MAMA_AUTH_TOKEN
if (!MAMA_AUTH_TOKEN) {
  return false; // Deny
}

// Verify token from header or query param
if (req.headers.authorization === `Bearer ${MAMA_AUTH_TOKEN}`) {
  return true; // Allow
}
```

### Providing the Token

**Method 1: Authorization Header (Recommended)**

```bash
curl -H "Authorization: Bearer YOUR_TOKEN" https://xxx.trycloudflare.com/viewer
```

**Method 2: Query Parameter**

```
https://xxx.trycloudflare.com/viewer?token=YOUR_TOKEN
```

⚠️ **Warning:** Query parameters are visible in browser history and server logs. Use Authorization header for sensitive operations.

### Token Requirements

- **Length:** Minimum 16 characters (32+ recommended)
- **Randomness:** Use cryptographically secure random generation
- **Storage:** Store in environment variable, NOT in code
- **Rotation:** Change token if compromised

**Good token:**

```bash
export MAMA_AUTH_TOKEN="$(openssl rand -base64 32)"
# Example: kX9mZ2pL5vQ3nR8sT1yU6wA7bC4dE0fF1gH2iJ3kK4lM5=
```

**Bad token:**

```bash
export MAMA_AUTH_TOKEN="password123"  # ❌ Too weak
export MAMA_AUTH_TOKEN="mama"         # ❌ Guessable
```

---

## Disabling Features

### Environment Variables

You can disable features for security or performance:

```bash
# Disable entire HTTP server (Graph Viewer + Mobile Chat)
export MAMA_DISABLE_HTTP_SERVER=true

# Disable only WebSocket/Mobile Chat (keep Graph Viewer)
export MAMA_DISABLE_WEBSOCKET=true

# Alternative: Disable Mobile Chat specifically
export MAMA_DISABLE_MOBILE_CHAT=true
```

### Use Cases

**1. Paranoid Security**

```bash
# MCP tools only, no HTTP server
export MAMA_DISABLE_HTTP_SERVER=true
npx @jungjaehoon/mama-server
```

**2. Graph Viewer Only**

```bash
# Graph Viewer works, Mobile Chat disabled
export MAMA_DISABLE_MOBILE_CHAT=true
npx @jungjaehoon/mama-server
```

**3. Full Features (Default)**

```bash
# No disable flags = all features enabled
npx @jungjaehoon/mama-server
```

---

## Security Best Practices

### ✅ DO

1. **Use localhost only** unless you absolutely need external access
2. **Set strong `MAMA_AUTH_TOKEN`** before using tunnels
3. **Use HTTPS tunnels** (ngrok, Cloudflare provide this automatically)
4. **Keep tunnel URLs private** - treat them like passwords
5. **Close tunnels** when not in use
6. **Rotate tokens** if you suspect compromise
7. **Monitor logs** for suspicious access attempts
8. **Use temporary tunnels** (Cloudflare Quick Tunnel expires automatically)

### ❌ DON'T

1. **Never share tunnel URLs publicly** (GitHub, Slack, Twitter, etc.)
2. **Never commit tokens to git** (use `.env` files with `.gitignore`)
3. **Don't use weak tokens** ("password", "123456", your name, etc.)
4. **Don't leave tunnels open 24/7** unless necessary
5. **Don't disable authentication** when using tunnels
6. **Don't expose to untrusted networks** without authentication
7. **Don't share the same token** across multiple services

### Example: Safe Tunnel Usage

```bash
# 1. Generate strong token
export MAMA_AUTH_TOKEN="$(openssl rand -base64 32)"
echo "Token: $MAMA_AUTH_TOKEN"  # Save this securely

# 2. Start MAMA
npx @jungjaehoon/mama-server &

# 3. Start temporary tunnel
cloudflared tunnel --url http://localhost:3847

# 4. Share URL + token with ONLY trusted users
# Send via encrypted channel (Signal, encrypted email, etc.)

# 5. Close tunnel when done
# Ctrl+C on cloudflared
```

---

## Threat Scenarios

### Scenario 1: Exposed Tunnel Without Token

**Mistake:**

```bash
# ❌ No authentication token set
cloudflared tunnel --url http://localhost:3847
# URL: https://abc123.trycloudflare.com
```

**Attack:**

- Attacker finds your URL (leaked in screenshot, shared by mistake)
- Opens `https://abc123.trycloudflare.com/viewer`
- Can chat with your Claude Code session
- Can read your files, execute commands via Claude Code

**Protection:**

```bash
# ✅ Set authentication token FIRST
export MAMA_AUTH_TOKEN="$(openssl rand -base64 32)"
cloudflared tunnel --url http://localhost:3847

# Now attacker needs token to access
```

### Scenario 2: Weak Token

**Mistake:**

```bash
# ❌ Weak token
export MAMA_AUTH_TOKEN="mama123"
cloudflared tunnel --url http://localhost:3847
```

**Attack:**

- Attacker tries common passwords
- `?token=mama`, `?token=password`, `?token=mama123` ✓
- Gains access

**Protection:**

```bash
# ✅ Strong random token
export MAMA_AUTH_TOKEN="$(openssl rand -base64 32)"
```

### Scenario 3: Token Leaked in URL

**Mistake:**

```bash
# ❌ Sharing URL with token in query param
https://abc123.trycloudflare.com/viewer?token=secret123

# Token visible in:
# - Browser history
# - Server logs
# - Network monitoring tools
# - Screenshots
```

**Protection:**

```bash
# ✅ Use Authorization header instead
curl -H "Authorization: Bearer secret123" https://abc123.trycloudflare.com/viewer

# Or use query param temporarily, then rotate token
```

### Scenario 4: Public Repository Exposure

**Mistake:**

```bash
# ❌ Committing .env file
git add .env
git commit -m "Add config"
git push

# .env contains:
# MAMA_AUTH_TOKEN=my-secret-token
```

**Attack:**

- Attacker scans GitHub for leaked tokens
- Finds your token
- Uses it to access your MAMA server

**Protection:**

```bash
# ✅ Add .env to .gitignore
echo ".env" >> .gitignore

# ✅ Use environment-specific configs
# Never commit secrets to git

# If you already committed:
# 1. Rotate token immediately
# 2. Use git-filter-repo to remove from history
```

---

## Summary

### Quick Security Checklist

- [ ] Using localhost only? → No token needed
- [ ] Using tunnel? → **MUST set `MAMA_AUTH_TOKEN`**
- [ ] Token is strong? → Minimum 32 characters, random
- [ ] Tunnel URL private? → Don't share publicly
- [ ] Using HTTPS tunnel? → ngrok/Cloudflare provide this
- [ ] Monitoring logs? → Check for suspicious access
- [ ] Close tunnel when done? → Don't leave open 24/7

### Default Security Posture

**MAMA is secure by default:**

- ✅ Localhost-only binding
- ✅ No external access without tunnels
- ✅ Authentication warnings when needed
- ✅ Can disable features via environment variables

**You must actively choose** to expose MAMA externally, and when you do, MAMA will warn you to set up authentication.

---

## Support

If you have security concerns or found a vulnerability:

1. **For general questions:** Open an issue on GitHub
2. **For security vulnerabilities:** Email [security contact] (DO NOT open public issue)

---

_Last updated: 2025-11-29_
_MAMA Mobile v1.5_
