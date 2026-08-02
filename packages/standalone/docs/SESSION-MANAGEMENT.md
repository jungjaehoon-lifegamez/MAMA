# Session Management Architecture

**Last Updated:** 2026-08-02

This document explains how MAMA Standalone manages CLI sessions for optimal token efficiency.

---

## Overview

MAMA Standalone uses durable Claude Code, Codex app-server, or Cline Hub sessions as its LLM
interface. Each runtime maintains its own conversation context, but opening a new session for each
message would lose that context.

**Solution:** a channel-scoped Session Pool routes each conversation to the selected backend's
native continuity mechanism. Only Claude uses CLI `--resume`; Codex uses app-server threads and
Cline uses Hub sessions.

---

## Architecture

The following diagram is the Claude Code transport path. Codex and Cline use the same channel and
policy decision above the transport boundary, but not Claude CLI flags.

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
  totalInputTokens: number; // Legacy field; zero while the runtime owns compaction
}
```

### Session Lifecycle

1. **Creation** - First message to a channel
2. **Reuse** - Subsequent messages within timeout
3. **Expiration** - 30 minutes of inactivity
4. **Compaction** - The selected runtime compacts against the active model's actual context window;
   MAMA does not infer occupancy from billing or per-run usage telemetry

---

## Backend continuity

| Backend | Durable unit      | Continuation transport                        | Missing or incompatible unit                                                                    |
| ------- | ----------------- | --------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Claude  | CLI session       | `--resume UUID`                               | Start with `--session-id UUID` and the full current prompt                                      |
| Codex   | app-server thread | Resume the thread with incremental user input | Start a replacement thread with the full current policy and bounded persisted conversation      |
| Cline   | Hub session       | `client.send()` to the bound Hub session      | Start a replacement Hub session with the full current policy and bounded persisted conversation |

Timeouts and policy mismatches invalidate the volatile Session Pool entry. Codex and Cline also
quarantine the exact backend session before a replacement can be used. Cline serializes prompts
per stable route and preserves the queue barrier when a waiting prompt times out.

## Token Optimization

### Before (v0.3.1)

Every message spawned a fresh CLI process with:

- Full system prompt (~4,000 tokens)
- Persona files (SOUL.md, IDENTITY.md, USER.md)
- Conversation history (up to 50 turns, ~4,000+ tokens)

**Result:** ~8,600 tokens per message

### Claude after v0.3.2

First message uses `--session-id`, subsequent messages use `--resume`:

| Message | Flags               | System Prompt | Notes                    |
| ------- | ------------------- | ------------- | ------------------------ |
| 1st     | `--session-id UUID` | Full          | Creates new CLI session  |
| 2nd+    | `--resume UUID`     | Full (safety) | CLI uses cached if valid |

**Note:** System prompt is always passed for safety (ensures Gateway Tools and AgentContext are available even if CLI session was lost due to daemon restart, timeout, etc.). CLI will use cached context when available, only falling back to the provided prompt if needed.

Codex and Cline do not replay the complete startup prompt on a compatible continuation. They send
only the new user input while retaining the policy installed on the durable backend session.
If that session is missing or its policy fingerprint changed, MAMA lazily rebuilds the complete
current prompt exactly for the replacement.

---

## Claude CLI Flags

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

### Context compaction

MAMA does not estimate context occupancy from per-run billing telemetry. Aggregate input-token
usage includes cached and replayed tokens and is not a reliable measure of remaining context.
Claude Code, Codex app-server, and Cline Hub therefore compact according to the active model and
runtime instead of inheriting a fixed 160K/200K reset threshold. This remains correct when the
selected model exposes a larger context window.

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
[AgentLoop] [claude] discord:123 (NEW process)
[AgentLoop] [codex] telegram:456 (CONTINUE thread)
[AgentLoop] [cline] telegram:789 (CONTINUE thread)
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
2. Claude uses resume; Codex and Cline reuse their native durable session
3. Session expires after timeout
4. A missing, timed-out, or policy-incompatible durable session is rebuilt with full current policy
5. Different channels have independent sessions
