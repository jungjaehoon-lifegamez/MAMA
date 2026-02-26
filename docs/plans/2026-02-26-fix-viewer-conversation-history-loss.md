# Fix Viewer Conversation History Loss on Refresh/Navigation

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Ensure MAMA OS viewer conversations survive page refresh and navigation without losing intermediate messages.

**Architecture:** Three-layer fix: (1) Server streams accumulator that persists partial responses on `stream_end`, (2) Server history endpoint returns per-message granularity instead of `{user, bot}` pairs, (3) Frontend merges server history with localStorage instead of replacing.

**Tech Stack:** TypeScript, SQLite (better-sqlite3), WebSocket (ws), Vitest

---

## Root Causes Summary

| #   | Cause                                                                             | File                       | Fix                                           |
| --- | --------------------------------------------------------------------------------- | -------------------------- | --------------------------------------------- |
| 1   | DB only saves after full `process()` return — streaming responses lost on refresh | `message-router.ts:577`    | Save in websocket-handler on `stream_end`     |
| 2   | `displayHistory()` replaces entire DOM with server data                           | `chat.ts:1883`             | Merge instead of replace                      |
| 3   | Server stores `{user, bot}` pairs — no per-message granularity                    | `session-store.ts:155-189` | Extend schema to store individual messages    |
| 4   | localStorage key tied to sessionId — new session loses old cache                  | `chat.ts:1766`             | Use channel-based key (`viewer_mama_os_main`) |
| 5   | `maxHistoryMessages=50` in localStorage too low for long conversations            | `chat.ts:154`              | Increase and align with server                |

---

### Task 1: Extend SessionStore to support per-message history

The current `updateSession()` stores `{user, bot, timestamp}` turns as a single JSON blob. This means streamed responses can only be saved as complete pairs. We need a method that can save individual messages.

**Files:**

- Modify: `packages/standalone/src/gateways/session-store.ts:155-189`
- Test: `packages/standalone/tests/gateways/session-store.test.ts`

**Step 1: Write the failing test**

```typescript
// In session-store.test.ts, add:
describe('appendMessage', () => {
  it('should append a single user message without bot response', () => {
    const session = store.getOrCreate('viewer', 'test_channel', 'user1');
    store.appendMessage(session.id, { role: 'user', content: 'hello', timestamp: Date.now() });

    const history = store.getHistory(session.id);
    expect(history).toHaveLength(1);
    expect(history[0].user).toBe('hello');
    expect(history[0].bot).toBe('');
  });

  it('should append a bot message to the last incomplete turn', () => {
    const session = store.getOrCreate('viewer', 'test_channel2', 'user1');
    store.appendMessage(session.id, { role: 'user', content: 'hello', timestamp: Date.now() });
    store.appendMessage(session.id, {
      role: 'assistant',
      content: 'hi there',
      timestamp: Date.now(),
    });

    const history = store.getHistory(session.id);
    expect(history).toHaveLength(1);
    expect(history[0].user).toBe('hello');
    expect(history[0].bot).toBe('hi there');
  });

  it('should start a new turn if last turn is complete', () => {
    const session = store.getOrCreate('viewer', 'test_channel3', 'user1');
    store.appendMessage(session.id, { role: 'user', content: 'q1', timestamp: Date.now() });
    store.appendMessage(session.id, { role: 'assistant', content: 'a1', timestamp: Date.now() });
    store.appendMessage(session.id, { role: 'user', content: 'q2', timestamp: Date.now() });

    const history = store.getHistory(session.id);
    expect(history).toHaveLength(2);
    expect(history[1].user).toBe('q2');
    expect(history[1].bot).toBe('');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd packages/standalone && pnpm vitest run tests/gateways/session-store.test.ts -t "appendMessage"`
Expected: FAIL with "store.appendMessage is not a function"

**Step 3: Write minimal implementation**

Add to `session-store.ts` after `updateSession()`:

```typescript
/**
 * Append a single message (user or assistant) to session history.
 * - role='user': creates a new turn with empty bot
 * - role='assistant': fills bot field of last incomplete turn, or creates new turn
 */
appendMessage(
  sessionId: string,
  msg: { role: 'user' | 'assistant'; content: string; timestamp: number }
): boolean {
  const session = this.getById(sessionId);
  if (!session) return false;

  let history: ConversationTurn[];
  try {
    history = JSON.parse(session.context || '[]');
  } catch {
    history = [];
  }

  if (msg.role === 'user') {
    history.push({ user: msg.content, bot: '', timestamp: msg.timestamp });
  } else {
    // Find last turn with empty bot
    const lastTurn = history[history.length - 1];
    if (lastTurn && lastTurn.bot === '') {
      lastTurn.bot = msg.content;
      lastTurn.timestamp = msg.timestamp;
    } else {
      // No incomplete turn — create orphan bot response
      history.push({ user: '', bot: msg.content, timestamp: msg.timestamp });
    }
  }

  const recentHistory = history.slice(-this.maxTurns);

  const result = this.db
    .prepare('UPDATE messenger_sessions SET context = ?, last_active = ? WHERE id = ?')
    .run(JSON.stringify(recentHistory), Date.now(), sessionId);

  return result.changes > 0;
}
```

