#!/usr/bin/env node
/**
 * UserPromptSubmit Hook for MAMA Plugin
 *
 * Lightweight keyword detector. Detects ultrawork/search/analyze mode
 * keywords in user prompts and injects behavior mode instructions.
 *
 * @module userpromptsubmit-hook
 */

const path = require('path');
const PLUGIN_ROOT = path.resolve(__dirname, '..');
const CORE_PATH = path.join(PLUGIN_ROOT, 'src', 'core');
const { getEnabledFeatures } = require(path.join(CORE_PATH, 'hook-features'));

const KEYWORD_DETECTORS = [
  {
    type: 'ultrawork',
    patterns: [
      /\bultrawork\b/i,
      /\bulw\b/i,
      /\[ultrawork\]/i,
      /\[ulw\]/i,
      /\[ulw[- ]?loop\]/i,
      /\bdeep[- ]?work\b/i,
      /\bautonomous\b/i,
      /\bfull[- ]?auto\b/i,
      /울트라워크/i,
      /자율\s*작업/i,
      /자율\s*모드/i,
      /딥\s*워크/i,
      /완전\s*자동/i,
      /ウルトラワーク/i,
      /自律作業/i,
      /自律モード/i,
      /ディープワーク/i,
      /超级工作/i,
      /自主工作/i,
      /自主模式/i,
      /深度工作/i,
      /siêu\s*công\s*việc/i,
      /tự\s*động\s*hoàn\s*toàn/i,
      /chế\s*độ\s*tự\s*chủ/i,
    ],
    message: `<ultrawork-mode>
ULTRAWORK MODE ACTIVATED. Maximum precision. Zero tolerance for guessing.

CORE PRINCIPLES:
1. ABSOLUTE CERTAINTY — Never guess. If you don't know, STOP and find out.
2. EXPLORATION MANDATORY — Before ANY implementation, gather full context.
3. QUALITY OVER SPEED — Take 10x longer if it means getting it right.
4. VERIFY EVERYTHING — Diagnostics, build, tests after every change.
5. FIX ROOT CAUSES — Never patch symptoms.

WORKFLOW: Understand → Plan → Implement → Verify
- Fire explore/librarian agents in parallel for context
- Create todo list for multi-step tasks
- Delegate specialized work (visual-engineering, ultrabrain, deep, etc.)
- Use session_id for follow-ups (saves 70%+ tokens)
- Run lsp_diagnostics on every changed file
- NO type suppression (as any, @ts-ignore), NO empty catches, NO deleting tests

FAILURE RECOVERY: After 3 failures → STOP → REVERT → CONSULT Oracle → ASK USER
COMPLETION: All todos done + diagnostics clean + build passes + tests pass
</ultrawork-mode>`,
  },
  {
    type: 'search',
    patterns: [
      /\bsearch[- ]mode\b/i,
      /\[search[- ]?mode\]/i,
      /\bfind\b.*\b(all|every|across)\b/i,
      /\bexplore\b.*\b(codebase|project|repo)\b/i,
      /\bsearch\b.*\b(entire|whole|full)\b/i,
      /\bgrep\b.*\b(all|every|across)\b/i,
      /\bwhere\s+is\b.*\b(used|defined|called|imported)\b/i,
      /\bfind\s+all\b/i,
      /\bshow\s+me\s+all\b/i,
      /\blist\s+all\b/i,
      /검색\s*모드/i,
      /\[검색\]/i,
      /전부\s*찾아/i,
      /모두\s*찾아/i,
      /다\s*찾아/i,
      /코드베이스\s*탐색/i,
      /어디.*사용/i,
      /어디.*정의/i,
      /어디.*호출/i,
      /전체\s*검색/i,
      /検索モード/i,
      /\[検索\]/i,
      /全部探して/i,
      /全て探して/i,
      /どこ.*使われ/i,
      /どこ.*定義/i,
      /搜索模式/i,
      /\[搜索\]/i,
      /全部找/i,
      /找出所有/i,
      /哪里.*使用/i,
      /哪里.*定义/i,
      /chế\s*độ\s*tìm\s*kiếm/i,
      /tìm\s*tất\s*cả/i,
      /tìm\s*toàn\s*bộ/i,
      /tìm\s*ở\s*đâu/i,
    ],
    message: `<search-mode>
SEARCH MODE. Find, don't fix. Gather exhaustive context.

INTERNAL: explore agents (background) + Grep + AST-grep + LSP find_references/goto_definition + Glob
EXTERNAL: librarian agents (background) for docs, OSS examples, best practices

PROTOCOL:
1. Fire parallel agents FIRST (background)
2. Use direct tools while waiting
3. Collect background results when needed
4. Cross-reference findings across multiple methods
5. Stop when 2 iterations yield no new info

SYNTHESIS: Organize by relevance, identify patterns, note gaps, present with file paths and line numbers.
Never report raw search dumps — always synthesize into actionable insights.
</search-mode>`,
  },
  {
    type: 'analyze',
    patterns: [
      /\banalyze[- ]mode\b/i,
      /\[analyze[- ]?mode\]/i,
      /\binvestigate\b/i,
      /\bresearch\b.*\b(deep|thorough)\b/i,
      /\bdebug\b.*\b(deep|thorough)\b/i,
      /\broot\s*cause\b/i,
      /\bdiagnose\b/i,
      /\banalyze\b.*\b(thoroughly|deeply|carefully)\b/i,
      /\bdeep\s*dive\b/i,
      /\bdeep\s*analysis\b/i,
      /\bwhy\s+(does|is|did)\b.*\b(fail|break|error|crash|wrong|bug)\b/i,
      /분석\s*모드/i,
      /\[분석\]/i,
      /조사해/i,
      /깊이\s*분석/i,
      /원인\s*분석/i,
      /근본\s*원인/i,
      /디버그/i,
      /왜.*안\s*되/i,
      /왜.*에러/i,
      /왜.*오류/i,
      /왜.*실패/i,
      /왜.*깨지/i,
      /分析モード/i,
      /\[分析\]/i,
      /調査して/i,
      /深く分析/i,
      /根本原因/i,
      /デバッグ/i,
      /なぜ.*エラー/i,
      /なぜ.*失敗/i,
      /分析模式/i,
      /\[分析\]/i,
      /调查/i,
      /深入分析/i,
      /为什么.*错误/i,
      /为什么.*失败/i,
      /chế\s*độ\s*phân\s*tích/i,
      /phân\s*tích\s*sâu/i,
      /điều\s*tra/i,
      /nguyên\s*nhân\s*gốc/i,
      /tại\s*sao.*lỗi/i,
    ],
    message: `<analyze-mode>
ANALYSIS MODE. Understand before acting. Depth over speed.

CONTEXT GATHERING (parallel):
- 1-2 explore agents (codebase patterns, implementations)
- 1-2 librarian agents (if external library involved)
- Direct tools: Grep, AST-grep, LSP diagnostics/references

FOR DEBUGGING: Reproduce → Trace execution path → Identify root cause → Verify hypothesis
FOR ARCHITECTURE: Map data flow → Identify coupling → Find abstraction boundaries → Check patterns
FOR PERFORMANCE: Profile hot path → Check complexity → Identify I/O bottlenecks → Measure

DO NOT STRUGGLE ALONE — escalate when needed:
- Oracle: Architecture, complex debugging, multi-system tradeoffs
- Metis: Ambiguous requirements, hidden intentions
- Momus: Plan review, gap analysis

SYNTHESIS: Root Cause + Evidence + Impact + Options + Recommendation
Never jump to fixing without completing analysis.
</analyze-mode>`,
  },
];

