# Gateway Configuration Guide

This guide shows you how to configure MAMA Standalone to work with Discord, Slack, Telegram, and Chatwork. Each gateway lets you run MAMA as a bot on your preferred chat platform.

> **Prerequisites:** This guide assumes you've already installed MAMA Standalone. If not, see [Standalone Setup Guide](standalone-setup.md) first.

## What are Gateways?

Gateways connect MAMA to chat platforms like Discord, Slack, and Telegram. When enabled, MAMA runs as a bot that:

- Receives messages from users
- Processes them through Claude API
- Responds with AI-generated answers
- Remembers decisions using MAMA's memory system

**Use cases:**

- Team assistant bot for your Discord server
- Slack workspace AI helper
- Personal Telegram bot for mobile access
- Multi-platform support (run all gateways simultaneously)

## Configuration File

All gateway settings live in `config.yaml` in your MAMA workspace:

```bash
# Default location
~/mama-workspace/config.yaml

# Or custom workspace
/path/to/your/workspace/config.yaml
```

**Configuration structure:**

```yaml
# Agent settings (shared across all gateways)
agent:
  model: 'claude-sonnet-4-20250514'
  max_turns: 10
  timeout_seconds: 300

# Gateway configurations
gateways:
  discord:
    enabled: true
    token: 'YOUR_DISCORD_BOT_TOKEN'
    # ... Discord-specific options

  slack:
    enabled: false
    bot_token: 'xoxb-...'
    app_token: 'xapp-...'
    # ... Slack-specific options

  telegram:
    enabled: false
    token: '123456789:ABC...'
    # ... Telegram-specific options

  chatwork:
    enabled: false
    api_token: 'YOUR_CHATWORK_TOKEN'
    # ... Chatwork-specific options
```

You can enable multiple gateways at once. MAMA will handle messages from all enabled platforms simultaneously.

---

## Discord Gateway

### Prerequisites

1. **Discord account** - Free account at https://discord.com
2. **Server admin access** - You need permission to add bots
3. **Node.js >= 22.0.0** - Required for MAMA Standalone

### Getting Your Bot Token

**Step 1: Create Application**

1. Go to https://discord.com/developers/applications
2. Click **New Application**
3. Enter a name (e.g., "MAMA Bot")
4. Click **Create**

**Step 2: Create Bot**