**Step 4: Run test to verify it passes**

Run: `cd packages/standalone && pnpm vitest run tests/gateways/session-store.test.ts -t "appendMessage"`
Expected: PASS

**Step 5: Commit**

```bash
git add packages/standalone/src/gateways/session-store.ts packages/standalone/tests/gateways/session-store.test.ts
git commit -m "feat(session-store): add appendMessage for per-message history persistence"
```

---

### Task 2: Save streamed response on `stream_end` in WebSocket handler

Currently the DB is only updated when `messageRouter.process()` returns (after the full agent loop). We need the WebSocket handler to accumulate streamed deltas and save the assistant message immediately on `stream_end`.

**Files:**

- Modify: `packages/mama-core/src/embedding-server/mobile/websocket-handler.ts:397-548`
- Test: (manual integration — WebSocket handler is hard to unit test; verified via Task 3)

**Step 1: Add stream accumulator and save on stream_end**

In `websocket-handler.ts`, inside the `case 'send':` handler, the `onStream.onDelta` callback already accumulates via `deltasSent`. We need to:

1. Track accumulated text server-side
2. On `stream_end` equivalent (after `messageRouter.process()` returns), save via `sessionStore.appendMessage()`

The actual fix is simpler than adding to onDelta — `messageRouter.process()` already calls `sessionStore.updateSession()` at line 577. The problem is the **user message** isn't saved until the bot response completes. We need to save the user message immediately when received.

Modify the `case 'send':` block in `websocket-handler.ts`:

```typescript
// After normalizedMessage is created (line ~466), before messageRouter.process():

// Save user message immediately so it persists even if response is interrupted
if (sessionStore && (sessionStore as any).appendMessage) {
  try {
    // Get or create session for this channel
    const channelSession = (sessionStore as any).getOrCreate?.(
      clientInfo.osAgentMode ? 'viewer' : 'mobile',
      'mama_os_main',
      clientInfo.userId
    );
    if (channelSession) {
      (sessionStore as any).appendMessage(channelSession.id, {
        role: 'user' as const,
        content: content || '',
        timestamp: Date.now(),
      });
    }
  } catch (err) {
    logger.warn('Failed to save user message:', err instanceof Error ? err.message : String(err));
  }
}
```

But wait — this would cause **double-saving** because `messageRouter.process()` at line 577 also calls `updateSession(session.id, message.text, response)` which saves both user + bot.

**Better approach:** Instead of saving in websocket-handler, we modify `messageRouter.process()` to save the user message first, then update the bot response separately.

**Step 2: Modify message-router.ts to save user message early**

In `message-router.ts`, add user message save right before the agent loop call (after session is obtained):

```typescript
// After line 350 (session & agentContext created), before agent loop:
// Save user message immediately for crash/refresh resilience
this.sessionStore.appendMessage(session.id, {
  role: 'user',
  content: message.text,
  timestamp: Date.now(),
});
```

Then change the existing `updateSession()` call at line 577 to only save the bot response:

```typescript
// Replace line 577:
// this.sessionStore.updateSession(session.id, message.text, response);
// With:
this.sessionStore.appendMessage(session.id, {
  role: 'assistant',
  content: response,
  timestamp: Date.now(),
});
```

**Step 3: Run existing tests to verify no regression**

Run: `cd packages/standalone && pnpm vitest run tests/gateways/`
Expected: All existing tests PASS

**Step 4: Commit**

```bash
git add packages/standalone/src/gateways/message-router.ts
git commit -m "fix(message-router): save user message immediately before agent loop"
```

---

### Task 3: Fix localStorage key to use channel-based key instead of sessionId

When the server creates a new session (e.g., after restart), the sessionId changes but the channel (`viewer/mama_os_main`) stays the same. localStorage keyed by sessionId means the old history is orphaned.

**Files:**

- Modify: `packages/standalone/public/viewer/src/modules/chat.ts:153,1766,1782,1926,1943`

**Step 1: Change historyPrefix to use channel-based key**

