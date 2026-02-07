# MAMA Standalone Troubleshooting Guide

**Audience:** Users running MAMA Standalone agent with gateway integrations  
**Common Issues:** API key errors, gateway connection failures, permission issues, port conflicts, process management

---

## Quick Diagnostics

```bash
# Check agent status
mama status

# View recent logs
tail -f ~/.mama/logs/mama.log

# Verify configuration
cat ~/.mama/config.yaml

# Test single prompt (validates API key and config)
mama run "test" --verbose
```

---

## Common Issues

### 1. API Key Issues

#### Missing ANTHROPIC_API_KEY

**Symptoms:**

- `mama start` fails with "API key not found"
- `mama run` shows authentication error
- Status shows "OAuth 토큰: 무효 ❌"

**Diagnosis:**

```bash
# Check if API key is set
echo $ANTHROPIC_API_KEY

# Expected: sk-ant-...
# If empty: API key not set
```

**Solution:**

```bash
# Set API key in your shell profile
echo 'export ANTHROPIC_API_KEY="sk-ant-..."' >> ~/.bashrc
source ~/.bashrc

# Or set temporarily for testing
export ANTHROPIC_API_KEY="sk-ant-..."

# Verify it's set
mama run "test" --verbose
```

**For persistent setup:**

```bash
# Add to ~/.bashrc or ~/.zshrc
export ANTHROPIC_API_KEY="sk-ant-api03-..."

# Reload shell
source ~/.bashrc  # or source ~/.zshrc
```

#### Invalid API Key Format

**Symptoms:**

- Error: "Invalid API key format"
- Authentication fails even with key set

**Diagnosis:**

```bash
# Check key format
echo $ANTHROPIC_API_KEY | wc -c

# Expected: ~100-120 characters
# Format: sk-ant-api03-...
```

**Solution:**

1. Verify you copied the full key (no truncation)
2. Check for extra spaces or quotes:

   ```bash
   # Wrong (has quotes)
   export ANTHROPIC_API_KEY="'sk-ant-...'"

   # Correct
   export ANTHROPIC_API_KEY="sk-ant-..."
   ```

3. Get a fresh API key from https://console.anthropic.com/settings/keys

#### Rate Limiting (429 Errors)

**Symptoms:**

- Error: "Rate limit exceeded"
- HTTP 429 responses in logs
- Agent stops responding after several messages

**Diagnosis:**

```bash
# Check logs for rate limit errors
grep "429" ~/.mama/logs/mama.log

# Check recent API usage
grep "API request" ~/.mama/logs/mama.log | tail -20
```

**Solution:**

1. **Wait and retry** - Rate limits reset after a period
2. **Reduce request frequency:**
   ```yaml
   # In config.yaml
   agent:
     timeout: 300000 # Increase timeout (5 minutes)
     max_turns: 5 # Reduce max conversation turns
   ```
3. **Check your Anthropic plan** - Upgrade if hitting limits frequently
4. **Disable heartbeat during high usage:**
   ```yaml
   heartbeat:
     enabled: false # Temporarily disable
   ```

---

### 2. Gateway Connection Failures

#### Discord: Invalid Token

**Symptoms:**

- Discord gateway shows "not connected" in status
- Error: "Invalid token" in logs
- Bot doesn't respond to mentions

**Diagnosis:**

```bash
# Check Discord config
grep -A 3 "discord:" ~/.mama/config.yaml

# Check logs for Discord errors
grep "Discord" ~/.mama/logs/mama.log | tail -10
```

**Solution:**

1. **Verify token format:**

   ```yaml
   gateways:
     discord:
       enabled: true
       token: 'YOUR_DISCORD_BOT_TOKEN_HERE'
   ```

   - Token should be ~70+ characters
   - Format: `{user_id}.{timestamp}.{hmac}`

2. **Regenerate token:**
   - Go to https://discord.com/developers/applications
   - Select your application → Bot
   - Click "Reset Token"
   - Update `config.yaml` with new token

3. **Restart agent:**
   ```bash
   mama stop
   mama start
   ```

#### Discord: Missing Intents

**Symptoms:**

- Bot connects but doesn't see messages
- No response to @mentions
- Logs show "Missing Access" errors

**Solution:**

1. Enable required intents in Discord Developer Portal:
   - Go to https://discord.com/developers/applications
   - Select your application → Bot
   - Enable **MESSAGE CONTENT INTENT** (required)
   - Enable **SERVER MEMBERS INTENT** (optional)
   - Enable **PRESENCE INTENT** (optional)

2. Verify bot permissions in server:
   - Read Messages/View Channels
   - Send Messages
   - Read Message History
   - Add Reactions

3. Reinvite bot with correct permissions:
   ```
   https://discord.com/api/oauth2/authorize?client_id=YOUR_CLIENT_ID&permissions=274877975552&scope=bot
   ```

#### Slack: Bot/App Token Mismatch

**Symptoms:**

- Slack gateway fails to connect
- Error: "Invalid token" or "Token mismatch"
- Bot appears offline in Slack

**Diagnosis:**