function detectKeywords(text) {
  if (!text || typeof text !== 'string') {
    return [];
  }
  // Remove code blocks to prevent false positives
  const cleanText = text.replace(/```[\s\S]*?```/g, '').replace(/`[^`]+`/g, '');
  const detected = [];
  for (const detector of KEYWORD_DETECTORS) {
    for (const pattern of detector.patterns) {
      if (pattern.test(cleanText)) {
        detected.push(detector);
        break;
      }
    }
  }
  return detected;
}

// Export for testing and hook spec compliance
module.exports = { handler: main, main, detectKeywords, KEYWORD_DETECTORS, getEnabledFeatures };

async function main() {
  const features = getEnabledFeatures();
  if (!features.has('keywords')) {
    process.exit(0);
  }

  // Read JSON input from stdin
  let input = '';
  for await (const chunk of process.stdin) {
    input += chunk;
  }

  let prompt = '';
  try {
    const parsed = JSON.parse(input);
    prompt = parsed.prompt || '';
  } catch {
    // If not JSON, treat entire input as prompt text
    prompt = input.trim();
  }

  if (!prompt) {
    process.exit(0);
  }

  const detected = detectKeywords(prompt);
  if (detected.length === 0) {
    process.exit(0);
  }

  const messages = detected.map((d) => d.message);
  const output = {
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: messages.join('\n\n---\n\n'),
    },
  };

  console.log(JSON.stringify(output));
  process.exit(0);
}

if (require.main === module) {
  main().catch(() => process.exit(0));
}