The viewer always uses `source=viewer, channelId=mama_os_main`. We should use a fixed key.

In `chat.ts`, change `saveToHistory()`:

```typescript
// Line 1766: Change from sessionId-based key to fixed channel key
// OLD:
const storageKey = this.historyPrefix + this.sessionId;
// NEW:
const storageKey = this.historyPrefix + 'viewer_mama_os_main';
```

In `loadHistory()`:

```typescript
// Line 1782: Same change
// OLD:
const storageKey = this.historyPrefix + sessionId;
// NEW:
const storageKey = this.historyPrefix + 'viewer_mama_os_main';
```

In `clearHistory()`:

```typescript
// Line 1926: Same change
// OLD:
const storageKey = this.historyPrefix + (sessionId || this.sessionId);
// NEW:
const storageKey = this.historyPrefix + 'viewer_mama_os_main';
```

In `restoreHistory()` and cleanup — update all references to use the channel key.

**Step 2: Increase maxHistoryMessages**

```typescript
// Line 154: Increase from 50 to 200
maxHistoryMessages = 200;
```

**Step 3: Build and verify**

Run: `cd packages/standalone && pnpm build`
Expected: Build succeeds

**Step 4: Commit**

```bash
git add packages/standalone/public/viewer/src/modules/chat.ts
git commit -m "fix(viewer): use channel-based localStorage key, increase history limit to 200"
```

---

### Task 4: Merge server history with localStorage instead of replacing

`displayHistory()` currently does `container.innerHTML = ''` and replaces everything with server data. If server history is shorter than local (e.g., streaming message not yet saved), we lose messages.

**Files:**

- Modify: `packages/standalone/public/viewer/src/modules/chat.ts:1871-1919`

**Step 1: Implement merge logic in displayHistory()**

Replace the current `displayHistory()` with a merge strategy:

```typescript
displayHistory(messages: ChatHistoryMessage[]): void {
  const container = getElementByIdOrNull<HTMLDivElement>('chat-messages');
  if (!container) {
    return;
  }

  // Server history is authoritative — always use it when available
  if (messages.length === 0 && this.history.length > 0) {
    logger.info(`Server sent empty history, keeping local (${this.history.length})`);
    return;
  }

  // Merge: use server messages as base, append any local-only messages
  // that are newer than the last server message
  const serverTimestamp = messages.length > 0
    ? new Date(messages[messages.length - 1].timestamp || 0).getTime()
    : 0;

  const localOnlyMessages = this.history.filter((msg) => {
    const msgTime = new Date(msg.timestamp).getTime();
    return msgTime > serverTimestamp && msg.role !== 'system';
  });

  const merged = [...messages, ...localOnlyMessages];

  container.innerHTML = '';
  this.history = merged;

  // Use DocumentFragment for batch DOM insertion
  const fragment = document.createDocumentFragment();
  const messagesToRender = merged.slice(-this.maxDomMessages);

  messagesToRender.forEach((msg) => {
    const msgEl = document.createElement('div');
    msgEl.className = `chat-message ${msg.role}`;

    const timestamp = msg.timestamp ? new Date(msg.timestamp) : new Date();

    if (msg.role === 'user') {
      msgEl.innerHTML = `
        <div class="message-content">${escapeHtml(msg.content)}</div>
        <div class="message-time">${formatMessageTime(timestamp)}</div>
      `;
    } else if (msg.role === 'assistant') {
      msgEl.innerHTML = `
        <div class="message-content">${formatAssistantMessage(msg.content)}</div>
        <div class="message-time">${formatMessageTime(timestamp)}</div>
      `;
    } else if (msg.role === 'system') {
      msgEl.innerHTML = `
        <div class="message-content">${escapeHtml(msg.content)}</div>
      `;
    }

    fragment.appendChild(msgEl);
  });

  container.appendChild(fragment);
  scrollToBottom(container);

  // Save merged history to localStorage
  this.saveCurrentHistory();

  logger.info('Displayed', messagesToRender.length, 'messages (server:', messages.length, '+ local:', localOnlyMessages.length, ')');
}
```

Also add a helper to save current history without requiring a new message:

```typescript
private saveCurrentHistory(): void {
  if (!this.sessionId) return;
  try {
    const storageKey = this.historyPrefix + 'viewer_mama_os_main';
    const storageData = {
      history: this.history,
      savedAt: Date.now(),
    };
    localStorage.setItem(storageKey, JSON.stringify(storageData));
  } catch (e) {
    logger.warn('Failed to save history:', e);
  }
}
```

**Step 2: Build and verify**