1. In your application, go to **Bot** tab
2. Click **Add Bot** → **Yes, do it!**
3. Under **Token**, click **Reset Token** → **Copy**
4. Save this token securely (you'll need it for config)

**Step 3: Enable Intents**

Scroll down to **Privileged Gateway Intents** and enable:

- ✅ **MESSAGE CONTENT INTENT** (required)
- ✅ **SERVER MEMBERS INTENT** (optional, for user info)

Click **Save Changes**.

**Step 4: Invite Bot to Server**

1. Go to **OAuth2** → **URL Generator**
2. Select scopes:
   - ✅ `bot`
3. Select bot permissions:
   - ✅ Read Messages/View Channels
   - ✅ Send Messages
   - ✅ Read Message History
   - ✅ Add Reactions
   - ✅ Attach Files (for image responses)
4. Copy the generated URL
5. Open URL in browser and select your server
6. Click **Authorize**

### Configuration Options

| Option               | Type    | Required | Description                             |
| -------------------- | ------- | -------- | --------------------------------------- |
| `enabled`            | boolean | Yes      | Enable Discord gateway                  |
| `token`              | string  | Yes      | Discord bot token from Developer Portal |
| `default_channel_id` | string  | No       | Default channel for notifications       |
| `guilds`             | object  | No       | Guild-specific settings (see below)     |

### Guild and Channel Configuration

Control bot behavior per server (guild) and channel:

```yaml
gateways:
  discord:
    enabled: true
    token: 'YOUR_DISCORD_BOT_TOKEN'
    guilds:
      # Specific guild ID
      '123456789012345678':
        requireMention: false # Respond to all messages
        channels:
          # Specific channel ID
          '987654321098765432':
            requireMention: true # Override: require mention in this channel

      # Wildcard: applies to all guilds not explicitly configured
      '*':
        requireMention: true # Default: require @mention
```

**How it works:**

1. **DMs**: Always respond (no mention needed)
2. **Channels with config**: Use channel-specific `requireMention` setting
3. **Channels without config**: Use guild-level `requireMention` setting
4. **Guilds without config**: Use wildcard (`*`) setting or default (require mention)

**Finding IDs:**

1. Enable Developer Mode: User Settings → Advanced → Developer Mode
2. Right-click server → Copy Server ID (guild ID)
3. Right-click channel → Copy Channel ID

### Example Configurations

**Minimal (mention required everywhere):**

```yaml
gateways:
  discord:
    enabled: true
    token: 'YOUR_DISCORD_BOT_TOKEN_HERE'
```

**Respond to all messages in specific channel:**

```yaml
gateways:
  discord:
    enabled: true
    token: 'YOUR_TOKEN'
    guilds:
      '123456789012345678': # Your server ID
        channels:
          '987654321098765432': # Your channel ID
            requireMention: false
```

**Multiple servers with different rules:**

```yaml
gateways:
  discord:
    enabled: true
    token: 'YOUR_TOKEN'
    guilds:
      # Dev server: no mention needed
      '111111111111111111':
        requireMention: false

      # Public server: mention required
      '222222222222222222':
        requireMention: true
        channels:
          # Except in bot-commands channel
          '333333333333333333':
            requireMention: false

      # All other servers: mention required
      '*':
        requireMention: true
```

### Usage Examples

```
# In Discord DM
User: Hello MAMA!
MAMA: Hi! How can I help you today?

# In channel (mention required)
User: @MAMA what's the weather?
MAMA: I don't have real-time weather data, but I can help you...

# In channel (mention not required, if configured)
User: analyze this code
MAMA: [analyzes code in previous message]

# With image attachment
User: @MAMA translate this [image with Korean text]
MAMA: [translates text from image to English]
```

---

## Slack Gateway

### Prerequisites

1. **Slack workspace** - Admin access or permission to install apps
2. **Slack account** - Free or paid workspace
3. **Node.js >= 22.0.0** - Required for MAMA Standalone

### Getting Your Tokens

Slack requires **two tokens**: bot token and app token.

**Step 1: Create Slack App**

1. Go to https://api.slack.com/apps
2. Click **Create New App** → **From scratch**
3. Enter app name (e.g., "MAMA Bot")
4. Select your workspace
5. Click **Create App**

**Step 2: Enable Socket Mode**

1. In your app settings, go to **Socket Mode**
2. Toggle **Enable Socket Mode** → **On**
3. Enter token name (e.g., "MAMA App Token")
4. Click **Generate**
5. Copy the **app token** (starts with `xapp-`)
6. Click **Done**

**Step 3: Add Bot Token Scopes**

1. Go to **OAuth & Permissions**
2. Scroll to **Scopes** → **Bot Token Scopes**
3. Add these scopes:
   - `channels:history` - Read messages in public channels
   - `channels:read` - View basic channel info
   - `chat:write` - Send messages
   - `users:read` - View user info
   - `app_mentions:read` - Receive @mentions
   - `im:history` - Read DM messages
   - `im:read` - View DM info
   - `im:write` - Send DMs

**Step 4: Install to Workspace**

1. Scroll up to **OAuth Tokens for Your Workspace**
2. Click **Install to Workspace**
3. Review permissions → **Allow**
4. Copy the **Bot User OAuth Token** (starts with `xoxb-`)

**Step 5: Subscribe to Events**

1. Go to **Event Subscriptions**
2. Toggle **Enable Events** → **On**
3. Under **Subscribe to bot events**, add:
   - `message.channels` - Messages in channels
   - `message.im` - Direct messages
   - `app_mention` - @mentions
4. Click **Save Changes**

### Configuration Options

| Option      | Type    | Required | Description                                |
| ----------- | ------- | -------- | ------------------------------------------ |
| `enabled`   | boolean | Yes      | Enable Slack gateway                       |
| `bot_token` | string  | Yes      | Bot User OAuth Token (xoxb-...)            |
| `app_token` | string  | Yes      | App-Level Token for Socket Mode (xapp-...) |
| `channels`  | object  | No       | Channel-specific settings (see below)      |

### Channel Configuration

Control bot behavior per channel:

```yaml
gateways:
  slack:
    enabled: true
    bot_token: 'YOUR_SLACK_BOT_TOKEN_HERE'
    app_token: 'YOUR_SLACK_APP_TOKEN_HERE'
    channels:
      # Specific channel ID
      'C01234567':
        requireMention: false # Respond to all messages

      # Another channel
      'C98765432':
        requireMention: true # Require @mention
```

**Default behavior:**

- **DMs**: Always respond (no mention needed)
- **Channels**: Require @mention unless configured otherwise

**Finding channel IDs:**

1. Right-click channel name → View channel details
2. Scroll down to find Channel ID
3. Or use Slack API: https://api.slack.com/methods/conversations.list

### Example Configurations

**Minimal (mention required in channels):**

```yaml
gateways:
  slack:
    enabled: true
    bot_token: 'xoxb-...'
    app_token: 'xapp-...'
```

**Respond to all messages in specific channel:**

```yaml
gateways:
  slack:
    enabled: true
    bot_token: 'xoxb-...'
    app_token: 'xapp-...'
    channels:
      'C01234567': # #bot-testing channel
        requireMention: false
```

### Usage Examples

```
# In Slack DM
User: Hello MAMA!
MAMA: Hi! How can I help you today?

# In channel (mention required)
User: @MAMA what's the status of project X?
MAMA: [searches memory for project X decisions]

# In channel (mention not required, if configured)
User: summarize this thread
MAMA: [summarizes conversation in thread]

# Thread replies
User: @MAMA analyze this
MAMA: [replies in thread, preserving context]
```

**Note:** MAMA always replies in threads to keep conversations organized.

---

## Telegram Gateway

### Prerequisites

1. **Telegram account** - Free account via mobile app
2. **Node.js >= 22.0.0** - Required for MAMA Standalone

### Getting Your Bot Token

**Step 1: Create Bot with BotFather**

1. Open Telegram and search for **@BotFather**
2. Start chat and send `/newbot`
3. Follow prompts:
   - Enter bot name (e.g., "MAMA Assistant")
   - Enter username (must end in "bot", e.g., "mama_assistant_bot")
4. Copy the **bot token** (format: `123456789:ABCdefGHIjklMNOpqrsTUVwxyz`)

**Step 2: Get Your Chat ID**

1. Search for **@userinfobot** in Telegram
2. Start chat and send any message
3. Copy your **chat ID** (numeric, e.g., `987654321`)

**Step 3: Start Your Bot**

1. Search for your bot username (e.g., `@mama_assistant_bot`)
2. Click **Start** or send `/start`

### Configuration Options

| Option          | Type     | Required | Description                          |
| --------------- | -------- | -------- | ------------------------------------ |
| `enabled`       | boolean  | Yes      | Enable Telegram gateway              |
| `token`         | string   | Yes      | Bot token from @BotFather            |
| `allowed_chats` | string[] | No       | Allowed chat IDs (empty = allow all) |

### Security: Allowed Chats

**IMPORTANT:** Without `allowed_chats`, anyone who finds your bot can use it.

```yaml
gateways:
  telegram:
    enabled: true
    token: '123456789:ABCdefGHIjklMNOpqrsTUVwxyz'
    allowed_chats:
      - '987654321' # Your personal chat ID
      - '123456789' # Another authorized user
```

**How it works:**

- If `allowed_chats` is empty or not set: Bot responds to anyone
- If `allowed_chats` has IDs: Bot only responds to those chat IDs
- Unauthorized chats are silently ignored

### Example Configurations

**Personal bot (you only):**

```yaml
gateways:
  telegram:
    enabled: true
    token: '123456789:ABCdefGHIjklMNOpqrsTUVwxyz'
    allowed_chats:
      - '987654321' # Your chat ID from @userinfobot
```

**Team bot (multiple users):**

```yaml
gateways:
  telegram:
    enabled: true
    token: '123456789:ABCdefGHIjklMNOpqrsTUVwxyz'
    allowed_chats:
      - '111111111' # Alice
      - '222222222' # Bob
      - '333333333' # Charlie
```

**Public bot (anyone can use):**

```yaml
gateways:
  telegram:
    enabled: true
    token: '123456789:ABCdefGHIjklMNOpqrsTUVwxyz'
    # No allowed_chats = open to everyone
```

### Usage Examples

```
# Start conversation
User: /start
MAMA: Hello! I'm MAMA, your AI assistant with memory. How can I help?

# Regular chat
User: What's the capital of France?
MAMA: The capital of France is Paris.

# Image translation
User: [sends image with text]
MAMA: [translates text from image]

# Decision recall
User: What did we decide about the API design?
MAMA: [searches memory and recalls decision]
```

---

## Chatwork Gateway

> **Note:** Chatwork integration has minimal adoption and is maintained for legacy users. For new projects, we recommend Discord, Slack, or Telegram.

### Prerequisites

1. **Chatwork account** - Business account with API access
2. **API token** - From Chatwork settings
3. **Node.js >= 22.0.0** - Required for MAMA Standalone

### Getting Your API Token

1. Log in to Chatwork
2. Go to Settings → API Token
3. Click **Generate Token**
4. Copy the token

### Configuration Options

| Option             | Type     | Required | Description                                 |
| ------------------ | -------- | -------- | ------------------------------------------- |
| `enabled`          | boolean  | Yes      | Enable Chatwork gateway                     |
| `api_token`        | string   | Yes      | Chatwork API token                          |
| `room_ids`         | string[] | No       | Room IDs to monitor (empty = all rooms)     |
| `poll_interval`    | number   | No       | Polling interval in ms (default: 30000)     |
| `mention_required` | boolean  | No       | Require @mention to respond (default: true) |

### Example Configuration

```yaml
gateways:
  chatwork:
    enabled: true
    api_token: 'YOUR_CHATWORK_API_TOKEN'
    room_ids:
      - '12345678' # Specific room ID
      - '87654321' # Another room
    poll_interval: 30000 # Poll every 30 seconds
    mention_required: true
```

For detailed Chatwork setup, see [Chatwork API Documentation](https://developer.chatwork.com/reference).

---

## Common Patterns

### Channel Filtering

**Problem:** You want the bot to respond in some channels but not others.

**Solution:** Use channel-specific configuration.

**Discord example:**

```yaml
gateways:
  discord:
    enabled: true
    token: 'YOUR_TOKEN'
    guilds:
      '123456789012345678':
        requireMention: true # Default: require mention
        channels:
          '111111111111111111': # #bot-commands
            requireMention: false # No mention needed here
          '222222222222222222': # #general
            requireMention: true # Mention required here
```

**Slack example:**

```yaml
gateways:
  slack:
    enabled: true
    bot_token: 'xoxb-...'
    app_token: 'xapp-...'
    channels:
      'C01234567': # #bot-testing
        requireMention: false
      'C98765432': # #general
        requireMention: true
```

### Mention Requirements

**Problem:** You want different mention rules for different contexts.

**Solution:** Configure `requireMention` per channel/guild.

#### Multi-Agent Delegation Note

If you rely on `DELEGATE::agent::task` messages (multi-agent swarm), remember:

- Delegation is parsed only if the gateway processes the message.
- With `requireMention: true`, normal messages without an @mention are ignored.
- Delegation commands are treated as explicit triggers: if any line starts with `DELEGATE::` / `DELEGATE_BG::`, it will still be processed (even without an @mention).
- Recommended: use a dedicated swarm/bot channel with `requireMention: false` so delegation can run without @mentions.
- In mention-required channels, including the bot mention is still OK and makes intent obvious:

```text
<@BOT_ID> DELEGATE::critic::WebMCP 문서 검증
```

Additional notes:

- Use the internal `agent_id` (e.g. `developer`, `reviewer`, `pm`) in `DELEGATE::{agent_id}::...` and treat it as **case-sensitive**.
- If you are running multiple bots (one token per agent) and want agents to @mention-delegate each other, enable multi-agent mention delegation:

```yaml
multi_agent:
  mention_delegation: true
  max_mention_depth: 3
```

**Behavior matrix:**

| Context                 | requireMention: false | requireMention: true | Not configured |
| ----------------------- | --------------------- | -------------------- | -------------- |
| DM                      | Responds              | Responds             | Responds       |
| Channel (mentioned)     | Responds              | Responds             | Responds       |
| Channel (not mentioned) | Responds              | Ignores              | Ignores        |

**Use cases:**

- **Private bot channel**: `requireMention: false` - Treat like DM
- **Public channel**: `requireMention: true` - Avoid spam
- **Testing channel**: `requireMention: false` - Easy testing

### Message Splitting

**Problem:** Claude responses can be very long, but chat platforms have limits.

**Solution:** MAMA automatically splits long messages.

**Platform limits:**

- **Discord**: 2000 characters per message
- **Slack**: 4000 characters per message
- **Telegram**: 4096 characters per message

**How it works:**

1. MAMA generates full response from Claude
2. Splits at natural boundaries (newlines, paragraphs)
3. Sends multiple messages in sequence
4. Preserves formatting and code blocks

**Example:**

```
User: Explain how MAMA works in detail

MAMA: [Message 1/3]
MAMA is a memory system for Claude that remembers...
[2000 characters]

MAMA: [Message 2/3]
The architecture consists of three main components...
[2000 characters]

MAMA: [Message 3/3]
You can configure MAMA using the config.yaml file...
[remaining text]
```

No configuration needed - this happens automatically.

### Multiple Gateways

**Problem:** You want to run MAMA on multiple platforms simultaneously.

**Solution:** Enable multiple gateways in config.

**Example:**

```yaml
gateways:
  discord:
    enabled: true
    token: 'DISCORD_TOKEN'

  slack:
    enabled: true
    bot_token: 'SLACK_BOT_TOKEN'
    app_token: 'SLACK_APP_TOKEN'

  telegram:
    enabled: true
    token: 'TELEGRAM_TOKEN'
    allowed_chats: ['123456789']
```

**What you get:**

- Same MAMA instance handles all platforms
- Shared memory database across all gateways
- Decisions saved from Discord are available in Slack/Telegram
- Single agent loop processes all messages

**Use case:** Personal bot on Telegram + team bot on Discord + work bot on Slack.

---

## Troubleshooting

### Gateway Won't Connect

**Symptoms:**

- `mama status` shows gateway as "disconnected"
- No response to messages

**Solutions:**

1. **Verify token:**

   ```bash
   # Check config.yaml
   cat ~/mama-workspace/config.yaml
   ```

2. **Check enabled flag:**

   ```yaml
   gateways:
     discord:
       enabled: true # Must be true
   ```

3. **Restart MAMA:**

   ```bash
   mama stop
   mama start
   ```

4. **Check logs:**
   ```bash
   tail -f ~/.mama/logs/mama.log
   ```

### Bot Not Responding

**Discord:**

- ✅ MESSAGE CONTENT INTENT enabled?
- ✅ Bot has permission to read/send in channel?
- ✅ Mention required but you didn't @mention?

**Slack:**

- ✅ Socket Mode enabled?
- ✅ Event subscriptions configured?
- ✅ Bot invited to channel? (Use `/invite @MAMA`)

**Telegram:**

- ✅ Your chat ID in `allowed_chats`?
- ✅ You sent `/start` to bot?

### Token Errors

**Discord:**

```
Error: Incorrect login details were provided.
```

→ Token is invalid. Reset token in Discord Developer Portal.

**Slack:**

```
Error: invalid_auth
```

→ Check both `bot_token` (xoxb-) and `app_token` (xapp-) are correct.

**Telegram:**

```
Error: 401 Unauthorized
```

→ Token is invalid. Create new bot with @BotFather.

### Rate Limiting

**Symptoms:**

- Messages delayed
- Some messages not sent

**Solutions:**

1. **Discord:** MAMA has built-in 150ms throttle for edits
2. **Slack:** Use threads (automatic in MAMA)
3. **Telegram:** Reduce message frequency

**If rate limited:**

- Wait a few minutes
- Reduce message volume
- Use shorter responses (configure Claude model)

### Permission Errors

**Discord:**

```
Missing Permissions
```

→ Re-invite bot with correct permissions (see Discord setup above).

**Slack:**

```
missing_scope
```

→ Add required scopes in OAuth & Permissions, then reinstall app.

---

## Next Steps

- **Configure agent settings:** See [Standalone Setup Guide](standalone-setup.md)
- **Set up heartbeat monitoring:** See [Heartbeat Configuration](heartbeat-config.md)
- **Build custom skills:** See [Skills Development Guide](skills-development.md)
- **Secure external access:** See [Security Guide](security.md)

---

## Related Documentation

- [MAMA Standalone README](../../packages/standalone/README.md) - Overview and installation
- [Standalone Setup Guide](standalone-setup.md) - General setup and initialization
- [Security Guide](security.md) - External access and authentication
- [CLI Reference](../reference/cli.md) - Command-line interface documentation

---

**Last Updated:** 2026-02-01  
**MAMA OS Version:** 0.1.0
