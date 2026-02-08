/**
 * Prompt Enhancer for MAMA OS Standalone
 *
 * Provides keyword detection, AGENTS.md discovery, and rules injection
 * as native built-in features. Ported from claude-code-plugin hooks.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';

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

const KEYWORD_DETECTORS: KeywordDetector[] = [
  {
    type: 'ultrawork',
    patterns: [/\bultrawork\b/i, /\bulw\b/i, /\[ultrawork\]/i, /\[ulw\]/i, /\[ulw-loop\]/i],
    message: `[ultrawork-mode]
ULTRAWORK MODE ACTIVATED. Maximum precision required.
- Absolute certainty before every action
- Exploration is MANDATORY, not optional
- Research before implementing
- Verify everything, assume nothing
- Quality over speed, always
</ultrawork-mode>`,
  },
  {
    type: 'search',
    patterns: [
      /\bsearch[- ]mode\b/i,
      /\[search[- ]?mode\]/i,
      /\bfind\b.*\b(all|every|across)\b/i,
      /\bexplore\b.*\b(codebase|project|repo)\b/i,
    ],
    message: `[search-mode]
SEARCH MODE. Gather context before acting:
- Fire 1-2 explore agents for codebase patterns
- Fire librarian agents if external libraries involved
- Use Grep, AST-grep, LSP for targeted searches
- SYNTHESIZE findings before proceeding.
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
    ],
    message: `[analyze-mode]
ANALYSIS MODE. Gather context before diving deep:

CONTEXT GATHERING (parallel):
- 1-2 explore agents (codebase patterns, implementations)
- 1-2 librarian agents (if external library involved)
- Direct tools: Grep, AST-grep, LSP for targeted searches

IF COMPLEX - DO NOT STRUGGLE ALONE. Consult specialists:
- **Oracle**: Conventional problems (architecture, debugging, complex logic)
- **Artistry**: Non-conventional problems (different approach needed)

SYNTHESIZE findings before proceeding.
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
    const results: Array<{ path: string; content: string; distance: number }> = [];

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
            results.push({ path: agentsMdPath, content, distance: depth });
          }
        }

        currentDir = dirname(currentDir);
        depth++;
      }
    } catch {
      // Silently handle filesystem errors
    }

    results.sort((a, b) => a.distance - b.distance);

    if (results.length === 0) {
      return '';
    }

    const sections = results.map(
      (r) => `<!-- AGENTS.md from ${r.path} (distance: ${r.distance}) -->\n${r.content}`
    );
    return sections.join('\n\n---\n\n');
  }

  discoverRules(workspacePath: string): string {
    if (!workspacePath) {
      return '';
    }

    const projectRoot = this.findProjectRoot(workspacePath);
    if (!projectRoot) {
      return '';
    }

    const rules: Array<{ path: string; content: string; distance: number }> = [];
    const seenPaths = new Set<string>();

    // 1. Check .copilot-instructions at project root
    const copilotPath = join(projectRoot, '.copilot-instructions');
    if (existsSync(copilotPath)) {
      try {
        if (statSync(copilotPath).isFile()) {
          const content = this.getCachedFile(copilotPath);
          if (content?.trim()) {
            rules.push({ path: copilotPath, content, distance: 0 });
            seenPaths.add(copilotPath);
          }
        }
      } catch {
        // Skip unreadable files
      }
    }

    // 2. Check project-level .claude/rules/*.md
    const projectRulesDir = join(projectRoot, '.claude', 'rules');
    this.collectRulesFromDir(projectRulesDir, 0, rules, seenPaths);

    // 3. Walk up from workspacePath for directory-level rules
    try {
      let currentDir = statSync(workspacePath).isDirectory()
        ? workspacePath
        : dirname(workspacePath);
      let distance = 1;

      while (currentDir !== projectRoot && currentDir !== dirname(currentDir)) {
        const dirRulesPath = join(currentDir, '.claude', 'rules');
        this.collectRulesFromDir(dirRulesPath, distance, rules, seenPaths);
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

  enhance(userMessage: string, workspacePath: string): EnhancedPromptContext {
    return {
      keywordInstructions: this.detectKeywords(userMessage),
      agentsContent: this.discoverAgentsMd(workspacePath),
      rulesContent: this.discoverRules(workspacePath),
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
    seenPaths: Set<string>
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
        if (seenPaths.has(rulePath)) {
          continue;
        }

        const content = this.getCachedFile(rulePath);
        if (content?.trim()) {
          rules.push({ path: rulePath, content, distance });
          seenPaths.add(rulePath);
        }
      }
    } catch {
      // Skip unreadable directories
    }
  }
}