Run: `cd packages/standalone && pnpm build`
Expected: Build succeeds

**Step 3: Commit**

```bash
git add packages/standalone/public/viewer/src/modules/chat.ts
git commit -m "fix(viewer): merge server history with localStorage instead of replacing"
```

---

### Task 5: Fix initSession to prefer channel-based server history

The `initSession()` flow checks `lastActiveSession.isAlive` which can fail after server restart, causing unnecessary new session creation.

**Files:**

- Modify: `packages/standalone/public/viewer/src/modules/chat.ts:229-265`

**Step 1: Simplify initSession to always try server session first**

```typescript
async initSession(): Promise<void> {
  await this.checkForResumableSession();

  // Always try to get the last active viewer session from server
  const lastActiveSession = await API.getLastActiveSession().catch(() => null);

  if (lastActiveSession && lastActiveSession.id) {
    // Server has a session — use it regardless of isAlive
    // (server history is the source of truth)
    logger.info('Using server session:', lastActiveSession.id);
    localStorage.setItem('mama_chat_session_id', lastActiveSession.id);
    this.initWebSocket(lastActiveSession.id);
    return;
  }

  // No server session — try localStorage sessionId
  const savedSessionId = localStorage.getItem('mama_chat_session_id');
  if (savedSessionId) {
    logger.info('Trying saved session:', savedSessionId);
    this.initWebSocket(savedSessionId);
    return;
  }

  // No session anywhere — create new
  try {
    this.addSystemMessage('Creating new session...');
    const data = await API.createSession('.');
    const sessionId = data.sessionId;
    logger.info('Created new session:', sessionId);
    localStorage.setItem('mama_chat_session_id', sessionId);
    this.initWebSocket(sessionId);
  } catch (error) {
    logger.error('Failed to create session:', error);
    const message = getErrorMessage(error);
    this.addSystemMessage(`Failed to create session: ${message}`, 'error');
  }
}
```

**Step 2: Build and verify**

Run: `cd packages/standalone && pnpm build`
Expected: Build succeeds

**Step 3: Commit**

```bash
git add packages/standalone/public/viewer/src/modules/chat.ts
git commit -m "fix(viewer): prefer server session regardless of isAlive flag"
```

---

### Task 6: Fix gateway-tools.md — connect mama_save ↔ code_act for agent discoverability

OS agents and multi-agents can't save/search MAMA because the system prompt doesn't explain that gateway tools (mama_save, mama_search, etc.) must be called via `code_act`. The tools appear as separate, unrelated sections.

**Root cause (from OS agent's own analysis):**

1. MAMA Memory section and Code-Act Sandbox section have no cross-reference
2. "Gateway Tool" term is ambiguous — agents assume HTTP API
3. `code_act` description is one line with no mention of mama_save/mama_search

**Files:**

- Modify: `packages/standalone/src/agent/gateway-tools.md`

**Step 1: Already done — gateway-tools.md updated with:**

- Top-level explanation that all tools execute via `code_act`
- Examples showing `code_act({ code: "mama_save({...})" })`
- MAMA Memory section has callout: "NOT direct MCP tools or HTTP APIs"
- Code-Act Sandbox section lists all available gateway tools

**Step 2: Build and verify**

Run: `cd packages/standalone && pnpm build`
Expected: Build succeeds

**Step 3: Commit**

```bash
git add packages/standalone/src/agent/gateway-tools.md
git commit -m "fix(gateway-tools): connect mama_save ↔ code_act in system prompt

OS agents couldn't discover that mama_save/mama_search must be called
via code_act. Added explicit connection, examples, and callouts."
```

---

### Task 7: Integration test and final verification

**Step 1: Run all tests**

Run: `cd packages/standalone && pnpm vitest run tests/gateways/`
Expected: All PASS

**Step 2: Build entire project**

Run: `pnpm build`
Expected: Build succeeds

**Step 3: Manual verification checklist**

- [ ] Start MAMA OS (`mama start`)
- [ ] Open viewer, send a message, get response
- [ ] Refresh page → conversation should appear
- [ ] Send another message mid-stream, refresh → user message should persist
- [ ] Navigate away and back → conversation should be intact
- [ ] Restart MAMA OS → previous conversation should load from DB

**Step 4: Final commit**

```bash
git add -A
git commit -m "fix(viewer): resolve conversation history loss on refresh/navigation

- Save user message immediately before agent loop (not after completion)
- Use channel-based localStorage key instead of sessionId-based
- Merge server history with localStorage instead of replacing
- Increase localStorage history limit from 50 to 200
- Prefer server session regardless of isAlive flag"
```
