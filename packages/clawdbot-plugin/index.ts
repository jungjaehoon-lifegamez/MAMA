/**
 * MAMA Clawdbot Plugin - Direct Gateway Integration
 *
 * NO HTTP/REST - MAMA 로직을 Gateway에 직접 임베드
 * better-sqlite3 + sqlite-vec로 벡터 검색
 *
 * Features:
 * - 4 native tools: mama_search, mama_save, mama_load_checkpoint, mama_update
 * - Auto-recall: 에이전트 시작 시 유저 프롬프트 기반 시맨틱 검색
 * - Auto-capture: 에이전트 종료 시 중요 결정 자동 저장
 */

import { Type, type Static } from "@sinclair/typebox";
import type { ClawdbotPluginApi } from "clawdbot/plugin-sdk";
import path from "node:path";
import os from "node:os";

// MAMA 모듈 경로 - workspace dependency에서 resolve
const MAMA_MODULE_PATH = path.dirname(require.resolve("@jungjaehoon/mama-server/src/mama/mama-api.js"));

// MAMA API interface for type safety (matching actual mama-api.js implementation)
interface MAMAApi {
  suggest(query: string, options: { limit: number; threshold: number }): Promise<MAMASuggestResult | null>;
  save(params: { topic: string; decision: string; reasoning: string; confidence: number; type: string }): Promise<MAMASaveResult>;
  saveCheckpoint(summary: string, files: string[], nextSteps: string): Promise<number>;
  loadCheckpoint(): Promise<MAMACheckpoint | null>;
  list(options: { limit: number }): Promise<MAMADecision[]>;
  updateOutcome(id: string, options: { outcome: string; failure_reason?: string; limitation?: string }): Promise<void>;
}

interface MAMASaveResult {
  success: boolean;
  id: string;
  similar_decisions?: MAMADecision[];
  warning?: string;
  collaboration_hint?: string;
  reasoning_graph?: unknown;
}

interface MAMASuggestResult {
  query: string;
  results: MAMADecision[];
}

interface MAMADecision {
  id: string;
  topic: string;
  decision: string;
  reasoning: string;
  confidence?: number;
  outcome?: string;
  similarity?: number;
  created_at?: string;
  recency_score?: number;
  recency_age_days?: number;
  final_score?: number;
}

interface MAMACheckpoint {
  id: number;
  summary: string;
  next_steps?: string;
  timestamp: string;
}

// Plugin config schema
const pluginConfigSchema = Type.Object({
  dbPath: Type.Optional(Type.String({
    description: "Path to MAMA SQLite database. Defaults to ~/.claude/mama-memory.db"
  }))
});

// Derive PluginConfig from schema for type safety
type PluginConfig = Static<typeof pluginConfigSchema>;

// Singleton state
let initialized = false;
let mama: MAMAApi | null = null;
let initialDbPath: string | null = null;

/**
 * Get MAMA API with null guard
 * @throws Error if MAMA is not initialized
 */
function getMAMA(): MAMAApi {
  if (!mama) {
    throw new Error('MAMA not initialized. Call initMAMA() first.');
  }
  return mama;
}

/**
 * Format reasoning with link extraction
 * Shows truncated reasoning + preserves builds_on/debates/synthesizes links
 */
function formatReasoning(reasoning: string, maxLen: number = 80): string {
  if (!reasoning) return "";

  // Extract link patterns
  const linkMatch = reasoning.match(/(builds_on|debates|synthesizes):\s*[\w\[\],\s_-]+/i);

  // Truncate main reasoning
  const truncated = reasoning.length > maxLen
    ? reasoning.substring(0, maxLen) + "..."
    : reasoning;

  // Add link info if found and not already in truncated part
  if (linkMatch && !truncated.includes(linkMatch[0])) {
    return `${truncated}\n  🔗 ${linkMatch[0]}`;
  }

  return truncated;
}