```bash
# Check Slack config
grep -A 5 "slack:" ~/.mama/config.yaml

# Verify token prefixes
# bot_token should start with: xoxb-
# app_token should start with: xapp-
```

**Solution:**

1. **Verify token types:**

   ```yaml
   gateways:
     slack:
       enabled: true
       bot_token: 'xoxb-...' # Bot User OAuth Token
       app_token: 'xapp-...' # App-Level Token
   ```

2. **Get correct tokens:**
   - Go to https://api.slack.com/apps
   - Select your app
   - **Bot token:** OAuth & Permissions → Bot User OAuth Token
   - **App token:** Basic Information → App-Level Tokens

3. **Enable Socket Mode:**
   - Settings → Socket Mode → Enable
   - Create app-level token with `connections:write` scope

4. **Verify bot scopes:**
   - `channels:history`
   - `channels:read`
   - `chat:write`
   - `users:read`

#### Telegram: Bot Not Started

**Symptoms:**

- Telegram bot doesn't respond
- Error: "Forbidden: bot was blocked by the user"
- Messages not received

**Solution:**

1. **Start conversation with bot:**
   - Open Telegram
   - Search for your bot (@YourBotName)
   - Click "START" button
   - Send a test message

2. **Verify chat ID is allowed:**

   ```yaml
   gateways:
     telegram:
       enabled: true
       token: '123456789:ABCdefGHI...'
       allowed_chat_ids:
         - 987654321 # Your chat ID
   ```

3. **Get your chat ID:**
   - Message @userinfobot on Telegram
   - Copy your ID
   - Add to `allowed_chat_ids` in config

4. **Check bot token:**
   - Message @BotFather
   - Send `/mybots` → Select bot → API Token
   - Verify token matches config

---

### 3. Permission Issues

#### File System Permissions

**Symptoms:**

- Error: "EACCES: permission denied"
- Cannot write to `~/.mama/` directory
- Database creation fails

**Diagnosis:**

```bash
# Check directory permissions
ls -la ~/.mama/

# Expected: drwxr-xr-x (755)
# If different: Permission issue
```

**Solution:**

```bash
# Fix directory permissions
chmod 755 ~/.mama/
chmod 755 ~/.mama/logs/

# Fix file permissions
chmod 644 ~/.mama/config.yaml
chmod 644 ~/.mama/logs/mama.log

# If database exists
chmod 644 ~/.claude/mama-memory.db
```

**If permission denied persists:**

```bash
# Check ownership
ls -la ~/.mama/

# If owned by different user, reclaim ownership
sudo chown -R $USER:$USER ~/.mama/
```

#### Port Binding (3847 Already in Use)

**Symptoms:**

- Error: "EADDRINUSE: address already in use :::3847"
- MAMA OS viewer won't start
- `mama start` fails

**Note:** MAMA OS uses three ports:

- **3847** - API server (viewer, graph API, sessions)
- **3848** - Setup wizard (`mama setup`)
- **3849** - Embedding server

**Diagnosis:**

```bash
# Check what's using port 3847
lsof -i :3847

# Or on Linux
netstat -tulpn | grep 3847

# Expected: Shows process using the port
```

**Solution:**

**Option 1: Stop conflicting process**

```bash
# Find process ID
lsof -i :3847

# Kill process (replace PID)
kill -9 PID
```

**Option 2: Change MAMA port**

```bash
# Set custom port via environment variable
export MAMA_HTTP_PORT=8080

# Or edit config.yaml
vim ~/.mama/config.yaml
```

```yaml
# Add viewer port configuration
viewer:
  enabled: true
  port: 8080 # Use different port
```

**Option 3: Stop existing MAMA instance**

```bash
# If another MAMA is running
mama stop

# Wait a few seconds
sleep 3

# Start again
mama start
```

---

### 4. Process Management

#### Standalone Won't Start

**Symptoms:**

- `mama start` exits immediately
- No PID file created
- Status shows "정지됨 ✗"

**Diagnosis:**

```bash
# Check for errors in logs
tail -50 ~/.mama/logs/mama.log

# Try foreground mode to see errors
mama start --foreground
```

**Common causes and solutions:**

1. **Missing API key:**

   ```bash
   export ANTHROPIC_API_KEY="sk-ant-..."
   ```

2. **Invalid config:**

   ```bash
   # Validate config
   cat ~/.mama/config.yaml

   # Regenerate if corrupted
   mama init --force
   ```

3. **Port conflict:**

   ```bash
   # Change port
   export MAMA_HTTP_PORT=8080
   ```

4. **Database locked:**

   ```bash
   # Check for lock file
   ls -la ~/.claude/mama-memory.db-*

   # Remove if stale
   rm ~/.claude/mama-memory.db-shm
   rm ~/.claude/mama-memory.db-wal
   ```

#### Process Zombie/Orphan

**Symptoms:**

- `mama status` shows running but not responding
- PID file exists but process is dead
- Cannot start new instance

**Diagnosis:**

