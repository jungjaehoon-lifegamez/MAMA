/**
 * Prompt Enhancer for MAMA OS Standalone
 *
 * Provides keyword detection, AGENTS.md discovery, and rules injection
 * as native built-in features. Ported from claude-code-plugin hooks.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { ContentDeduplicator } from './content-dedup.js';
import { parseFrontmatter, matchesContext } from './yaml-frontmatter.js';
import type { RuleContext } from './yaml-frontmatter.js';

export interface EnhancedPromptContext {
  keywordInstructions: string;
  agentsContent: string;
  rulesContent: string;
}

interface CacheEntry {
  content: string;
  loadedAt: number;
}

interface KeywordDetector {
  type: string;
  patterns: RegExp[];
  message: string;
}

const PROJECT_ROOT_MARKERS = ['.git', 'package.json', 'pnpm-workspace.yaml', '.claude'];

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', '.next', 'build', 'out']);

// ============================================================================
// KEYWORD DETECTORS — Multilingual (EN/KR/JP/CN/VN) with detailed instructions
// ============================================================================

const KEYWORD_DETECTORS: KeywordDetector[] = [
  // ─────────────────────────────────────────────────────────────────────────
  // ULTRAWORK MODE — Maximum autonomy, maximum precision
  // ─────────────────────────────────────────────────────────────────────────
  {
    type: 'ultrawork',
    patterns: [
      // English
      /\bultrawork\b/i,
      /\bulw\b/i,
      /\[ultrawork\]/i,
      /\[ulw\]/i,
      /\[ulw[- ]?loop\]/i,
      /\bdeep[- ]?work\b/i,
      /\bautonomous\b/i,
      /\bfull[- ]?auto\b/i,
      // Korean
      /울트라워크/i,
      /자율\s*작업/i,
      /자율\s*모드/i,
      /딥\s*워크/i,
      /완전\s*자동/i,
      // Japanese
      /ウルトラワーク/i,
      /自律作業/i,
      /自律モード/i,
      /ディープワーク/i,
      // Chinese
      /超级工作/i,
      /自主工作/i,
      /自主模式/i,
      /深度工作/i,
      // Vietnamese
      /siêu\s*công\s*việc/i,
      /tự\s*động\s*hoàn\s*toàn/i,
      /chế\s*độ\s*tự\s*chủ/i,
    ],
    message: `<ultrawork-mode>
## ULTRAWORK MODE ACTIVATED

**MANDATORY BANNER: You are in ULTRAWORK mode. Maximum precision. Zero tolerance for guessing.**

---

### CORE PRINCIPLES

1. **ABSOLUTE CERTAINTY REQUIRED** — Never guess. Never assume. If you don't know, STOP and find out.
2. **EXPLORATION IS MANDATORY** — Before ANY implementation, gather full context. No exceptions.
3. **QUALITY OVER SPEED** — Take 10x longer if it means getting it right. Broken code is worthless.
4. **VERIFY EVERYTHING** — After every change, verify it works. Diagnostics, build, tests. No shortcuts.
5. **FIX ROOT CAUSES** — Never patch symptoms. Understand WHY something broke before fixing it.

---

### PHASE 1: UNDERSTAND (Before touching ANY code)

**Context Gathering (PARALLEL — fire all at once):**

| Agent Type | When to Fire | Purpose |
|------------|-------------|---------|
| 1-2 \`explore\` agents | ALWAYS | Codebase patterns, existing implementations, conventions |
| 1-2 \`librarian\` agents | When external libs involved | Official docs, API references, best practices |
| Direct tools (Grep, AST-grep, LSP) | ALWAYS | Targeted searches for specific symbols/patterns |

**MUST gather before proceeding:**
- [ ] What files are involved?
- [ ] What patterns does this codebase use?
- [ ] Are there tests to check?
- [ ] What could break?

---

### PHASE 2: PLAN (Before implementing)

**For complex tasks (3+ files, multi-step logic):**
1. Create a detailed todo list with atomic steps
2. Identify dependencies between steps
3. Determine verification criteria for each step

**Pre-planning consultation:**
- **Metis** (subagent_type="metis") — When requirements are ambiguous, identify hidden intentions and failure points
- **Momus** (subagent_type="momus") — After creating plan, review for gaps, ambiguities, missing context

**For simpler tasks:**
- Break into steps mentally, proceed with todo tracking

---

### PHASE 3: IMPLEMENT (One step at a time)

**Delegation Protocol — DELEGATE, DON'T DO EVERYTHING YOURSELF:**

| Task Domain | Delegate To | Category |
|-------------|-------------|----------|
| Frontend/UI/CSS/animation | task(category="visual-engineering") | With \`frontend-ui-ux\` skill |
| Hard logic/algorithm/debug | task(category="ultrabrain") | Clear goals only, no hand-holding |
| Deep autonomous problem-solving | task(category="deep") | Hairy problems, needs research first |
| Creative/unconventional solutions | task(category="artistry") | Beyond standard patterns |
| Simple single-file changes | task(category="quick") | Trivial modifications |
| Architecture decisions | Oracle (subagent_type="oracle") | Read-only consultation |
| After 2+ failed fix attempts | Oracle (subagent_type="oracle") | Debugging escalation |

**Session Continuity — ALWAYS use session_id:**
- Every task() returns a session_id
- On follow-up/fix: \`task(session_id="ses_xxx", prompt="Fix: ...")\`
- NEVER start fresh when you can continue — saves 70%+ tokens

**Implementation Rules:**
- Match existing codebase patterns (check conventions FIRST)
- NO type error suppression (\`as any\`, \`@ts-ignore\`, \`@ts-expect-error\`)
- NO empty catch blocks
- NO deleting tests to make them pass
- Bugfix = minimal fix only. NEVER refactor while fixing.

---

### PHASE 4: VERIFY (After EVERY change)

**Evidence Requirements — Task is NOT complete without these:**

| Action | Required Evidence |
|--------|-------------------|
| File edit | \`lsp_diagnostics\` clean on changed files |
| Build command | Exit code 0 |
| Test run | All pass (or explicit note of pre-existing failures) |
| Delegation | Agent result received AND verified |

**Verification sequence:**
1. Run \`lsp_diagnostics\` on every changed file
2. Run build if applicable
3. Run tests if applicable
4. Manually verify the change makes sense

**NO EVIDENCE = NOT COMPLETE.**

---

### FAILURE RECOVERY

**After 3 consecutive failures:**
1. **STOP** all further edits immediately
2. **REVERT** to last known working state
3. **DOCUMENT** what was attempted and what failed
4. **CONSULT** Oracle with full failure context
5. If Oracle cannot resolve → **ASK USER**

**NEVER:** Leave code in broken state. Continue hoping it'll work. Shotgun debug with random changes.

---

### COMPLETION CHECKLIST

Before declaring DONE:
- [ ] All todo items marked complete
- [ ] Diagnostics clean on ALL changed files
- [ ] Build passes (if applicable)
- [ ] Tests pass (if applicable)
- [ ] User's original request FULLY addressed
- [ ] Cancel ALL background tasks: \`background_cancel(all=true)\`

**NO EXCUSES. NO COMPROMISES. SHIP QUALITY.**
</ultrawork-mode>`,
  },

  // ─────────────────────────────────────────────────────────────────────────
  // SEARCH MODE — Exhaustive codebase exploration
  // ─────────────────────────────────────────────────────────────────────────
  {
    type: 'search',
    patterns: [
      // English
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
      // Korean
      /검색\s*모드/i,
      /\[검색\]/i,
      /전부\s*찾아/i,
      /모두\s*찾아/i,
      /다\s*찾아/i,
      /코드베이스\s*탐색/i,
      /프로젝트\s*탐색/i,
      /어디.*사용/i,
      /어디.*정의/i,
      /어디.*호출/i,
      /전체\s*검색/i,
      // Japanese
      /検索モード/i,
      /\[検索\]/i,
      /全部探して/i,
      /全て探して/i,
      /コードベース.*探/i,
      /どこ.*使われ/i,
      /どこ.*定義/i,
      // Chinese
      /搜索模式/i,
      /\[搜索\]/i,
      /全部找/i,
      /找出所有/i,
      /代码库.*搜索/i,
      /哪里.*使用/i,
      /哪里.*定义/i,
      // Vietnamese
      /chế\s*độ\s*tìm\s*kiếm/i,
      /tìm\s*tất\s*cả/i,
      /tìm\s*toàn\s*bộ/i,
      /tìm\s*ở\s*đâu/i,
    ],
    message: `<search-mode>
## SEARCH MODE ACTIVATED

**Your job: FIND, not fix. Gather exhaustive context before any action.**

---

### SEARCH STRATEGY (execute in parallel)

**Internal Codebase Search:**
| Tool | When | Example |
|------|------|---------|
| \`explore\` agent (background) | Multi-file patterns | "Find all auth implementations" |
| \`Grep\` | Known text patterns | Exact string/regex matches |
| \`AST-grep\` | Code structure patterns | Function signatures, imports, exports |
| \`LSP find_references\` | Symbol usage | All callers/consumers of a function |
| \`LSP goto_definition\` | Symbol origin | Where something is defined |
| \`Glob\` | File patterns | Find files by name pattern |

**External Reference Search:**
| Tool | When | Example |
|------|------|---------|
| \`librarian\` agent (background) | External libs/frameworks | "How does library X handle Y?" |
| \`Context7\` (via librarian) | Official docs | Library documentation lookup |
| \`WebSearch\` (via librarian) | Broader context | Best practices, known issues |
| \`grep.app\` (via librarian) | OSS examples | Real-world usage patterns |

---

### SEARCH PROTOCOL

1. **Fire parallel agents FIRST** — Don't wait. Launch explore/librarian agents in background immediately.
2. **Use direct tools while waiting** — Grep, AST-grep, LSP searches run instantly.
3. **Collect background results** — \`background_output(task_id="...")\` when needed.
4. **Cross-reference findings** — Don't trust a single source. Verify across multiple search methods.
5. **Stop when saturated** — If 2 search iterations yield no new information, you have enough.

### SYNTHESIS (before responding)

After gathering all results:
1. **Organize by relevance** — Group findings by topic, not by search method
2. **Identify patterns** — What's consistent across the codebase?
3. **Note gaps** — What's missing or inconsistent?
4. **Present clearly** — Files, line numbers, code snippets with context

**NEVER report raw search dumps. Always synthesize into actionable insights.**
</search-mode>`,
  },

  // ─────────────────────────────────────────────────────────────────────────
  // ANALYZE MODE — Deep investigation and problem-solving
  // ─────────────────────────────────────────────────────────────────────────
  {
    type: 'analyze',
    patterns: [
      // English
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
      // Korean
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
      // Japanese
      /分析モード/i,
      /\[分析\]/i,
      /調査して/i,
      /深く分析/i,
      /根本原因/i,
      /デバッグ/i,
      /なぜ.*エラー/i,
      /なぜ.*失敗/i,
      // Chinese
      /分析模式/i,
      /\[分析\]/i,
      /调查/i,
      /深入分析/i,
      /根本原因/i,
      /为什么.*错误/i,
      /为什么.*失败/i,
      // Vietnamese
      /chế\s*độ\s*phân\s*tích/i,
      /phân\s*tích\s*sâu/i,
      /điều\s*tra/i,
      /nguyên\s*nhân\s*gốc/i,
      /tại\s*sao.*lỗi/i,
    ],
    message: `<analyze-mode>
## ANALYSIS MODE ACTIVATED

**Your job: UNDERSTAND before acting. Depth over speed.**

---

### PHASE 1: CONTEXT GATHERING (parallel)

Fire ALL of these simultaneously:

| Agent/Tool | Purpose | Fire When |
|------------|---------|-----------|
| 1-2 \`explore\` agents (background) | Codebase patterns, related implementations | ALWAYS |
| 1-2 \`librarian\` agents (background) | External library docs, known issues | When external libs involved |
| \`Grep\` / \`AST-grep\` | Targeted pattern searches | ALWAYS |
| \`LSP diagnostics\` | Current errors/warnings | When debugging |
| \`LSP find_references\` | Impact analysis | When tracing call chains |

---

### PHASE 2: DEEP ANALYSIS

**For Debugging:**
1. Reproduce the issue (understand exact symptoms)
2. Trace the execution path (where does it diverge from expected?)
3. Identify the root cause (WHY, not just WHERE)
4. Verify your hypothesis before fixing

**For Architecture Analysis:**
1. Map the data flow (input → processing → output)
2. Identify coupling points (what depends on what?)
3. Find abstraction boundaries (where should changes be contained?)
4. Check for existing patterns (how does the codebase handle similar things?)

**For Performance Analysis:**
1. Profile the hot path (what's slow?)
2. Check algorithmic complexity (O(n) vs O(n²) etc.)
3. Identify I/O bottlenecks (network, disk, database)
4. Measure before and after (no guessing)

---

### PHASE 3: CONSULT SPECIALISTS (when needed)

**DO NOT STRUGGLE ALONE.** If analysis is complex, escalate:

| Specialist | When to Use | How |
|------------|-------------|-----|
| **Oracle** | Architecture decisions, complex debugging, multi-system tradeoffs | subagent_type="oracle" |
| **Metis** | Ambiguous requirements, hidden intentions | subagent_type="metis" |
| **Momus** | Plan review, gap analysis | subagent_type="momus" |

**Escalation triggers:**
- 2+ failed attempts to understand the issue
- Multiple interacting systems involved
- Performance issue with non-obvious cause
- Security concern

---

### SYNTHESIS

Present analysis as:
1. **Root Cause** — What's actually wrong and WHY
2. **Evidence** — Code references, logs, traces that prove it
3. **Impact** — What's affected, what could break
4. **Options** — Possible solutions with tradeoffs
5. **Recommendation** — Your suggested approach with reasoning

**NEVER jump to fixing without completing analysis. Understanding IS the work.**
</analyze-mode>`,
  },
];

export class PromptEnhancer {
  private fileCache: Map<string, CacheEntry> = new Map();
  private readonly cacheTTL = 60_000;

  detectKeywords(userMessage: string): string {
    if (!userMessage || typeof userMessage !== 'string') {
      return '';
    }

    const cleanText = userMessage.replace(/```[\s\S]*?```/g, '').replace(/`[^`]+`/g, '');
    const detected: string[] = [];

    for (const detector of KEYWORD_DETECTORS) {
      for (const pattern of detector.patterns) {
        if (pattern.test(cleanText)) {
          detected.push(detector.message);
          console.log(`[PromptEnhancer] Keyword detected: ${detector.type}`);
          break;
        }
      }
    }

    return detected.join('\n\n---\n\n');
  }

  discoverAgentsMd(workspacePath: string): string {
    if (!workspacePath) {
      return '';
    }

    const projectRoot = this.findProjectRoot(workspacePath);
    const dedup = new ContentDeduplicator();

    try {
      let currentDir = statSync(workspacePath).isDirectory()
        ? workspacePath
        : dirname(workspacePath);
      let depth = 0;
      const maxDepth = 5;

      while (depth < maxDepth && currentDir !== dirname(currentDir)) {
        const dirName = basename(currentDir);
        if (SKIP_DIRS.has(dirName)) {
          currentDir = dirname(currentDir);
          depth++;
          continue;
        }

        const agentsMdPath = join(currentDir, 'AGENTS.md');
        if (existsSync(agentsMdPath)) {
          // Skip project root AGENTS.md (loaded by Claude Code's --add-dir)
          if (projectRoot && currentDir === projectRoot) {
            currentDir = dirname(currentDir);
            depth++;
            continue;
          }

          const content = this.getCachedFile(agentsMdPath);
          if (content) {
            dedup.add(agentsMdPath, content, depth);
          }
        }

        currentDir = dirname(currentDir);
        depth++;
      }
    } catch {
      // Silently handle filesystem errors
    }

    const entries = dedup.getEntries();

    if (entries.length === 0) {
      return '';
    }

    const sections = entries.map(
      (e) => `<!-- AGENTS.md from ${e.path} (distance: ${e.distance}) -->\n${e.content}`
    );
    return sections.join('\n\n---\n\n');
  }

  discoverRules(workspacePath: string, ruleContext?: RuleContext): string {
    if (!workspacePath) {
      return '';
    }

    const projectRoot = this.findProjectRoot(workspacePath);
    if (!projectRoot) {
      return '';
    }

    const rules: Array<{ path: string; content: string; distance: number }> = [];
    const dedup = new ContentDeduplicator();

    // 1. Check .copilot-instructions at project root
    const copilotPath = join(projectRoot, '.copilot-instructions');
    if (existsSync(copilotPath)) {
      try {
        if (statSync(copilotPath).isFile()) {
          const rawContent = this.getCachedFile(copilotPath);
          if (rawContent?.trim()) {
            if (dedup.add(copilotPath, rawContent, 0)) {
              rules.push({ path: copilotPath, content: rawContent, distance: 0 });
            }
          }
        }
      } catch {
        // Skip unreadable files
      }
    }

    // 2. Check project-level .claude/rules/*.md
    const projectRulesDir = join(projectRoot, '.claude', 'rules');
    this.collectRulesFromDir(projectRulesDir, 0, rules, dedup, ruleContext);

    // 3. Walk up from workspacePath for directory-level rules
    try {
      let currentDir = statSync(workspacePath).isDirectory()
        ? workspacePath
        : dirname(workspacePath);
      let distance = 1;

      while (currentDir !== projectRoot && currentDir !== dirname(currentDir)) {
        const dirRulesPath = join(currentDir, '.claude', 'rules');
        this.collectRulesFromDir(dirRulesPath, distance, rules, dedup, ruleContext);
        currentDir = dirname(currentDir);
        distance++;
      }
    } catch {
      // Silently handle filesystem errors
    }

    rules.sort((a, b) => a.distance - b.distance);

    if (rules.length === 0) {
      return '';
    }

    const sections = rules.map((r) => `<!-- Rule: ${r.path} -->\n${r.content}`);
    return sections.join('\n\n---\n\n');
  }

  enhance(
    userMessage: string,
    workspacePath: string,
    ruleContext?: RuleContext
  ): EnhancedPromptContext {
    return {
      keywordInstructions: this.detectKeywords(userMessage),
      agentsContent: this.discoverAgentsMd(workspacePath),
      rulesContent: this.discoverRules(workspacePath, ruleContext),
    };
  }

  private findProjectRoot(startPath: string): string | null {
    try {
      let currentPath = statSync(startPath).isDirectory() ? startPath : dirname(startPath);

      while (currentPath !== dirname(currentPath)) {
        for (const marker of PROJECT_ROOT_MARKERS) {
          if (existsSync(join(currentPath, marker))) {
            return currentPath;
          }
        }
        currentPath = dirname(currentPath);
      }

      return null;
    } catch {
      return null;
    }
  }

  private getCachedFile(filePath: string): string | null {
    const cached = this.fileCache.get(filePath);
    const now = Date.now();

    if (cached && now - cached.loadedAt < this.cacheTTL) {
      return cached.content;
    }

    try {
      const content = readFileSync(filePath, 'utf8');
      this.fileCache.set(filePath, { content, loadedAt: now });
      return content;
    } catch {
      return null;
    }
  }

  private collectRulesFromDir(
    dirPath: string,
    distance: number,
    rules: Array<{ path: string; content: string; distance: number }>,
    dedup: ContentDeduplicator,
    ruleContext?: RuleContext
  ): void {
    if (!existsSync(dirPath)) {
      return;
    }

    try {
      if (!statSync(dirPath).isDirectory()) {
        return;
      }

      const files = readdirSync(dirPath);
      for (const file of files) {
        if (!file.endsWith('.md')) {
          continue;
        }

        const rulePath = join(dirPath, file);
        const rawContent = this.getCachedFile(rulePath);
        if (!rawContent?.trim()) {
          continue;
        }

        const parsed = parseFrontmatter(rawContent);
        if (!matchesContext(parsed.appliesTo, ruleContext)) {
          continue;
        }

        if (dedup.add(rulePath, parsed.rawContent, distance)) {
          rules.push({ path: rulePath, content: parsed.content, distance });
        }
      }
    } catch {
      // Skip unreadable directories
    }
  }
}