/**
 * Initialize MAMA (lazy, once)
 */
async function initMAMA(config?: PluginConfig): Promise<void> {
  // Set DB path from config or environment or default
  const dbPath = config?.dbPath ||
    process.env.MAMA_DB_PATH ||
    path.join(os.homedir(), ".claude/mama-memory.db");

  // Warn if re-initialized with different config
  if (initialized) {
    if (initialDbPath && dbPath !== initialDbPath) {
      console.warn(`[MAMA Plugin] Warning: initMAMA called with different dbPath (${dbPath}) after initialization with (${initialDbPath}). Using original path.`);
    }
    return;
  }

  process.env.MAMA_DB_PATH = dbPath;

  try {
    // Load mama-api (high-level API)
    mama = require(path.join(MAMA_MODULE_PATH, "mama-api.js"));

    // Initialize database via memory-store
    const memoryStore = require(path.join(MAMA_MODULE_PATH, "memory-store.js"));
    await memoryStore.initDB();

    initialized = true;
    initialDbPath = dbPath;
    console.log(`[MAMA Plugin] Initialized with direct module integration (db: ${dbPath})`);
  } catch (err: any) {
    console.error("[MAMA Plugin] Init failed:", err.message);
    throw err;
  }
}

const mamaPlugin = {
  id: "clawdbot-mama",
  name: "MAMA Memory",
  description: "Semantic decision memory - Direct Gateway integration (no HTTP)",
  kind: "memory" as const,
  configSchema: pluginConfigSchema,

  register(api: ClawdbotPluginApi) {
    // Get plugin config (config property may be available depending on SDK version)
    const config: PluginConfig | undefined = 'config' in api
      ? (api as { config?: PluginConfig }).config
      : undefined;

    // =====================================================
    // Auto-recall: 유저 프롬프트 기반 시맨틱 검색
    // =====================================================
    api.on("before_agent_start", async (event: any) => {
      try {
        await initMAMA(config);

        const userPrompt = event.prompt || "";

        const mamaApi = getMAMA();

        // 1. 유저 프롬프트가 있으면 시맨틱 검색 수행
        let semanticResults: MAMADecision[] = [];
        if (userPrompt && userPrompt.length >= 5) {
          try {
            const searchResult = await mamaApi.suggest(userPrompt, { limit: 3, threshold: 0.5 });
            semanticResults = searchResult?.results || [];
          } catch (searchErr: any) {
            console.error("[MAMA] Semantic search error:", searchErr.message);
          }
        }

        // 2. 최근 체크포인트 로드
        const checkpoint = await mamaApi.loadCheckpoint();

        // 3. 최근 결정들 로드 (시맨틱 검색 결과가 없을 때만)
        let recentDecisions: MAMADecision[] = [];
        if (semanticResults.length === 0) {
          recentDecisions = await mamaApi.list({ limit: 3 });
        }

        // 4. 컨텍스트가 있으면 주입
        if (checkpoint || semanticResults.length > 0 || recentDecisions.length > 0) {
          let content = "<relevant-memories>\n";
          content += "# MAMA Memory Context\n\n";

          if (semanticResults.length > 0) {
            content += "## Relevant Decisions (semantic match)\n\n";
            semanticResults.forEach((r: any) => {
              const pct = Math.round((r.similarity || 0) * 100);
              content += `- **${r.topic}** [${pct}%]: ${r.decision}`;
              if (r.outcome) content += ` (${r.outcome})`;
              content += `\n  _${formatReasoning(r.reasoning, 100)}_\n`;
              content += `  ID: \`${r.id}\`\n`;
            });
            content += "\n";
          }

          if (checkpoint) {
            content += `## Last Checkpoint (${new Date(checkpoint.timestamp).toISOString()})\n\n`;
            content += `**Summary:** ${checkpoint.summary}\n\n`;
            if (checkpoint.next_steps) {
              content += `**Next Steps:** ${checkpoint.next_steps}\n\n`;
            }
          }

          if (recentDecisions.length > 0) {
            content += "## Recent Decisions\n\n";
            recentDecisions.forEach((d: any) => {
              content += `- **${d.topic}**: ${d.decision}`;
              if (d.outcome) content += ` (${d.outcome})`;
              content += "\n";
            });
            content += "\n";
          }

          content += "</relevant-memories>";

          console.log(`[MAMA] Auto-recall: ${semanticResults.length} semantic matches, ${recentDecisions.length} recent, checkpoint: ${!!checkpoint}`);

          return {
            prependContext: content,
          };
        }
      } catch (err: any) {
        console.error("[MAMA] Auto-recall error:", err.message);
      }
    });

    // =====================================================
    // Auto-capture: 에이전트 종료 시 결정 자동 저장
    // =====================================================
    api.on("agent_end", async (event: any) => {
      if (!event.success || !event.messages || event.messages.length === 0) {
        return;
      }

      try {
        await initMAMA(config);

        // 메시지에서 텍스트 추출
        const texts: string[] = [];
        for (const msg of event.messages) {
          if (!msg || typeof msg !== "object") continue;

          const role = msg.role;
          if (role !== "user" && role !== "assistant") continue;

          const content = msg.content;
          if (typeof content === "string") {
            texts.push(content);
          } else if (Array.isArray(content)) {
            for (const block of content) {
              if (block?.type === "text" && typeof block.text === "string") {
                texts.push(block.text);
              }
            }
          }
        }

        // 결정 패턴 감지
        const decisionPatterns = [
          /decided|결정|선택|chose|use.*instead|going with/i,
          /will use|사용할|approach|방식|strategy/i,
          /remember|기억|learned|배웠|lesson/i,
        ];

        for (const text of texts) {
          // Skip short or injected content
          if (text.length < 20 || text.length > 500) continue;
          if (text.includes("<relevant-memories>")) continue;
          if (text.startsWith("<") && text.includes("</")) continue;

          // Check if it matches decision patterns
          const isDecision = decisionPatterns.some(p => p.test(text));
          if (!isDecision) continue;

          // Auto-save detected decision (logged only, not actually saved without explicit topic)
          console.log(`[MAMA] Auto-capture candidate: ${text.substring(0, 50)}...`);
          // Note: 실제 저장은 명시적 topic이 필요하므로 로그만 남김
          // 향후 LLM을 통한 topic 추출 기능 추가 가능
        }
      } catch (err: any) {
        console.error("[MAMA] Auto-capture error:", err.message);
      }
    });

    // =====================================================
    // mama_search - 시맨틱 메모리 검색
    // =====================================================
    api.registerTool({
      name: "mama_search",
      description: `Search semantic memory for relevant past decisions.

⚠️ **TRIGGERS - Call this BEFORE:**
• Making architectural choices (check prior art)
• Calling mama_save (find links first!)
• Debugging (find past failures on similar issues)
• Starting work on a topic (load context)

**Returns:** Decisions ranked by semantic similarity with:
- Topic, decision, reasoning
- Similarity score (0-100%)
- Decision ID (for linking/updating)

**High similarity (>80%) = MUST link with builds_on/debates/synthesizes**

**Example queries:** "authentication", "database choice", "error handling"`,

      parameters: Type.Object({
        query: Type.String({
          description: "Search query - topic, question, or keywords"
        }),
        limit: Type.Optional(Type.Number({
          description: "Max results (default: 5)"
        })),
      }),

      async execute(_id: string, params: Record<string, unknown>) {
        try {
          await initMAMA(config);

          const query = String(params.query || "").trim();
          if (!query) {
            return { content: [{ type: "text", text: "Error: query required" }] };
          }

          const limit = Math.min(Number(params.limit) || 5, 20);

          // Use mama.suggest() for semantic search
          const result = await getMAMA().suggest(query, { limit, threshold: 0.5 });

          if (!result?.results?.length) {
            return {
              content: [{ type: "text", text: `No decisions found for "${query}". This may be a new topic.` }]
            };
          }

          // Format output
          let output = `Found ${result.results.length} related decisions:\n\n`;
          result.results.forEach((r: any, idx: number) => {
            const pct = Math.round((r.similarity || 0) * 100);
            output += `**${idx + 1}. ${r.topic}** [${pct}% match]\n`;
            output += `   Decision: ${r.decision}\n`;
            output += `   Reasoning: ${formatReasoning(r.reasoning, 150)}\n`;
            output += `   ID: \`${r.id}\` | Outcome: ${r.outcome || "pending"}\n\n`;
          });

          return { content: [{ type: "text", text: output }] };
        } catch (err: any) {
          return { content: [{ type: "text", text: `MAMA error: ${err.message}` }] };
        }
      },
    });

    // =====================================================
    // mama_save - 결정 또는 체크포인트 저장
    // =====================================================
    api.registerTool({
      name: "mama_save",
      description: `Save a decision or checkpoint to semantic memory.

⚠️ **REQUIRED WORKFLOW (Don't create orphans!):**
1. Call mama_search FIRST to find related decisions
2. Check if same topic exists (yours will supersede it)
3. MUST include link in reasoning/summary field

**DECISION - Use when:**
- Making architectural choices
- Learning a lesson (success or failure)
- Establishing a pattern/convention
- Choosing between alternatives

**CHECKPOINT - Use when:**
- Ending a session (save state)
- Reaching a milestone
- Before switching tasks

**Link decisions:** End reasoning with 'builds_on: <id>' or 'debates: <id>' or 'synthesizes: [id1, id2]'`,

      parameters: Type.Object({
        type: Type.Union([
          Type.Literal("decision"),
          Type.Literal("checkpoint"),
        ], { description: "'decision' or 'checkpoint'" }),

        topic: Type.Optional(Type.String({
          description: "[Decision] Topic ID e.g. 'auth_strategy'"
        })),
        decision: Type.Optional(Type.String({
          description: "[Decision] The decision e.g. 'Use JWT with refresh tokens'"
        })),
        reasoning: Type.Optional(Type.String({
          description: "[Decision] Why. End with 'builds_on: <id>' to link."
        })),
        confidence: Type.Optional(Type.Number({
          description: "[Decision] 0.0-1.0 (default: 0.8)"
        })),

        summary: Type.Optional(Type.String({
          description: "[Checkpoint] What was accomplished"
        })),
        next_steps: Type.Optional(Type.String({
          description: "[Checkpoint] What to do next"
        })),
      }),

      async execute(_id: string, params: Record<string, unknown>) {
        try {
          await initMAMA(config);

          const saveType = String(params.type);

          if (saveType === "checkpoint") {
            const summary = String(params.summary || "");
            if (!summary) {
              return { content: [{ type: "text", text: "Error: summary required for checkpoint" }] };
            }

            // mama.saveCheckpoint returns lastInsertRowid directly (not {id: ...})
            const checkpointId = await getMAMA().saveCheckpoint(
              summary,
              [],
              String(params.next_steps || "")
            );

            return {
              content: [{ type: "text", text: `Checkpoint saved (id: ${checkpointId})` }]
            };
          }

          // Decision - use mama.save()
          const topic = String(params.topic || "");
          const decision = String(params.decision || "");
          const reasoning = String(params.reasoning || "");

          if (!topic || !decision || !reasoning) {
            return {
              content: [{ type: "text", text: "Error: topic, decision, and reasoning all required" }]
            };
          }

          const confidence = Number(params.confidence) || 0.8;

          // Use mama.save() API
          const result = await getMAMA().save({
            topic,
            decision,
            reasoning,
            confidence,
            type: "assistant_insight",
          });

          // result contains: { id, similar_decisions, warning, collaboration_hint }
          let msg = `Decision saved (id: ${result.id})`;
          if (result.warning) {
            msg += `\n⚠️ ${result.warning}`;
          }
          if (result.collaboration_hint) {
            msg += `\n💡 ${result.collaboration_hint}`;
          }

          return { content: [{ type: "text", text: msg }] };
        } catch (err: any) {
          return { content: [{ type: "text", text: `MAMA error: ${err.message}` }] };
        }
      },
    });

    // =====================================================
    // mama_load_checkpoint - 체크포인트 로드
    // =====================================================
    api.registerTool({
      name: "mama_load_checkpoint",
      description: `Load latest checkpoint to resume previous session.

**Use at session start to:**
- Restore previous context
- See where you left off
- Get planned next steps

Also returns recent decisions for context.`,

      parameters: Type.Object({}),

      async execute(_id: string, _params: Record<string, unknown>) {
        try {
          await initMAMA(config);

          // Use mama.loadCheckpoint() and mama.list()
          const checkpoint = await getMAMA().loadCheckpoint();
          // list() returns MAMADecision[] directly
          const recent = await getMAMA().list({ limit: 5 });

          if (!checkpoint) {
            let msg = "No checkpoint found - fresh start.";
            if (recent?.length) {
              msg += "\n\nRecent decisions:\n";
              recent.forEach((d: any) => {
                msg += `- ${d.topic}: ${d.decision}\n`;
              });
            }
            return { content: [{ type: "text", text: msg }] };
          }

          let msg = `**Checkpoint** (${new Date(checkpoint.timestamp).toISOString()})\n\n`;
          msg += `**Summary:**\n${checkpoint.summary}\n\n`;

          if (checkpoint.next_steps) {
            msg += `**Next Steps:**\n${checkpoint.next_steps}\n\n`;
          }

          if (recent?.length) {
            msg += `**Recent Decisions:**\n`;
            recent.forEach((d: any) => {
              msg += `- **${d.topic}**: ${d.decision} (${d.outcome || "pending"})\n`;
            });
          }

          return { content: [{ type: "text", text: msg }] };
        } catch (err: any) {
          return { content: [{ type: "text", text: `MAMA error: ${err.message}` }] };
        }
      },
    });

    // =====================================================
    // mama_update - 결과 업데이트
    // =====================================================
    api.registerTool({
      name: "mama_update",
      description: `Update outcome of a previous decision.

**Use when you learn if a decision worked:**
- SUCCESS: Worked well
- FAILED: Didn't work (include reason)
- PARTIAL: Partially worked

Helps future sessions learn from experience.`,

      parameters: Type.Object({
        id: Type.String({ description: "Decision ID to update" }),
        outcome: Type.Union([
          Type.Literal("success"),
          Type.Literal("failed"),
          Type.Literal("partial"),
        ]),
        reason: Type.Optional(Type.String({
          description: "Why it succeeded/failed/partial"
        })),
      }),

      async execute(_id: string, params: Record<string, unknown>) {
        try {
          await initMAMA(config);

          const decisionId = String(params.id || "");
          const outcome = String(params.outcome || "").toUpperCase();
          const reason = String(params.reason || "");

          if (!decisionId || !outcome) {
            return { content: [{ type: "text", text: "Error: id and outcome required" }] };
          }

          // mama.updateOutcome(id, { outcome, failure_reason, limitation })
          await getMAMA().updateOutcome(decisionId, {
            outcome,
            failure_reason: outcome === "FAILED" ? reason : undefined,
            limitation: outcome === "PARTIAL" ? reason : undefined,
          });

          return {
            content: [{ type: "text", text: `Decision ${decisionId} updated to ${outcome}` }]
          };
        } catch (err: any) {
          return { content: [{ type: "text", text: `MAMA error: ${err.message}` }] };
        }
      },
    });

  },
};

export default mamaPlugin;
