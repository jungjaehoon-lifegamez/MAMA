# STANDALONE PACKAGE KNOWLEDGE BASE

**Package:** @jungjaehoon/mama-os  
**Language:** TypeScript (compiles to dist/)  
**Purpose:** Always-on AI agent with gateway integrations, multi-agent swarm, and autonomous capabilities

---

## OVERVIEW

MAMA OS — Standalone AI agent powered by Claude CLI subprocess (ToS-compliant). Runs continuously with Discord/Slack/Telegram bots, multi-agent swarm orchestration, autonomous UltraWork sessions, and web-based management UI.

---

## WHERE TO LOOK

| Task                         | Location                      | Notes                                             |
| ---------------------------- | ----------------------------- | ------------------------------------------------- |
| **Add CLI command**          | `cli/commands/*.ts`           | init, start, stop, status, run, setup             |
| **Modify agent loop**        | `agent/agent-loop.ts`         | Main conversation handler (Claude CLI subprocess) |
| **Add gateway integration**  | `gateways/*.ts`               | Discord, Slack, Telegram handlers                 |
| **Modify multi-agent swarm** | `multi-agent/orchestrator.ts` | 5-stage routing, tier-based access, delegation    |
| **Add skill**                | `skills/*.ts`                 | Pluggable capabilities (image translation, docs)  |
| **Modify onboarding wizard** | `onboarding/*.ts`             | 9-phase autonomous setup (ritual-based)           |
| **Add cron job handler**     | `scheduler/*.ts`              | Heartbeat, token keep-alive, job locking          |
| **Modify web UI**            | `../public/viewer/`           | MAMA OS dashboard (outside src/)                  |
| **Add MCP tool executor**    | `agent/mcp-executor.ts`       | Tool execution via Claude CLI --mcp-config        |
| **Modify session pool**      | `agent/session-pool.ts`       | Persistent CLI process management                 |
| **Add auth provider**        | `auth/oauth-manager.ts`       | OAuth token management (Claude CLI)               |
| **Modify concurrency**       | `concurrency/lane-manager.ts` | Per-session concurrency control                   |
| **Add API endpoint**         | `api/*.ts`                    | Heartbeat, cron, error handlers                   |
| **Modify memory logger**     | `memory/memory-logger.ts`     | Decision/checkpoint logging                       |
| **Add runner**               | `runners/*.ts`                | CLI runner for single-prompt execution            |
| **Modify setup wizard**      | `setup/*.ts`                  | WebSocket, server, tools, prompts                 |
| **Add utility**              | `utils/*.ts`                  | Log sanitizer, Slack validators, rate limiters    |

---

## CONVENTIONS

### **TypeScript-Specific**

- **Strict mode:** Enabled (`strict: true` in tsconfig.json)
- **No `any` type:** Use explicit types or `unknown`
- **Imports:** Use `.js` extension in imports (TypeScript ESM requirement)
- **Exports:** Named exports preferred over default exports
- **Async/await:** Required for all async operations (no raw Promises)

### **Multi-Agent Architecture**

**Wave-Based Orchestration (5 Stages):**

```text
Message → 1. Free Chat → 2. Explicit Trigger → 3. Category Match → 4. Keyword Match → 5. Default Agent
```

**Tier System (Automatic, Not User-Selected):**

- **Tier 1:** Full tools + delegation (Orchestrator role)
- **Tier 2:** Read-only tools (Advisor role)
- **Tier 3:** Read-only tools, scoped execution (Executor role)

**Delegation Format:**

```text
DELEGATE::{agent_id}::{task description}
```

**Discord Mention Requirements (Delegation Trigger):**

- Delegation only works if the bot processes the message.
- If Discord `requireMention: true` is configured at the guild/channel level, normal messages without an @mention are ignored.
- Delegation commands are treated as explicit triggers: if a line starts with `DELEGATE::` / `DELEGATE_BG::`, it will still be processed (even without an @mention).
- Including the bot mention is still OK and makes intent obvious:

```text
<@BOT_ID> DELEGATE::critic::WebMCP 문서 검증
```

- Recommended: use a dedicated swarm/bot channel with `requireMention: false` so delegation can run without @mentions, and keep `requireMention: true` in public channels to avoid spam.
- `agent_id` is **case-sensitive** and must match `multi_agent.agents` keys (e.g. `developer`, `reviewer`, `pm`).

