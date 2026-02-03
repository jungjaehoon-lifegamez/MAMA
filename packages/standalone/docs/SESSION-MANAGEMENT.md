# Session Management Architecture

**Last Updated:** 2026-02-03

This document explains how MAMA Standalone manages CLI sessions for optimal token efficiency.

---

## Overview

MAMA Standalone uses Claude CLI as its LLM interface. Each CLI process maintains its own conversation context, but spawning a new process for each message would lose that context.

**Solution:** Session Pool + `--resume` flag for 99.9% token savings.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    Message Processing Flow                       │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  User Message (Discord/Viewer/etc.)                             │
│       ↓                                                          │
│  MessageRouter.process()                                         │
│       ├── channelKey = buildChannelKey(source, channelId)       │
│       │   e.g., "discord:123456789", "viewer:mama_os_main"       │
│       │                                                          │
│       ├── SessionPool.getSession(channelKey)                     │
│       │       ↓                                                  │
│       │   ┌─────────────────────────────────────────┐           │
│       │   │ Session exists and not expired?          │           │
│       │   │   YES → return { sessionId, isNew: false }│          │
│       │   │   NO  → create new, return { sessionId, isNew: true }│
│       │   └─────────────────────────────────────────┘           │
│       │                                                          │
│       ├── shouldResume = !isNew                                  │
│       │                                                          │
│       └── AgentLoop.run(prompt, {                                │
│               systemPrompt: fullPrompt,  // Always inject        │
│               resumeSession: shouldResume                        │
│           })                                                     │
│               ↓                                                  │
│           ClaudeCLIWrapper.prompt()                              │
│               ├── isNew:  claude -p "..." --session-id UUID      │
│               │           --system-prompt "..."                  │
│               │                                                  │
│               └── resume: claude -p "..." --resume UUID          │
│                           --system-prompt "..." (for safety)     │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

---

## Session Pool

### Channel Key Format

```
{source}:{channelId}

Examples:
- discord:1234567890123456789
- viewer:mama_os_main
- telegram:987654321
- slack:C0123ABCD
```

### Session Entry

```typescript
interface SessionEntry {
  sessionId: string; // UUID for Claude CLI
  lastActive: number; // Last activity timestamp
  messageCount: number; // Messages in this session
  createdAt: number; // Session creation time
  inUse: boolean; // Lock flag
  totalInputTokens: number; // Cumulative token usage
}
```

### Session Lifecycle

1. **Creation** - First message to a channel
2. **Reuse** - Subsequent messages within timeout
3. **Expiration** - 30 minutes of inactivity
4. **Reset** - Context reaches 80% of 200K tokens

---

## Token Optimization

### Before (v0.3.1)

Every message spawned a fresh CLI process with:

- Full system prompt (~4,000 tokens)
- Persona files (SOUL.md, IDENTITY.md, USER.md)
- Conversation history (up to 50 turns, ~4,000+ tokens)

**Result:** ~8,600 tokens per message

### After (v0.3.2)

First message uses `--session-id`, subsequent messages use `--resume`:

| Message | Flags               | System Prompt | Notes                    |
| ------- | ------------------- | ------------- | ------------------------ |
| 1st     | `--session-id UUID` | Full          | Creates new CLI session  |
| 2nd+    | `--resume UUID`     | Full (safety) | CLI uses cached if valid |

**Note:** System prompt is always passed for safety (ensures Gateway Tools and AgentContext are available even if CLI session was lost due to daemon restart, timeout, etc.). CLI will use cached context when available, only falling back to the provided prompt if needed.

**Result:** Token savings depend on CLI session validity. Best case maintains 90%+ savings when CLI cache hits.

---

## CLI Flags

### `--session-id UUID`

Creates or joins a specific session. Claude CLI stores conversation in:

```
~/.claude/sessions/{uuid}/
```

### `--resume UUID`

Resumes an existing session. Claude CLI:

1. Loads conversation history from disk
2. Maintains all previous context
3. Continues from where it left off

**Note:** We also pass `--system-prompt` with `--resume` for safety. If the CLI session is still valid, it uses cached context. If the session was lost (timeout, daemon restart), it uses the provided system prompt.

### `--no-session-persistence` (Not Used)

Previously used to prevent session locking. Removed because:

- Prevents session reuse (each spawn is fresh)
- Claude CLI locks sessions anyway
- `--resume` is the correct approach

---

## Role-Aware Context

### AgentContext

```typescript
interface AgentContext {
  platform: string; // 'discord', 'viewer', 'telegram'
  roleName: string; // 'os_agent', 'chat_bot'
  role: RoleConfig; // Permissions and capabilities
  session: {
    sessionId: string;
    channelId: string;
    userId?: string;
    userName?: string;
  };
  capabilities: string[]; // What this role can do
  limitations: string[]; // What this role cannot do
}
```

### Source → Role Mapping

| Source   | Role     | Permissions            |
| -------- | -------- | ---------------------- |
| viewer   | os_agent | Full system access     |
| discord  | chat_bot | Limited tools, no Bash |
| telegram | chat_bot | Limited tools, no Bash |
| Slack    | chat_bot | Limited tools, no Bash |

---

## Configuration

### Session Pool Options

```typescript
interface SessionPoolConfig {
  sessionTimeoutMs?: number; // Default: 30 minutes
  maxSessions?: number; // Default: 100
  cleanupIntervalMs?: number; // Default: 5 minutes
}
```

### Context Threshold

```typescript
const CONTEXT_THRESHOLD_TOKENS = 160000; // 80% of 200K
```

When a session exceeds this threshold, it's automatically reset on the next message.

---

## Debugging

### Enable Verbose Logging

```bash
DEBUG=mama:* mama start
```

### Log Messages

```
[SessionPool] Created new session for discord:123: abc-def-...
[SessionPool] Reusing session for discord:123: abc-def-... (msg #5, 45% context)
[MessageRouter] New CLI session (injecting 4045 chars of system prompt)
[MessageRouter] Resuming CLI session (skipping 4045 chars of system prompt)
[ClaudeCLI] New session: abc-def-...
[ClaudeCLI] Resuming session: abc-def-...
```

---

## Testing

```bash
# Run session management tests
pnpm test tests/gateways/message-router.test.ts

# Run session pool tests
pnpm test tests/agent/session-pool.test.ts
```

### Test Cases

1. First message injects system prompt
2. Second message uses resume (no system prompt)
3. Session expires after timeout
4. Session resets at context threshold
5. Different channels have independent sessions