```bash
# Check if process actually exists
ps aux | grep mama

# Check PID file
cat ~/.mama/mama.pid

# Verify process is alive (replace PID)
kill -0 PID
```

**Solution:**

```bash
# Clean up stale PID file
rm ~/.mama/mama.pid

# Force kill if process exists
pkill -9 -f "mama.*daemon"

# Start fresh
mama start
```

#### Multiple Instances Running

**Symptoms:**

- Multiple MAMA processes in `ps` output
- Conflicting responses from gateways
- High CPU usage

**Diagnosis:**

```bash
# List all MAMA processes
ps aux | grep mama | grep -v grep

# Count instances
ps aux | grep mama | grep -v grep | wc -l
```

**Solution:**

```bash
# Stop all instances
mama stop

# Force kill any remaining
pkill -9 -f "mama.*daemon"

# Clean PID file
rm ~/.mama/mama.pid

# Start single instance
mama start

# Verify only one running
ps aux | grep mama | grep -v grep
```

---

## Diagnostic Commands

### Status Check

```bash
# Full status overview
mama status

# Output includes:
# - Running state (실행 중 / 정지됨)
# - PID and uptime
# - OAuth token validity
# - Database path
# - Model configuration
# - Log level
```

### Log Inspection

```bash
# View recent logs
tail -f ~/.mama/logs/mama.log

# Search for errors
grep -i error ~/.mama/logs/mama.log

# Search for specific gateway
grep "Discord" ~/.mama/logs/mama.log

# View last 100 lines
tail -100 ~/.mama/logs/mama.log
```

### Configuration Validation

```bash
# View current config
cat ~/.mama/config.yaml

# Check config syntax (YAML)
python3 -c "import yaml; yaml.safe_load(open('$HOME/.mama/config.yaml'))"

# Verify required fields
grep -E "model|token|enabled" ~/.mama/config.yaml
```

### Database Check

```bash
# Check database exists
ls -lh ~/.claude/mama-memory.db

# Verify database integrity
sqlite3 ~/.claude/mama-memory.db "PRAGMA integrity_check;"

# Count decisions
sqlite3 ~/.claude/mama-memory.db "SELECT COUNT(*) FROM decisions;"
```

---

## Log Locations

All MAMA Standalone logs are stored in `~/.mama/logs/`:

```bash
~/.mama/logs/
├── mama.log          # Main agent log
├── discord.log       # Discord gateway log (if enabled)
├── slack.log         # Slack gateway log (if enabled)
└── telegram.log      # Telegram gateway log (if enabled)
```

**Log rotation:**

- Logs rotate daily
- Old logs: `mama.log.2026-01-31`
- Kept for 7 days by default

**Increase log verbosity:**

```yaml
# In config.yaml
logging:
  level: debug # Change from 'info' to 'debug'
```

---

## Recovery Steps

### Clean Restart

When all else fails, perform a clean restart:

```bash
# 1. Stop agent
mama stop

# 2. Backup current config
cp ~/.mama/config.yaml ~/.mama/config.yaml.backup

# 3. Clear logs (optional)
rm ~/.mama/logs/*.log

# 4. Remove PID file
rm ~/.mama/mama.pid

# 5. Verify API key is set
echo $ANTHROPIC_API_KEY

# 6. Start fresh
mama start --foreground

# 7. If successful, switch to daemon mode
# Press Ctrl+C, then:
mama start
```

### Configuration Reset

If config is corrupted:

```bash
# 1. Backup existing config
cp ~/.mama/config.yaml ~/.mama/config.yaml.broken

# 2. Regenerate default config
mama init --force

# 3. Manually restore gateway tokens
vim ~/.mama/config.yaml

# 4. Test configuration
mama run "test" --verbose
```

### Database Reset (Last Resort)

⚠️ **WARNING:** This deletes all saved decisions and checkpoints.

```bash
# 1. Backup database
cp ~/.claude/mama-memory.db ~/.claude/mama-memory.db.backup

# 2. Remove database
rm ~/.claude/mama-memory.db

# 3. Restart agent (will recreate database)
mama stop
mama start

# 4. Verify new database created
ls -lh ~/.claude/mama-memory.db
```

---

## Getting Help

**Still having issues?**

1. **Check GitHub Issues:** [MAMA/issues](https://github.com/jungjaehoon-lifegamez/MAMA/issues)

2. **Gather diagnostic info:**

   ```bash
   # System info
   uname -a
   node --version

   # MAMA status
   mama status

   # Recent logs
   tail -50 ~/.mama/logs/mama.log

   # Config (redact tokens!)
   cat ~/.mama/config.yaml | sed 's/token: .*/token: REDACTED/'
   ```

3. **Create issue with:**
   - OS and Node.js version
   - MAMA Standalone version (`npm list -g @jungjaehoon/mama-os`)
   - Error messages from logs
   - Steps to reproduce

---

**Related Guides:**

- [MAMA Standalone README](../../packages/standalone/README.md)
- [General Troubleshooting](troubleshooting.md) (for MCP server issues)
- [Security Guide](security.md)
- [Installation Guide](installation.md)
