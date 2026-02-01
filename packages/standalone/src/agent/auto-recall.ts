/**
 * Auto-Recall Module for MAMA Standalone
 *
 * OpenClaw 플러그인의 auto-recall 로직을 standalone으로 이식.
 * 에이전트 시작 전에 관련 메모리를 자동으로 검색하여 컨텍스트에 주입.
 *
 * Features:
 * - 프롬프트 기반 시맨틱 검색
 * - 최근 체크포인트 로드
 * - 관련 결정 컨텍스트 주입
 */

import path from 'node:path';
import os from 'node:os';

// MAMA API interface (mama-server의 mama-api.js와 동일)
interface MAMADecision {
  id: string;
  topic: string;
  decision: string;
  reasoning: string;
  confidence?: number;
  outcome?: string;
  similarity?: number;
  created_at?: string;
}

interface MAMACheckpoint {
  id: number;
  summary: string;
  next_steps?: string;
  timestamp: string;
}

interface MAMASuggestResult {
  query: string;
  results: MAMADecision[];
}

// Singleton state
let initialized = false;
let mamaApi: any = null;

/**
 * Format reasoning with link extraction (OpenClaw 로직 재사용)
 */
function formatReasoning(reasoning: string, maxLen: number = 80): string {
  if (!reasoning) return '';

  // Extract link patterns
  const linkMatch = reasoning.match(/(builds_on|debates|synthesizes):\s*[\w\[\],\s_-]+/i);

  // Truncate main reasoning
  const truncated = reasoning.length > maxLen ? reasoning.substring(0, maxLen) + '...' : reasoning;

  // Add link info if found and not already in truncated part
  if (linkMatch && !truncated.includes(linkMatch[0])) {
    return `${truncated}\n  🔗 ${linkMatch[0]}`;
  }

  return truncated;
}

/**
 * Initialize MAMA API (lazy, singleton)
 */
async function initMAMA(dbPath?: string): Promise<void> {
  if (initialized && mamaApi) {
    return;
  }

  const finalDbPath =
    dbPath || process.env.MAMA_DB_PATH || path.join(os.homedir(), '.claude/mama-memory.db');

  process.env.MAMA_DB_PATH = finalDbPath;

  try {
    // Dynamic import of mama-server modules
    const mamaModulePath = path.dirname(
      require.resolve('@jungjaehoon/mama-server/src/mama/mama-api.js')
    );

    mamaApi = require(path.join(mamaModulePath, 'mama-api.js'));

    // Initialize database
    const memoryStore = require(path.join(mamaModulePath, 'memory-store.js'));
    await memoryStore.initDB();

    initialized = true;
    console.log(`[AutoRecall] MAMA initialized (db: ${finalDbPath})`);
  } catch (err: any) {
    console.error('[AutoRecall] MAMA init failed:', err.message);
    // Don't throw - auto-recall should be optional
  }
}

/**
 * Auto-recall 결과 타입
 */
export interface AutoRecallResult {
  /** 주입할 컨텍스트 문자열 */
  context: string;
  /** 시맨틱 검색 결과 수 */
  semanticMatches: number;
  /** 최근 결정 수 */
  recentDecisions: number;
  /** 체크포인트 존재 여부 */
  hasCheckpoint: boolean;
}

/**
 * 프롬프트 기반 auto-recall 실행
 *
 * OpenClaw의 before_agent_start 훅 로직을 standalone으로 이식.
 *
 * @param userPrompt - 사용자 프롬프트 (시맨틱 검색 쿼리로 사용)
 * @param options - 옵션
 * @returns AutoRecallResult 또는 null (메모리 없음)
 */
export async function autoRecall(
  userPrompt: string,
  options: {
    dbPath?: string;
    semanticLimit?: number;
    recentLimit?: number;
    threshold?: number;
  } = {}
): Promise<AutoRecallResult | null> {
  try {
    await initMAMA(options.dbPath);

    if (!mamaApi) {
      return null;
    }

    const semanticLimit = options.semanticLimit ?? 3;
    const recentLimit = options.recentLimit ?? 3;
    const threshold = options.threshold ?? 0.5;

    // 1. 시맨틱 검색 (프롬프트가 충분히 길 때만)
    let semanticResults: MAMADecision[] = [];
    if (userPrompt && userPrompt.length >= 5) {
      try {
        const searchResult: MAMASuggestResult | null = await mamaApi.suggest(userPrompt, {
          limit: semanticLimit,
          threshold,
        });
        semanticResults = searchResult?.results || [];
      } catch (err: any) {
        console.error('[AutoRecall] Semantic search error:', err.message);
      }
    }

    // 2. 체크포인트 로드
    let checkpoint: MAMACheckpoint | null = null;
    try {
      checkpoint = await mamaApi.loadCheckpoint();
    } catch (err: any) {
      console.error('[AutoRecall] Checkpoint load error:', err.message);
    }

    // 3. 최근 결정 로드 (시맨틱 결과가 없을 때만)
    let recentDecisions: MAMADecision[] = [];
    if (semanticResults.length === 0) {
      try {
        recentDecisions = await mamaApi.listDecisions({ limit: recentLimit });
      } catch (err: any) {
        console.error('[AutoRecall] Recent decisions error:', err.message);
      }
    }

    // 4. 컨텍스트가 없으면 null 반환
    if (!checkpoint && semanticResults.length === 0 && recentDecisions.length === 0) {
      return null;
    }

    // 5. 컨텍스트 문자열 생성
    let content = '<relevant-memories>\n';
    content += '# MAMA Memory Context\n\n';

    if (semanticResults.length > 0) {
      content += '## 관련 결정 (시맨틱 매치)\n\n';
      semanticResults.forEach((r) => {
        const pct = Math.round((r.similarity || 0) * 100);
        content += `- **${r.topic}** [${pct}%]: ${r.decision}`;
        if (r.outcome) content += ` (${r.outcome})`;
        content += `\n  _${formatReasoning(r.reasoning, 100)}_\n`;
        content += `  ID: \`${r.id}\`\n`;
      });
      content += '\n';
    }

    if (checkpoint) {
      const ts = new Date(checkpoint.timestamp).toLocaleString('ko-KR');
      content += `## 마지막 체크포인트 (${ts})\n\n`;
      content += `**요약:** ${checkpoint.summary}\n\n`;
      if (checkpoint.next_steps) {
        content += `**다음 단계:** ${checkpoint.next_steps}\n\n`;
      }
    }

    if (recentDecisions.length > 0) {
      content += '## 최근 결정\n\n';
      recentDecisions.forEach((d) => {
        content += `- **${d.topic}**: ${d.decision}`;
        if (d.outcome) content += ` (${d.outcome})`;
        content += '\n';
      });
      content += '\n';
    }

    content += '</relevant-memories>';

    console.log(
      `[AutoRecall] Found: ${semanticResults.length} semantic, ${recentDecisions.length} recent, checkpoint: ${!!checkpoint}`
    );

    return {
      context: content,
      semanticMatches: semanticResults.length,
      recentDecisions: recentDecisions.length,
      hasCheckpoint: !!checkpoint,
    };
  } catch (err: any) {
    console.error('[AutoRecall] Error:', err.message);
    return null;
  }
}

/**
 * MAMA API 직접 접근 (고급 사용)
 */
export function getMAMAApi(): any {
  return mamaApi;
}

/**
 * 초기화 상태 확인
 */
export function isInitialized(): boolean {
  return initialized;
}