**Task Continuation Markers:**

- **Complete:** `DONE`, `완료`, `TASK_COMPLETE`, `finished`
- **Incomplete:** "I'll continue", "계속하겠", truncation near 2000 chars

### **Claude CLI Subprocess (ToS Compliance)**

```typescript
// ✅ REQUIRED: Spawn Claude CLI as subprocess
const child = spawn('claude', [...args]);

// ❌ FORBIDDEN: Direct API calls with OAuth token
// Violates ToS, risks account ban
```

**Why subprocess approach:**

- ToS-compliant (official Anthropic tool)
- Keeps $200/month subscription pricing (vs $1000+/month API)
- Real usage tracking (cost, tokens)
- No OAuth token extraction (gray area)

### **Configuration Format**

- **YAML:** `config.yaml` (standalone-specific)
- **JSON:** Inherited from root (pnpm workspace)
- **Environment variables:** `MAMA_DB_PATH`, `MAMA_HTTP_PORT`, `MAMA_WORKSPACE`

### **Entry Point**

- **Source:** `src/index.ts`
- **Compiled:** `dist/index.js`
- **CLI binary:** `dist/cli/index.js` (shebang: `#!/usr/bin/env node`)

---

## ANTI-PATTERNS (STANDALONE-SPECIFIC)

### **FORBIDDEN (CRITICAL)**

```typescript
// ❌ FORBIDDEN: Direct API calls with OAuth token
const response = await fetch('https://api.anthropic.com/v1/messages', {
  headers: { 'Authorization': `Bearer ${token}` }
});

// ✅ REQUIRED: Spawn Claude CLI subprocess
const child = spawn('claude', ['--output-format', 'json', prompt]);

// ❌ FORBIDDEN: Hardcode gateway tokens
const DISCORD_TOKEN = 'YOUR_DISCORD_BOT_TOKEN';

// ✅ REQUIRED: Load from config.yaml
const token = config.gateways.discord.token;

// ❌ FORBIDDEN: Infinite delegation chains
DELEGATE::developer::DELEGATE::reviewer::DELEGATE::pm::...

// ✅ REQUIRED: Maximum delegation depth = 1
if (delegationDepth >= 1) throw new Error('Max delegation depth reached');

// ❌ FORBIDDEN: Expose MAMA OS without authentication
app.listen(3847, '0.0.0.0'); // Public internet access

// ✅ REQUIRED: Localhost only (use Cloudflare tunnel for external access)
app.listen(3847, '127.0.0.1');

// ✅ MAMA OS is a headless daemon (no TTY) — dangerouslySkipPermissions is REQUIRED.
// Security is enforced by MAMA's own RoleManager (config.yaml roles), not Claude CLI prompts.
dangerouslySkipPermissions: config.multi_agent?.dangerouslySkipPermissions ?? true

// ❌ FORBIDDEN: Modify multi-agent config without testing loop prevention
max_chain_length: 100 // Infinite loops

// ✅ REQUIRED: Test with low limits first
max_chain_length: 10 // Safe default
```

### **Security Warnings**

```bash
# ⚠️ CRITICAL: MAMA OS has full system access via Claude CLI
# Run in Docker container or isolated environment

# ⛔ FORBIDDEN: Expose MAMA OS to public internet without auth
# Use Cloudflare Zero Trust tunnel with authentication

# NOTE: dangerouslySkipPermissions=true is REQUIRED for MAMA OS (headless daemon, no TTY).
# MAMA enforces permissions via its own RoleManager (config.yaml roles), not Claude CLI prompts.

# ⚠️ FORBIDDEN: Share gateway tokens in git
# Use environment variables or secure vaults
```

---

## UNIQUE STYLES

### **Subprocess-Based Claude CLI (ToS Compliance)**

```typescript
// Spawns Claude CLI as subprocess (not direct API calls)
const child = spawn('claude', [
  '--output-format',
  'json',
  '--session-id',
  sessionId,
  '--mcp-config',
  mcpConfigPath,
  prompt,
]);

// INTENTIONAL: Avoids OAuth token extraction (ToS gray area)
```

### **Multi-Agent Swarm (Chat Platform Focus)**

