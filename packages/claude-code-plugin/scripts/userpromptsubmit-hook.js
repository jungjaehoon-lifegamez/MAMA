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
    message: `[ultrawork-mode] Max precision: explore first, verify everything, quality over speed.`,
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
    message: `[search-mode] Explore codebase patterns, use Grep/AST-grep/LSP, synthesize before acting.`,
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
    message: `[analyze-mode] Gather context (explore+librarian agents), consult Oracle/Artistry if complex, synthesize.`,
  },
];

/**
 * Category routing: maps topic keywords to MAMA search query hints.
 * Ported from standalone's category-router.ts pattern.
 * When a user prompt matches a category, the corresponding searchHint
 * is appended to guide MAMA memory retrieval.
 */
const CATEGORY_ROUTES = [
  {
    name: 'test',
    patterns: [
      /\btest(s|ing)?\b/i,
      /\bspec\b/i,
      /\bunit\s*test/i,
      /\bintegration\s*test/i,
      /\be2e\b/i,
      /\bcoverage\b/i,
      /테스트/,
      /단위\s*테스트/,
      /통합\s*테스트/,
    ],
    searchHint: 'test strategy testing patterns coverage',
  },
  {
    name: 'deploy',
    patterns: [
      /\bdeploy(ment|ing)?\b/i,
      /\brelease\b/i,
      /\bpublish(ing)?\b/i,
      /\bci\s*\/?\s*cd\b/i,
      /\bpipeline\b/i,
      /배포/,
      /릴리스/,
      /퍼블리시/,
    ],
    searchHint: 'deployment release publish pipeline CI/CD',
  },
  {
    name: 'refactor',
    patterns: [
      /\brefactor(ing)?\b/i,
      /\brestructure\b/i,
      /\barchitect(ure)?\b/i,
      /\breorganize\b/i,
      /\bclean\s*up\b/i,
      /리팩토링/,
      /구조\s*변경/,
      /아키텍처/,
    ],
    searchHint: 'architecture refactoring design patterns structure',
  },
  {
    name: 'security',
    patterns: [
      /\bsecur(ity|e)\b/i,
      /\bauth(entication|orization)?\b/i,
      /\bpermission(s)?\b/i,
      /\bvulnerabilit(y|ies)\b/i,
      /보안/,
      /인증/,
      /권한/,
    ],
    searchHint: 'security authentication authorization permissions',
  },
  {
    name: 'performance',
    patterns: [
      /\bperformance\b/i,
      /\boptimiz(e|ation)\b/i,
      /\bslow\b/i,
      /\bfast(er)?\b/i,
      /\bbenchmark\b/i,
      /\bcach(e|ing)\b/i,
      /성능/,
      /최적화/,
      /캐시/,
    ],
    searchHint: 'performance optimization caching benchmark',
  },
];

/**
 * Detect category matches in text and return search hints.
 * Returns array of matched categories with their searchHint.
 */
function detectCategories(text) {
  if (!text || typeof text !== 'string') {
    return [];
  }
  const cleanText = text.replace(/```[\s\S]*?```/g, '').replace(/`[^`]+`/g, '');
  const matched = [];
  for (const category of CATEGORY_ROUTES) {
    for (const pattern of category.patterns) {
      if (pattern.test(cleanText)) {
        matched.push(category);
        break;
      }
    }
  }
  return matched;
}

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
module.exports = {
  handler: main,
  main,
  detectKeywords,
  detectCategories,
  KEYWORD_DETECTORS,
  CATEGORY_ROUTES,
  getEnabledFeatures,
};

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
  const categories = detectCategories(prompt);

  if (detected.length === 0 && categories.length === 0) {
    process.exit(0);
  }

  const parts = [];

  // Keyword mode messages
  if (detected.length > 0) {
    parts.push(...detected.map((d) => d.message));
  }

  // Category search hints
  if (categories.length > 0) {
    const categoryNames = categories.map((c) => c.name).join(', ');
    const hints = categories.map((c) => c.searchHint).join(' ');
    parts.push(
      `[mama-context] Detected topic: ${categoryNames}. ` +
        `When searching MAMA memory, prioritize: ${hints}`
    );
  }

  const output = {
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: parts.join('\n\n---\n\n'),
    },
  };

  console.log(JSON.stringify(output));
  process.exit(0);
}

if (require.main === module) {
  main().catch(() => process.exit(0));
}
