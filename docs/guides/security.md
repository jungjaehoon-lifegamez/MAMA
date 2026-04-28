# Security Guide

**IMPORTANT:** MAMA is designed for local use on localhost (127.0.0.1). External access via tunnels (ngrok, Cloudflare, etc.) introduces security risks. Read this guide carefully before exposing MAMA to the internet.

---

## Table of Contents

- [Security Model](#security-model)
- [Envelope Threat Model and Posture](#envelope-threat-model-and-posture)
- [Built-in Detection and Response](#built-in-detection-and-response)
- [Localhost-Only Mode (Default)](#localhost-only-mode-default)
- [External Access via Tunnels](#external-access-via-tunnels)
- [🌟 Cloudflare Zero Trust (Recommended for Production)](#cloudflare-zero-trust-recommended-for-production)
- [Token Authentication (Testing Only)](#token-authentication-testing-only)
- [Disabling Features](#disabling-features)
- [Security Best Practices](#security-best-practices)
- [Threat Scenarios](#threat-scenarios)
- [Code-Act Sandbox Security](#code-act-sandbox-security)

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
   - **Requires either `MAMA_AUTH_TOKEN` or explicit Cloudflare Access trust mode**
   - User must explicitly choose to expose MAMA

3. **Defense in Depth**
   - Token-based authentication for external requests
   - Optional trusted Cloudflare Access integration for Zero Trust deployments
   - Rate limiting on failed auth attempts
   - Security warnings when external access detected

### Built-in Detection and Response

Recent MAMA OS builds add a defensive monitoring layer for exposed deployments:

- Unauthorized API and WebSocket attempts are logged with client IP context
- **Honeypot paths trigger immediate IP ban** (15min) — probes to `.git`, `.env`, `wp-login.php`, `mama-memory.db`, etc.
- **Auth failure tracking** — 5 failures within 5 minutes → automatic IP ban (15min)
- **Tarpit delays** — suspicious IPs receive escalating response delays (up to 5s)
- **Banned IP rejection** — blocked at both middleware and requireAuth level
- All API routes (except `/health`) require authentication for non-localhost access
- SSRF and dangerous Bash patterns generate security events
- Structured events are written to `~/.mama/logs/security-events.jsonl`
- Incident evidence and abuse-report drafts are written under `~/.mama/logs/security-incidents/`

To route alerts to chat, set:

```bash
export MAMA_SECURITY_ALERT_CHANNELS="discord:CHANNEL_ID,slack:C123456"
```

## Envelope Threat Model and Posture

M1R covers Reactive runtime issuance, gateway audit logging, and memory-scope
mismatch visibility. It does not cover delegated memory workers or Autonomous
Standing agents; those belong to M7 and M8. Code-task delegation is outside the
memory-twin worker scope and must not gain memory mutation scope.

### Covered Threats

- Agent fabrication: gateway tools receive a signed envelope from the runtime,
  not from model-authored text.
- Durable audit tamper evidence: gateway tool calls record `envelope_hash`,
  requested scopes, envelope scope snapshots, and `scope_mismatch` in
  `agent_activity`.
- Irreversible exfiltration: destination sends, raw connector reads, and tiered
  write paths fail closed when the signed envelope does not authorize them.

### Not Covered

- Key extraction through process dumps, host compromise, or shell access.
- Supply-chain compromise of runtime dependencies or local plugins.
- Multi-tenant isolation. MAMA OS remains a localhost-first personal runtime.
- Delegated memory-worker envelopes and Autonomous Standing envelopes.

### Hybrid Enforcement

M1R deliberately uses a hybrid posture:

- Fail closed for destination, `raw_connector`, and tier violations because a
  wrong send or cross-boundary raw read cannot be unsent.
- Log and alarm for memory-scope mismatch because memory writes are recoverable,
  and hard denial can amplify hallucinated scope retries. The evidence is kept
  for operator review instead.

Industry pattern mapping:

- Macaroons: caveat-style narrowing maps to M1R's scoped envelope fields.
- Biscuit: decentralized capability tokens map to a possible future asymmetric
  worker-envelope design.
- Microsoft "Auditable Security Layer for Agentic AI": audit-first enforcement
  maps to M1R's durable ledger plus fail-closed irreversible boundaries.

### Mismatch Investigation

Find memory-scope mismatches in these places:

- `agent_activity` rows where `scope_mismatch=1`
- `agent_activity.requested_scopes` and `envelope_scopes_snapshot`
- `MetricsStore` counter `envelope_scope_mismatch`
- `securityLogger.warn` lines containing envelope scope mismatch context
- Authenticated `/api/envelope/status` field `recent_mismatch_count_24h`

When mismatches spike, compare `requested_scopes` with
`envelope_scopes_snapshot` for the same `envelope_hash`. Classify the cause as
prompt injection, agent hallucination, or a legitimate caller-side scope
derivation bug before changing policy.

---

## Localhost-Only Mode (Default)

### What It Means

By default, MAMA OS listens on:

```bash
[MAMA OS] API/UI: http://127.0.0.1:3847
[EmbeddingHTTP] Running at http://127.0.0.1:3849
```

**This means:**

- ✅ Only apps on your computer can connect
- ✅ No external access possible
- ✅ No authentication needed
- ✅ Safe for development and local use
- ✅ Sensitive `/api/*` routes stay blocked from non-local clients unless authenticated

### Accessing from Your Computer

```bash
# Graph Viewer
http://localhost:3847/viewer

# Mobile chat (same device only)
http://localhost:3847/viewer
```

---

## External Access via Tunnels

### ⚠️ CRITICAL Security Warning

When you use a tunnel to expose MAMA to the internet, **an attacker with access can:**

**Complete System Compromise:**

- 🔓 Control your Claude Code sessions
- 🔓 Read **ANY file** on your computer (via Read tool)
- 🔓 Write **ANY file** on your computer (via Write tool)
- 🔓 Execute **ANY command** on your machine (via Bash tool)
- 🔓 Access your decision database (`~/.claude/mama-memory.db`)
- 🔓 Steal API keys, SSH keys, passwords from config files
- 🔓 Install persistent backdoors (crontab, systemd)
- 🔓 Exfiltrate your entire hard drive

**This is not just data theft - it's full remote code execution on your machine.**

### Two Options for External Access

**For PRODUCTION use (real deployment):**

- ✅ **Use Cloudflare Zero Trust** (See below) - Google/GitHub account protection
- ⛔ **DO NOT use token authentication alone**
- ✅ Treat tunnel URLs, access policies, and `MAMA_AUTH_TOKEN` as secrets

**For TESTING only (temporary access):**

- ⚠️ **Token authentication** - Quick but less secure
- ⛔ **Never use for long-term deployment**

---

## 🌟 Cloudflare Zero Trust (Recommended for Production)

**This is the ONLY recommended way to expose MAMA for real use.**

### Why Cloudflare Zero Trust?

**Security Benefits:**

- ✅ **Google/GitHub/Microsoft account authentication** - Industry-standard OAuth
- ✅ **2FA automatically enforced** - If you have 2FA on Google, it applies to MAMA
- ✅ **Email restriction** - Only your email can access (e.g., `you@gmail.com`)
- ✅ **No token management** - No need to generate/share/rotate tokens
- ✅ **Enterprise-grade DDoS protection** - Cloudflare's infrastructure
- ✅ **Automatic rate limiting** - Brute force attacks blocked
- ✅ **Anomaly detection** - Cloudflare detects suspicious access patterns
- ✅ **Session management** - Automatic timeout, revocation
- ✅ **Zero Trust architecture** - Every request is verified

**vs Token Authentication:**

- Token alone: Anyone with token = full access
- Zero Trust: Must have your Google account + password + 2FA code

### How It Works

```
User → Cloudflare Zero Trust → Tunnel → MAMA (localhost)
        ↑
        Google/GitHub login required
        Only allowed emails can pass
```

**MAMA sees all requests as localhost** - No code changes needed!

That statement now has one important caveat for protected API routes:

- Browser/UI access through Cloudflare Access works after login
- Protected `/api/*` routes still require MAMA to trust Cloudflare Access identity headers
- To enable that mode, start MAMA with `MAMA_TRUST_CLOUDFLARE_ACCESS=true`

### Cloudflare Access Trust Mode

For Cloudflare Zero Trust deployments, run MAMA like this:

```bash
export MAMA_TRUST_CLOUDFLARE_ACCESS=true
mama start
```

What this does:

- Trusts Cloudflare Access identity headers only when the direct peer is a trusted proxy
- Allows Access-authenticated tunnel requests to reach protected `/api/*` routes without adding a second Bearer token
- Keeps direct remote requests, spoofed forwarded headers, and non-Access tunnel traffic blocked

Use `MAMA_AUTH_TOKEN` instead when:

- You are using temporary tunnels without Cloudflare Access
- You are using ngrok or another provider that does not inject Cloudflare Access identity headers
- You want temporary testing access rather than Zero Trust policy-based access

### Step-by-Step Setup

#### Prerequisites

- Cloudflare account (free)
- **Domain in Cloudflare** - Required for Zero Trust. Options:
  - Transfer existing domain to Cloudflare DNS
  - Purchase a cheap domain from Cloudflare Registrar (e.g., `.work` ~$7/year)
  - Note: Team domains like `*.cloudflareaccess.com` cannot be used for tunnel hostnames

#### Two Setup Methods

You can create tunnels using either **CLI** or **Dashboard**:

| Method    | Best For                 | Domain Required             |
| --------- | ------------------------ | --------------------------- |
| CLI       | Automation, scripting    | Need to authorize zone      |
| Dashboard | First-time setup, visual | Just need domain in account |

**Recommended:** Use Dashboard method for initial setup, then CLI for automation.

---

### Method A: Dashboard Setup (Recommended for First-Time)

#### Step A1: Install cloudflared

```bash
# Linux/Mac
# Download from: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/

# Verify installation
cloudflared --version
```

#### Step A2: Create Tunnel via Dashboard

1. Go to [Zero Trust Dashboard](https://one.dash.cloudflare.com/)
2. Navigate to **Networks** → **Tunnels**
3. Click **Create a tunnel**
4. Select **Cloudflared** → **Next**
5. Name your tunnel (e.g., `mama-mobile`) → **Save tunnel**
6. Copy the **tunnel token** (starts with `eyJ...`)

#### Step A3: Run Tunnel with Token

```bash
# Run tunnel using token (no login required)
cloudflared tunnel run --token YOUR_TUNNEL_TOKEN
```

#### Step A4: Configure Public Hostname

In the Dashboard (after creating tunnel):

1. Click **Configure** on your tunnel
2. Go to **Public Hostname** tab
3. Click **Add a public hostname**
4. Configure:
   - **Subdomain:** `mama` (or your choice)
   - **Domain:** Select your domain from dropdown
   - **Type:** `HTTP`
   - **URL:** `localhost:3847`
   - **Path:** Leave empty (routes all paths)
5. Click **Save hostname**

#### Step A5: Configure Zero Trust Access Policy

1. Go to **Zero Trust** → **Access** → **Applications**
2. Click **Add an application** → **Self-hosted**
3. Configure:
   - **Application name:** `MAMA Mobile`
   - **Session Duration:** `24 hours`
4. Click **Add public hostname**:
   - **Subdomain:** `mama`
   - **Domain:** Select your domain
5. Under **Access policies**, click **Add a policy**:
   - **Policy name:** `Owner Only`
   - **Action:** `Allow`
   - **Include** → **Emails** → Your email address
6. Click through optional settings → **Add application**

#### Step A6: Test

```bash
# Open in incognito/private browser
https://mama.yourdomain.com/viewer

# Should redirect to Google/GitHub login
# After login with allowed email → Access granted
```

---

### Method B: CLI Setup (Alternative)

Use this method if you prefer command-line or need to automate tunnel creation.

#### Step B1: Login to Cloudflare

```bash
cloudflared tunnel login

# Opens browser → Login to Cloudflare
# Select zone (domain) to authorize
```

#### Step B2: Create Named Tunnel

```bash
# Create tunnel
cloudflared tunnel create mama-mobile

# Output:
# Tunnel credentials written to /home/user/.cloudflared/UUID.json
# Tunnel mama-mobile created with ID: uuid-abc-123

# Save the tunnel ID for next steps
```

#### Step 4: Configure Tunnel

Create `~/.cloudflared/config.yml`:

```yaml
tunnel: uuid-abc-123 # Your tunnel ID from Step 3
credentials-file: /home/user/.cloudflared/uuid-abc-123.json

ingress:
  - hostname: mama.yourdomain.com # Or use Cloudflare's free subdomain
    service: http://localhost:3847
  - service: http_status:404 # Catch-all
```

#### Step 5: Route DNS

```bash
# Create DNS record pointing to tunnel
cloudflared tunnel route dns mama-mobile mama.yourdomain.com

# Or use Cloudflare dashboard:
# DNS → Add record → CNAME → mama → uuid-abc-123.cfargotunnel.com
```

#### Step 6: Configure Zero Trust Access Policy

**Via Cloudflare Dashboard:**

1. Go to **Zero Trust** → **Access** → **Applications**
2. Click **Add an application** → **Self-hosted**

**Application Configuration:**

```yaml
Application name: MAMA Mobile
Session Duration: 24 hours (or your preference)
Application domain: mama.yourdomain.com
```

**Identity Providers (Choose one or more):**

- ✅ Google (Recommended)
- ✅ GitHub (For developers)
- ✅ Microsoft/Azure AD
- ✅ Generic SAML/OIDC

**Access Policy:**

```yaml
Policy name: Allow My Email Only
Action: Allow
Include:
  - Emails: your-email@gmail.com  # YOUR email only

# Optional: Add more rules
Include:
  - Emails ending in: @yourcompany.com  # For team access
```

**Example for Personal Use:**

```yaml
Policy: Allow Only Me
Include:
  - Emails: john.doe@gmail.com
# That's it! Only your Google account can access
```

#### Step 7: Start Tunnel

```bash
# Trust Cloudflare Access identity headers from the local tunnel process
export MAMA_TRUST_CLOUDFLARE_ACCESS=true

# Start MAMA OS
mama start &

# Start Cloudflare tunnel
cloudflared tunnel run mama-mobile

# Output:
# INF Connection established connIndex=0 location=SFO
# INF Each HA connection's tunnel IDs will be identified by...
```

#### Step 8: Access MAMA

```bash
# Open browser
https://mama.yourdomain.com/viewer

# Cloudflare shows login screen
# Login with your Google account
# If your email is allowed → Access granted
# If not → Access denied
```

### Testing Your Setup

**1. Verify Zero Trust is Working:**

```bash
# Try accessing in incognito/private mode
# Should redirect to Google login
# After login with allowed email → Access granted
# After login with non-allowed email → Access denied (403)
# Protected /api/* routes should also return 200 without adding Authorization: Bearer ...
```

**2. Test with Different Accounts:**

```bash
# Your allowed email: ✅ Access granted
# Your friend's email: ❌ Access denied
# No login: ❌ Redirected to login page
```

**3. Test 2FA:**

```bash
# If you have 2FA on Google:
# 1. Login shows Google login page
# 2. After password → 2FA code required
# 3. After 2FA → Access granted

# Someone with stolen password but no 2FA device: ❌ Blocked
```

### Advantages Over Token Auth

| Feature                | Token Auth            | Cloudflare Zero Trust               |
| ---------------------- | --------------------- | ----------------------------------- |
| Brute Force Protection | Manual rate limiting  | ✅ Automatic                        |
| 2FA Support            | Manual implementation | ✅ Automatic                        |
| Account-based          | ❌ No                 | ✅ Yes                              |
| Email restriction      | ❌ No                 | ✅ Yes                              |
| Session management     | Manual                | ✅ Automatic                        |
| DDoS protection        | ❌ No                 | ✅ Yes                              |
| Audit logs             | Manual                | ✅ Built-in                         |
| Revoke access          | Change token          | ✅ One click                        |
| MAMA-side config       | `MAMA_AUTH_TOKEN`     | `MAMA_TRUST_CLOUDFLARE_ACCESS=true` |

### Free vs Paid

**Cloudflare Zero Trust Free Tier:**

- ✅ Up to 50 users
- ✅ Unlimited bandwidth
- ✅ All authentication providers
- ✅ Basic access policies
- ✅ Perfect for personal/small team use

**For Personal MAMA Use:**

- Free tier is more than enough
- No credit card required
- No hidden fees

### Troubleshooting

**Issue: "Access Denied" after login**

```bash
# Check your email in Access Policy
# Cloudflare Zero Trust → Access → Applications → MAMA Mobile → Policies
# Ensure your Google email exactly matches
```

**Issue: Tunnel won't start**

```bash
# Check config.yml syntax
cloudflared tunnel info mama-mobile

# Check MAMA is running
curl http://localhost:3847/health
```

**Issue: DNS not resolving**

```bash
# Check DNS record
dig mama.yourdomain.com

# Should show CNAME to uuid.cfargotunnel.com
```

### Security Best Practices with Zero Trust

✅ **DO:**

- Use your personal Google/GitHub account
- Enable 2FA on your auth provider
- Set short session durations (1-24 hours)
- Review access logs regularly
- Use email restriction (only your email)

❌ **DON'T:**

- Share your login credentials
- Disable 2FA to "make it easier"
- Allow `*@gmail.com` (too broad)
- Use the same password for multiple services

---

## Token Authentication (Testing Only)

⚠️ **WARNING: This section is for TESTING/DEVELOPMENT only. DO NOT use for production deployment.**

**Use cases for token auth:**

- ✅ Quick testing of MAMA Mobile features
- ✅ Temporary access for debugging
- ✅ Local network access (same WiFi)

**DO NOT use for:**

- ❌ Long-term deployment
- ❌ Public internet exposure
- ❌ Untrusted networks

### Quick Testing Setup

**For Cloudflare Quick Tunnel (expires automatically):**

```bash
# Generate a strong random token
export MAMA_AUTH_TOKEN="$(openssl rand -base64 32)"

# Or set a custom token
export MAMA_AUTH_TOKEN="your-very-secret-token-here"

# Restart MAMA OS
mama start
```

### Example: Cloudflare Quick Tunnel

```bash
# 1. Set authentication token
export MAMA_AUTH_TOKEN="my-secret-token-123"

# 2. Start MAMA OS
mama start &

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
⚠️  ❌ CRITICAL: Neither MAMA_AUTH_TOKEN nor Cloudflare Access trust mode is set!
⚠️  Anyone with your tunnel URL can access your:
⚠️    - Chat sessions with Claude Code
⚠️    - Decision database (~/.claude/mama-memory.db)
⚠️    - Local file system (via Claude Code)
⚠️
⚠️  To secure your server, either set MAMA_AUTH_TOKEN:
⚠️    export MAMA_AUTH_TOKEN="your-secret-token"
⚠️  Or, if you are using Cloudflare Zero Trust:
⚠️    export MAMA_TRUST_CLOUDFLARE_ACCESS=true
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

// External request -> Check MAMA_AUTH_TOKEN or trusted Cloudflare Access
if (!MAMA_AUTH_TOKEN && !MAMA_TRUST_CLOUDFLARE_ACCESS) {
  return false; // Deny
}

// Verify token from header or query param
if (req.headers.authorization === `Bearer ${MAMA_AUTH_TOKEN}`) {
  return true; // Allow
}

if (trustedProxyPeer && req.headers['cf-access-jwt-assertion']) {
  return true; // Allow via Cloudflare Access
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

### Easy Way: Using /mama-configure (Claude Code Only)

The easiest way to configure MAMA security settings is using the `/mama-configure` command:

```bash
# View current settings
/mama-configure
/mama-configure --show

# Disable features
/mama-configure --disable-http              # Disable Graph Viewer + Mobile Chat
/mama-configure --disable-websocket         # Disable Mobile Chat only
/mama-configure --enable-all                # Enable all features

# Set authentication token
/mama-configure --generate-token            # Generate random token
/mama-configure --set-auth-token=abc123     # Set specific token
```

**After configuration changes, restart Claude Code for changes to take effect.**

### Manual Way: Plugin Configuration

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
        "MAMA_DISABLE_HTTP_SERVER": "true",
        "MAMA_AUTH_TOKEN": "your-token-here"
      }
    }
  }
}
```

### Environment Variables (Direct Server Usage)

You can also set environment variables when running the server directly:

```bash
# Disable entire HTTP server (Graph Viewer + Mobile Chat)
export MAMA_DISABLE_HTTP_SERVER=true

# Disable only WebSocket/Mobile Chat (keep Graph Viewer)
export MAMA_DISABLE_WEBSOCKET=true

# Alternative: Disable Mobile Chat specifically
export MAMA_DISABLE_MOBILE_CHAT=true

# Set authentication token
export MAMA_AUTH_TOKEN="your-secret-token"
```

### Use Cases

**1. Paranoid Security**

```bash
# MCP tools only, no HTTP server
export MAMA_DISABLE_HTTP_SERVER=true
mama start
```

**2. Graph Viewer Only**

```bash
# Graph Viewer works, Mobile Chat disabled
export MAMA_DISABLE_MOBILE_CHAT=true
mama start
```

**3. Full Features (Default)**

```bash
# No disable flags = all features enabled
mama start
```

---

## Security Best Practices

### ✅ DO

1. **Use localhost only** unless you absolutely need external access
2. **Set strong `MAMA_AUTH_TOKEN`** before using tunnels, unless you are explicitly using Cloudflare Zero Trust trust mode
3. **Use HTTPS tunnels** (ngrok, Cloudflare provide this automatically)
4. **Keep tunnel URLs private** - treat them like passwords
5. **Close tunnels** when not in use
6. **Rotate tokens** if you suspect compromise
7. **Monitor logs** for suspicious access attempts
8. **Use temporary tunnels** (Cloudflare Quick Tunnel expires automatically)
9. **If using Cloudflare Zero Trust, set `MAMA_TRUST_CLOUDFLARE_ACCESS=true`** in the same environment that starts MAMA
10. **Review security logs** (`~/.mama/logs/security-events.jsonl`) after any external probing
11. **Wire alert channels** with `MAMA_SECURITY_ALERT_CHANNELS` before public exposure

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
mama start &

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
- [ ] Using Cloudflare Zero Trust? → Set `MAMA_TRUST_CLOUDFLARE_ACCESS=true`
- [ ] Using other tunnels? → **MUST set `MAMA_AUTH_TOKEN`**
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

## Agent Process Isolation

MAMA OS agents (Claude CLI subprocesses) must be **isolated to the `.mama` scope**. If global user settings leak into agents, it causes token waste and behavior contamination.

### Isolation Architecture

```text
User's Claude Code Session         MAMA OS Agent
─────────────────────              ─────────────────
cwd: ~/project/                    cwd: ~/.mama/workspace/
CLAUDE.md: ~/CLAUDE.md ✅          CLAUDE.md: none (blocked by git boundary)
plugins: ~/.claude/plugins/ ✅     plugins: ~/.mama/.empty-plugins/ (empty directory)
system-prompt: none                system-prompt: persona+skills+tools (injected once)
```

### Isolation Mechanisms

| #   | Mechanism                             | File                                                 | Effect                                                                                                                                                           |
| --- | ------------------------------------- | ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `cwd: ~/.mama/workspace`              | `persistent-cli-process.ts`, `claude-cli-wrapper.ts` | Restricts agent working directory to MAMA workspace                                                                                                              |
| 2   | `.git/HEAD` creation                  | Same as above                                        | Prevents Claude Code from searching for CLAUDE.md above git repo root                                                                                            |
| 3   | `--plugin-dir ~/.mama/.empty-plugins` | Same as above                                        | Points plugin directory to an empty folder                                                                                                                       |
| 4   | `--setting-sources project,local`     | Same as above                                        | Blocks loading `~/.claude/settings.json` (enabledPlugins). `--plugin-dir` alone is insufficient — it's additive, so global plugins are loaded from settings.json |

### Why This Is Needed

MAMA includes everything the agent needs in `--system-prompt`:

- Persona (conductor, developer, etc.)
- Skill catalog
- Gateway tool definitions

Without isolation, Claude Code CLI **additionally** injects the following every turn:

- `~/CLAUDE.md` (user's personal settings)
- Global plugin skills/hooks
- Duplicates of content already in `--system-prompt`

Result: **thousands of wasted tokens per turn** + agent behavior contaminated by user's personal settings.

### File Access Scope

`cwd` only restricts CLAUDE.md discovery. Agent file access is controlled separately:

- `--dangerously-skip-permissions`: allows all file access (MAMA OS default)
- `--add-dir`: allows access to specific directories (in permissions mode)

---

## Code-Act Sandbox Security

MAMA OS includes a **Code-Act sandbox** — a JavaScript execution environment powered by QuickJS (WebAssembly). This allows agents to run code without Node.js access.

### Security Model

```
User Code → QuickJS WASM Sandbox → Host Bridge → Gateway Tools (Tier 3 only)
             ↑                      ↑
             No Node.js APIs        Read-only tools only
             No file system         No Bash, no Write
             No network access      No communication tools
```

**Isolation guarantees:**

- **No Node.js APIs** — `require()`, `process`, `fs`, `child_process` are unavailable
- **No network access** — No `fetch()`, no `XMLHttpRequest`, no sockets
- **Execution timeout** — Default 30s, max 60s, enforced at engine level
- **Memory limit** — QuickJS WASM heap is bounded (default ~256 MB, set by `quickjs-emscripten` WASM allocation)
- **Tier 3 tools only** — Only read-only gateway tools are exposed via the host bridge

### Available Tools in Sandbox

Only Tier 3 (read-only) tools are injected:

- `mama_search`, `mama_load_checkpoint` — Memory read
- `Read` — File read
- `browser_get_text`, `browser_screenshot` — Browser read
- `os_list_bots`, `os_get_config` — Status read
- `pr_review_threads` — PR data read

### HTTP API Access

The Code-Act sandbox is accessible via `POST /api/code-act`. This endpoint:

- Requires `MAMA_AUTH_TOKEN` if set
- Uses Tier 3 (read-only) tools exclusively
- Has no access to agent persona or conversation context

### Risk Assessment

| Risk                | Mitigation                                   |
| ------------------- | -------------------------------------------- |
| Code injection      | QuickJS WASM isolation, no eval of host code |
| File system access  | Only via `Read` tool (read-only)             |
| Command execution   | `Bash` tool not available in Tier 3          |
| Data exfiltration   | No network access, no communication tools    |
| Resource exhaustion | Timeout + WASM memory bounds                 |

---

## Support

If you have security concerns or found a vulnerability:

1. **For general questions:** Open an issue on GitHub
2. **For security vulnerabilities:** Email [security contact] (DO NOT open public issue)

---

_Last updated: 2026-04-10_
_MAMA OS v0.18.0_