```text
User message → Orchestrator → 5-Stage Routing
                                │
                ┌───────────────┼───────────────┐
                ▼               ▼               ▼
         🎯 Conductor      🔧 Developer     📝 Reviewer
          (Tier 1)          (Tier 2)         (Tier 3)
        Full tools        Read-only         Read-only
        Can delegate      Implements        Reviews
                │
                └── DELEGATE::developer::Fix the auth bug
```

**Key difference from oh-my-opencode:** Built for **chat platforms** (Discord, Slack, Telegram) with multiple bot accounts collaborating in real-time channels, not local CLI environment.

### **Onboarding Wizard (Ritual-Based)**

```text
9-Phase Autonomous Setup:
1. The Awakening ✨
2. Getting to Know You 💬
3. Personality Quest 🎮
4. The Naming Ceremony 🏷️
5. Checkpoint ✅
6. Security Talk 🔒
7. The Connections 🔌
8. The Demo 🎪
9. Grand Finale 🎉
```

Each phase uses Claude CLI to guide users through setup with natural conversation.

### **UltraWork Mode (Ralph Loop 3-Phase)**

```text
Trigger: "Build the auth system ultrawork"

Phase 1: Planning
  → Lead agent creates plan (+ optional Council review)
  → Persisted: plan.md

Phase 2: Building
  → Delegates tasks from plan via DELEGATE::
  → Each step recorded to progress.json
  → Council escalation on failure

Phase 3: Retrospective
  → Reviews work against plan (+ Council quality check)
  → RETRO_COMPLETE → done | RETRO_INCOMPLETE → Phase 2 retry
```

**Config:** `phased_loop: true` (default), `persist_state: true` (default)
**State dir:** `~/.mama/workspace/ultrawork/{session_id}/`
**Trigger keywords:** `ultrawork`, `울트라워크`, `deep work`, `autonomous`, `자율 작업`

---

## NOTES

### **Gotchas**

1. **Claude CLI Required:** Standalone won't work without `claude` binary installed and authenticated.

2. **Gateway Token Conflicts:** If multiple agents share the same bot token, Discord will disconnect one. Use dedicated tokens per agent.

3. **Delegation Depth Limit:** Maximum depth = 1 (no re-delegation). Prevents infinite loops.

4. **Task Continuation Retries:** Default max retries = 3. Increase cautiously (can cause spam).

5. **UltraWork Safety Limits:** Max steps = 20, max duration = 30 min. Prevents runaway sessions.

6. **MAMA OS Port Conflicts:** Default port 3847. Change in `config.yaml` if already in use.

7. **Heartbeat Quiet Hours:** Pauses during configured hours (default: 11 PM - 8 AM). Adjust for your timezone.

8. **Skill Forge Countdown:** 5-second review window per step. Can't be skipped (intentional safety).

9. **Persona File Paths:** Use absolute paths or `~/.mama/personas/`. Relative paths may fail.

10. **Multi-Agent Free Chat:** When `free_chat: true`, all agents respond to every message. Use with caution (can cause spam).

11. **AI 동작 안정화 규칙 (운영 반영):**

- `수정` 요청 시, `수정 → (요청된 범위 빌드/테스트/실행)` 순으로 처리한다.
- 변경 결과를 추상적으로 요약하기 전에 먼저 파일 변경 근거(경로)와 실행 명령/결과를 제시한다.
- “완료”는 요청한 검증 항목이 실제 통과했을 때만 선언한다.

11. **파서/실행 파이프라인 수정 반영 (2026-02-19):**

- `src/multi-agent/workflow-engine.ts`에서 `workflow_plan` 파서를 CRLF/raw JSON/```json 블록에 대해 강건하게 개선.
- 기본 스텝 타임아웃을 10분으로 상향.
- `src/api/graph-api.ts`의 결정 저장은 `mama.save(...)` 사용.
- `tests/multi-agent/workflow-engine.test.ts`로 파서 회귀 케이스를 보강.

---

## RELATED DOCS

- [Standalone README](../README.md) — User-facing documentation
- [Multi-Agent Architecture](../../../docs/architecture-mama-swarm-2026-02-06.md) — Swarm design
- [Security Guide](../../../docs/guides/security.md) — CRITICAL security warnings
- [Root AGENTS.md](../../../AGENTS.md) — Monorepo-wide conventions

---

**Node.js:** >= 22.13.0 (native TypeScript support and unflagged `node:sqlite`)  
**pnpm:** >= 8.0.0  
**License:** MIT  
**Author:** SpineLift Team
