# STANDALONE PACKAGE KNOWLEDGE BASE

**Package:** @jungjaehoon/mama-os v0.4.0  
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
| **Modify web UI**            | `../../public/viewer/`        | MAMA OS dashboard (outside src/)                  |
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
const DISCORD_TOKEN = 'MTQ2OTAyNTkxMTg2MDEwMTMzMg.xxx.yyy';

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

// ❌ FORBIDDEN: Skip permission prompts in production
dangerouslySkipPermissions: true // Security risk

// ✅ REQUIRED: Only enable in trusted environments
dangerouslySkipPermissions: process.env.MAMA_TRUSTED_ENV === 'true'

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

# ⚠️ FORBIDDEN: Use dangerouslySkipPermissions in production
# Only enable in trusted environments (testing, sandboxed VMs)

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
         🏔️ Sisyphus      🔧 Developer     📝 Reviewer
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

### **UltraWork Mode (Autonomous Sessions)**

```text
Trigger: "Build the auth system ultrawork"
→ Lead agent analyzes task
→ Delegates to specialized agents
→ Collects results, continues until done
→ Safety: max steps (20) + max duration (30 min)
```

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

---

## RELATED DOCS

- [Standalone README](../README.md) — User-facing documentation
- [Multi-Agent Architecture](../../../docs/architecture-mama-swarm-2026-02-06.md) — Swarm design
- [Security Guide](../../../docs/guides/security.md) — CRITICAL security warnings
- [Root AGENTS.md](../../../AGENTS.md) — Monorepo-wide conventions

---

**Node.js:** >= 22.0.0 (native TypeScript support)  
**pnpm:** >= 8.0.0  
**License:** MIT  
**Author:** SpineLift Team
