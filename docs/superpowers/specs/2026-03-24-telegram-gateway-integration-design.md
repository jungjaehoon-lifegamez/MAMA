# Telegram Gateway Integration — Design Spec

**Issue:** #58
**Date:** 2026-03-24
**Status:** Draft
**Approach:** Port production-proven patterns from internal project into MAMA OS `TelegramGateway`

## Background

`TelegramGateway` class exists in `gateways/telegram.ts` but was never wired into `start.ts`. PR #57 attempted a minimal fix but lacked production-hardening: message dedup, group chat filtering, tool executor wiring, and platform parity with Discord/Slack.

An internal project has a battle-tested Telegram module using the same stack (node-telegram-bot-api + polling). This spec ports those patterns into MAMA OS's existing architecture (BaseGateway, MessageRouter, ToolStatusTracker, GatewayToolExecutor).

## Design

### 1. telegram.ts — Core gateway rewrite

Rewrite `TelegramGateway` to include all production-hardening features while keeping BaseGateway inheritance.

**1a. Message dedup (2-stage)**

```
Stage 1: message_id dedup (60s TTL)
  - Map<string, number> keyed by `${chatId}:${messageId}`
  - Prevents reprocessing on polling reconnect

Stage 2: content signature dedup (5s TTL)
  - Map<string, number> keyed by `${chatId}:${userId}:${text}`
  - Prevents duplicate sends from Telegram client bugs

TTL cleanup runs on each message (iterate + delete expired).
```

**1b. Group chat filtering**

Store `botId` and `botUsername` from `getMe()` at startup. In groups:

- Only respond to `@bot` mentions, `/commands`, or replies to bot
- Strip `@botname` from text before processing
- Requires extending `TelegramMessage` interface: `entities`, `reply_to_message`
- Requires extending `getMe()` return: `{ id: number; username?: string }`

**1c. Sticker handling**

- **Receive:** Convert sticker messages to `[스티커: {emoji}]` text
- **Send:** `sendSticker()` method with emotion-to-emoji mapping + sticker set cache
  - `EMOTION_EMOJI` map (happy, sad, angry, etc. → emoji arrays)
  - `loadStickerSet()` loads default set on first use, caches `emoji → file_id`
  - Falls back to sending emoji as text if no sticker found
- Requires extending `TelegramMessage`: `sticker` field
- Requires extending `TelegramBot`: `sendSticker()`, `getStickerSet()`

**1d. Typing indicator**

From PR #57: `sendChatAction('typing')` every 4s during processing, cleared in `finally`.

**1e. Polling hardening**

- IPv4 forced: `request: { family: 4 }` to avoid IPv6 DNS failures
- `polling_error` handler: log errors, track `lastError` for health check
- Configurable polling interval via constructor option

**1f. ToolStatusTracker integration (streaming)**

Implement `PlatformAdapter` for Telegram:

```ts
class TelegramPlatformAdapter implements PlatformAdapter {
  postPlaceholder(content) → bot.sendMessage(chatId, content) → return messageId
  editPlaceholder(handle, content) → bot.editMessageText(content, { chat_id, message_id })
  deletePlaceholder(handle) → bot.editMessageText(finalResponse, ...) // don't delete, replace
}
```

Use `ToolStatusTracker` with Telegram-appropriate timing:

- `throttleMs: 2000` (between Discord 3s and Slack 1.5s)
- `initialDelayMs: 1000` (Telegram is faster than Discord/Slack UX)

Pass `tracker.toStreamCallbacks()` to `messageRouter.process({ onStream })`.

**Difference from Discord/Slack:** On cleanup, edit placeholder to final response instead of deleting. Telegram users expect the placeholder to become the answer (like mama-suite's pattern).

**1g. Health check enhancement**

Add `lastError` tracking from polling_error events. Return in health check:

```ts
healthCheck(): { status: 'ok'|'degraded'|'down', details, lastMessageAt?, lastError? }
```

### 2. start.ts — Initialization block

Follow Discord/Slack pattern exactly:

```ts
// Initialize Telegram gateway if enabled
if (config.telegram?.enabled && config.telegram?.token) {
  telegramGateway = new TelegramGateway({ token, messageRouter, config });
  await telegramGateway.start();
  gateways.push(telegramGateway);

  // Wire tool executor
  const telegramInterface = {
    sendMessage,
    sendFile,
    sendImage,
    sendSticker,
  };
  toolExecutor.setTelegramGateway(telegramInterface);

  // Wire health check
  healthCheckService.addGateway('telegram', telegramGateway);
}
```

**Security alert targets:** Add `target.gateway === 'telegram'` case to filter.

**CronResultRouter:** Add `telegram: telegramGateway` to gateways object.

### 3. gateway-tool-executor.ts — telegram_send tool

Follow `discord_send`/`slack_send` pattern:

```ts
setTelegramGateway(gateway: TelegramGatewayInterface): void
executeTelegramSend(input: { chat_id, message?, file_path? }): Promise<Result>

// In execute() switch:
case 'telegram_send': return this.executeTelegramSend(input);
```

Interface:

```ts
interface TelegramGatewayInterface {
  sendMessage(chatId: string, text: string): Promise<void>;
  sendFile(chatId: string, filePath: string, caption?: string): Promise<void>;
  sendImage(chatId: string, imagePath: string, caption?: string): Promise<void>;
  sendSticker(chatId: string | number, emotion: string): Promise<boolean>;
}
```

### 4. Supporting file changes

| File                            | Change                                             |
| ------------------------------- | -------------------------------------------------- |
| `gateways/index.ts`             | Export `TelegramGateway`, `TelegramGatewayOptions` |
| `agent/gateway-tools.md`        | Add `telegram_send` tool definition                |
| `agent/types.ts`                | Add `'telegram_send'` to `GatewayToolName` union   |
| `agent/tool-registry.ts`        | Register `telegram_send` tool                      |
| `agent/code-act/constants.ts`   | Add `telegram_send` to communication tools list    |
| `agent/code-act/host-bridge.ts` | Add `telegram_send` bridge definition              |

## What is NOT ported

| Feature                                                            | Reason                                                                                                                |
| ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| Streaming delta response (`editMessageText` with accumulated text) | MAMA OS uses ToolStatusTracker pattern (tool progress), not raw text streaming. MessageRouter returns final response. |
| Serial queue (`enqueueStream`)                                     | SessionPool already handles per-channel session locking                                                               |
| Direct `agentLoop.runWithContent()` bypass                         | Must go through MessageRouter for security checks, session management, context injection                              |

## File change summary

| File                             | Type    | Scope                                 |
| -------------------------------- | ------- | ------------------------------------- |
| `gateways/telegram.ts`           | Rewrite | Major — all production features       |
| `cli/commands/start.ts`          | Edit    | Add init block + security/cron wiring |
| `agent/gateway-tool-executor.ts` | Edit    | Add telegram_send + interface         |
| `gateways/index.ts`              | Edit    | Add exports                           |
| `agent/gateway-tools.md`         | Edit    | Add tool docs                         |
| `agent/types.ts`                 | Edit    | Add type                              |
| `agent/tool-registry.ts`         | Edit    | Register tool                         |
| `agent/code-act/constants.ts`    | Edit    | Add to list                           |
| `agent/code-act/host-bridge.ts`  | Edit    | Add bridge                            |

## Testing strategy

- Unit tests for dedup logic (message_id + content signature)
- Unit tests for group filtering (mention/command/reply detection)
- Unit tests for sticker conversion
- Integration test: TelegramGateway init → mock bot → message processing
- Verify `telegram_send` tool execution via GatewayToolExecutor
