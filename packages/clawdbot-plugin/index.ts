/**
 * MAMA Clawdbot Plugin - Direct Gateway Integration
 *
 * NO HTTP/REST - MAMA 로직을 Gateway에 직접 임베드
 * better-sqlite3 + sqlite-vec로 벡터 검색
 */

import { Type } from "@sinclair/typebox";
import type { ClawdbotPluginApi } from "clawdbot/plugin-sdk";
import { emptyPluginConfigSchema } from "clawdbot/plugin-sdk";
import path from "node:path";
import os from "node:os";

// MAMA 모듈 경로 - workspace dependency에서 resolve
const MAMA_MODULE_PATH = require.resolve("@jungjaehoon/mama-server/src/mama/mama-api.js").replace("/mama-api.js", "");

// Singleton state
let initialized = false;
let mama: any = null;

/**
 * Initialize MAMA (lazy, once)
 */
async function initMAMA(): Promise<void> {
  if (initialized) return;

  // Set DB path
  process.env.MAMA_DB_PATH = process.env.MAMA_DB_PATH ||
    path.join(os.homedir(), ".claude/mama-memory.db");

  try {
    // Load mama-api (high-level API)
    mama = require(path.join(MAMA_MODULE_PATH, "mama-api.js"));

    // Initialize database via memory-store
    const memoryStore = require(path.join(MAMA_MODULE_PATH, "memory-store.js"));
    await memoryStore.initDB();

    initialized = true;
    console.log("[MAMA Plugin] Initialized with direct module integration");
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
  configSchema: emptyPluginConfigSchema(),

  register(api: ClawdbotPluginApi) {

    // =====================================================
    // mama_search - 시맨틱 메모리 검색
    // =====================================================
    api.registerTool({
      name: "mama_search",
      description: `Search semantic memory for relevant past decisions.

**ALWAYS use BEFORE making architectural decisions:**
- Find if this problem was solved before
- Recall reasoning and lessons learned
- Avoid repeating past mistakes
- Check for related decisions to link

**Returns:** Decisions ranked by semantic similarity with:
- Topic, decision, reasoning
- Similarity score (0-100%)
- Decision ID (for linking/updating)

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
          await initMAMA();

          const query = String(params.query || "").trim();
          if (!query) {
            return { content: [{ type: "text", text: "Error: query required" }] };
          }

          const limit = Math.min(Number(params.limit) || 5, 20);

          // Use mama.suggest() for semantic search
          const result = await mama.suggest(query, { limit, threshold: 0.5 });

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
            output += `   Reasoning: ${(r.reasoning || "").substring(0, 150)}...\n`;
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

**DECISION - Use when:**
- Making architectural choices
- Learning a lesson (success or failure)
- Establishing a pattern/convention
- Choosing between alternatives

**CHECKPOINT - Use when:**
- Ending a session (save state)
- Reaching a milestone
- Before switching tasks

**Link decisions:** Add "builds_on: decision_xxx" in reasoning to create graph edges.`,

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
          await initMAMA();

          const saveType = String(params.type);

          if (saveType === "checkpoint") {
            const summary = String(params.summary || "");
            if (!summary) {
              return { content: [{ type: "text", text: "Error: summary required for checkpoint" }] };
            }

            // mama.saveCheckpoint returns lastInsertRowid directly (not {id: ...})
            const checkpointId = await mama.saveCheckpoint(
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
          const result = await mama.save({
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
          await initMAMA();

          // Use mama.loadCheckpoint() and mama.list()
          const checkpoint = await mama.loadCheckpoint();
          const recentResult = await mama.list({ limit: 5 });
          const recent = recentResult?.decisions || [];

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

          let msg = `**Checkpoint** (${new Date(checkpoint.timestamp).toLocaleString()})\n\n`;
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
          await initMAMA();

          const decisionId = String(params.id || "");
          const outcome = String(params.outcome || "").toUpperCase();
          const reason = String(params.reason || "");

          if (!decisionId || !outcome) {
            return { content: [{ type: "text", text: "Error: id and outcome required" }] };
          }

          // mama.updateOutcome(id, { outcome, failure_reason, limitation })
          await mama.updateOutcome(decisionId, {
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
