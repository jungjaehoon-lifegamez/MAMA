# Knowledge Compilation — Wiki Agent + Event Bus

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** MAMA's structured decisions (DB) are compiled into human-readable Obsidian wiki pages by a dedicated Wiki Agent, orchestrated via an AgentEventBus that enables event-driven agent chaining (memory:saved → wiki:compiled → dashboard:refresh).

**Architecture:** Three new components: (1) `AgentEventBus` — a process-wide event emitter that lets agents react to each other's actions. Memory Agent emits `memory:saved`, Wiki Agent listens and recompiles affected projects, Dashboard Agent refreshes on `wiki:compiled`. (2) `Wiki Agent` — a dedicated AgentLoop with its own persona (`wiki-agent-persona.ts`), restricted to `mama_search` + `wiki_publish` tools. Runs on events + nightly cron. (3) `ObsidianWriter` — handles file I/O with frontmatter and human section preservation. DB tracks facts, Wiki compiles understanding (Karpathy "compile, not retrieve" pattern).

**Tech Stack:** TypeScript, AgentLoop (existing pattern from dashboard-agent), mama-core APIs, Obsidian vault filesystem, CronScheduler.

**Decision:** `decision_v018_wiki_agent_architecture_1775633649481_f2bc86f7`

---

## File Structure

| File                                                                | Responsibility                                              |
| ------------------------------------------------------------------- | ----------------------------------------------------------- |
| `packages/mama-core/src/memory/types.ts`                            | Add `'compiled'` to `MEMORY_KINDS`                          |
| `packages/standalone/src/multi-agent/agent-event-bus.ts`            | Global event bus: emit/on for cross-agent events            |
| `packages/standalone/src/multi-agent/wiki-agent-persona.ts`         | Wiki Agent persona → `~/.mama/personas/wiki.md`             |
| `packages/standalone/src/wiki/wiki-compiler.ts`                     | Compilation prompt builder + response parser                |
| `packages/standalone/src/wiki/obsidian-writer.ts`                   | Write/update `.md` files with frontmatter to Obsidian vault |
| `packages/standalone/src/wiki/types.ts`                             | Shared types: `WikiPage`, `CompilationResult`, `WikiConfig` |
| `packages/standalone/src/memory/history-extractor.ts`               | Add `buildCompilationPrompt()` export (Pass 3)              |
| `packages/standalone/src/connectors/framework/polling-scheduler.ts` | Add optional `onPostExtract` callback                       |
| `packages/standalone/src/cli/commands/start.ts`                     | Wire compilation into polling loop + cron job               |
| `tests/wiki/wiki-compiler.test.ts`                                  | Unit tests for compilation logic                            |
| `tests/wiki/obsidian-writer.test.ts`                                | Unit tests for file I/O                                     |
| `tests/wiki/types.test.ts`                                          | Type validation tests                                       |

---

### Task 1: Add `compiled` memory kind to mama-core

**Files:**

- Modify: `packages/mama-core/src/memory/types.ts:4-12`
- Test: `packages/mama-core/tests/memory/types.test.ts` (if exists, else inline verify)

- [ ] **Step 1: Write the failing test**

```typescript
// In a new test or existing types test:
import { MEMORY_KINDS } from '../../src/memory/types.js';

it('includes compiled kind', () => {
  expect(MEMORY_KINDS).toContain('compiled');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/mama-core && npx vitest run -t "compiled kind"`
Expected: FAIL — `'compiled'` not in array

- [ ] **Step 3: Add `compiled` to MEMORY_KINDS**

In `packages/mama-core/src/memory/types.ts`, change:

```typescript
export const MEMORY_KINDS = [
  'decision',
  'preference',
  'constraint',
  'lesson',
  'fact',
  'task',
  'schedule',
  'compiled',
] as const;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/mama-core && npx vitest run -t "compiled kind"`
Expected: PASS

- [ ] **Step 5: Build to check types propagate**

Run: `pnpm build`
Expected: 0 errors

- [ ] **Step 6: Commit**

```bash
git add packages/mama-core/src/memory/types.ts
git commit -m "feat(core): add 'compiled' memory kind for wiki compilation"
```

---

### Task 2: Wiki types module

**Files:**

- Create: `packages/standalone/src/wiki/types.ts`
- Test: `packages/standalone/tests/wiki/types.test.ts`

- [ ] **Step 1: Write the type validation test**

```typescript
import { describe, expect, it } from 'vitest';
import type { WikiPage, WikiConfig, CompilationResult } from '../../src/wiki/types.js';
import { WIKI_PAGE_TYPES, isValidPageType } from '../../src/wiki/types.js';

describe('Wiki types', () => {
  it('defines page types', () => {
    expect(WIKI_PAGE_TYPES).toContain('entity');
    expect(WIKI_PAGE_TYPES).toContain('lesson');
    expect(WIKI_PAGE_TYPES).toContain('synthesis');
    expect(WIKI_PAGE_TYPES).toContain('process');
  });

  it('validates page types', () => {
    expect(isValidPageType('entity')).toBe(true);
    expect(isValidPageType('garbage')).toBe(false);
  });

  it('WikiPage interface is assignable', () => {
    const page: WikiPage = {
      path: 'projects/ProjectAlpha.md',
      title: 'ProjectAlpha',
      type: 'entity',
      content: '# ProjectAlpha\n\nProject page.',
      sourceIds: ['decision_123'],
      compiledAt: new Date().toISOString(),
      confidence: 'high',
    };
    expect(page.title).toBe('ProjectAlpha');
  });

  it('WikiConfig interface is assignable', () => {
    const config: WikiConfig = {
      vaultPath: '/Users/test/vault',
      wikiDir: 'wiki',
      enabled: true,
    };
    expect(config.vaultPath).toBe('/Users/test/vault');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/standalone && npx vitest run tests/wiki/types.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Create the types module**

```typescript
// packages/standalone/src/wiki/types.ts

export const WIKI_PAGE_TYPES = ['entity', 'lesson', 'synthesis', 'process'] as const;
export type WikiPageType = (typeof WIKI_PAGE_TYPES)[number];

export function isValidPageType(type: string): type is WikiPageType {
  return (WIKI_PAGE_TYPES as readonly string[]).includes(type);
}

export interface WikiPage {
  /** Relative path within wiki dir (e.g. "projects/ProjectAlpha.md") */
  path: string;
  title: string;
  type: WikiPageType;
  content: string;
  /** Decision IDs this page was compiled from */
  sourceIds: string[];
  /** ISO 8601 timestamp */
  compiledAt: string;
  confidence: 'high' | 'medium' | 'low';
}

export interface WikiConfig {
  /** Absolute path to Obsidian vault root */
  vaultPath: string;
  /** Subdirectory within vault for compiled wiki (default: "wiki") */
  wikiDir: string;
  /** Whether wiki compilation is enabled */
  enabled: boolean;
}

export interface CompilationResult {
  pages: WikiPage[];
  indexUpdated: boolean;
  logEntry: string;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/standalone && npx vitest run tests/wiki/types.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/standalone/src/wiki/types.ts packages/standalone/tests/wiki/types.test.ts
git commit -m "feat(wiki): add types for wiki compilation — WikiPage, WikiConfig, CompilationResult"
```

---

### Task 3: ObsidianWriter — file I/O with frontmatter

**Files:**

- Create: `packages/standalone/src/wiki/obsidian-writer.ts`
- Test: `packages/standalone/tests/wiki/obsidian-writer.test.ts`

- [ ] **Step 1: Write the tests**

```typescript
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ObsidianWriter } from '../../src/wiki/obsidian-writer.js';
import type { WikiPage } from '../../src/wiki/types.js';

let tempDir: string;
let wikiDir: string;

describe('ObsidianWriter', () => {
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'obsidian-writer-test-'));
    wikiDir = join(tempDir, 'wiki');
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('creates wiki directory if not exists', () => {
    const writer = new ObsidianWriter(tempDir, 'wiki');
    writer.ensureDirectories();
    expect(readFileSync(join(wikiDir, 'index.md'), 'utf8')).toContain('# Wiki Index');
  });

  it('writes a page with frontmatter', () => {
    const writer = new ObsidianWriter(tempDir, 'wiki');
    writer.ensureDirectories();
    const page: WikiPage = {
      path: 'projects/ProjectAlpha.md',
      title: 'ProjectAlpha',
      type: 'entity',
      content: '## Current Status\n\nIn progress.',
      sourceIds: ['d_123', 'd_456'],
      compiledAt: '2026-04-08T12:00:00Z',
      confidence: 'high',
    };
    writer.writePage(page);

    const content = readFileSync(join(wikiDir, 'projects', 'ProjectAlpha.md'), 'utf8');
    expect(content).toContain('---');
    expect(content).toContain('title: ProjectAlpha');
    expect(content).toContain('type: entity');
    expect(content).toContain('confidence: high');
    expect(content).toContain('source_ids:');
    expect(content).toContain('## Current Status');
  });

  it('updates existing page preserving human sections', () => {
    const writer = new ObsidianWriter(tempDir, 'wiki');
    writer.ensureDirectories();
    // Write initial page
    const page: WikiPage = {
      path: 'projects/ProjectAlpha.md',
      title: 'ProjectAlpha',
      type: 'entity',
      content: '## Status\n\nDraft.',
      sourceIds: ['d_123'],
      compiledAt: '2026-04-08T12:00:00Z',
      confidence: 'medium',
    };
    writer.writePage(page);

    // Simulate human adding a section
    const filePath = join(wikiDir, 'projects', 'ProjectAlpha.md');
    const existing = readFileSync(filePath, 'utf8');
    writeFileSync(
      filePath,
      existing + '\n\n<!-- human -->\n## My Notes\n\nImportant context.\n',
      'utf8'
    );

    // Re-compile with updated content
    const updated: WikiPage = {
      ...page,
      content: '## Status\n\nCompleted!',
      compiledAt: '2026-04-08T14:00:00Z',
      confidence: 'high',
    };
    writer.writePage(updated);

    const result = readFileSync(filePath, 'utf8');
    expect(result).toContain('## Status\n\nCompleted!');
    expect(result).toContain('## My Notes');
    expect(result).toContain('Important context.');
  });

  it('appends to log.md', () => {
    const writer = new ObsidianWriter(tempDir, 'wiki');
    writer.ensureDirectories();
    writer.appendLog('compile', 'Compiled 3 entity pages for ProjectAlpha');

    const log = readFileSync(join(wikiDir, 'log.md'), 'utf8');
    expect(log).toContain('compile');
    expect(log).toContain('Compiled 3 entity pages');
  });

  it('updates index.md', () => {
    const writer = new ObsidianWriter(tempDir, 'wiki');
    writer.ensureDirectories();
    const page: WikiPage = {
      path: 'projects/ProjectAlpha.md',
      title: 'ProjectAlpha',
      type: 'entity',
      content: 'Content.',
      sourceIds: ['d_1'],
      compiledAt: '2026-04-08T12:00:00Z',
      confidence: 'high',
    };
    writer.writePage(page);
    writer.updateIndex([page]);

    const index = readFileSync(join(wikiDir, 'index.md'), 'utf8');
    expect(index).toContain('[[projects/ProjectAlpha|ProjectAlpha]]');
    expect(index).toContain('entity');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/standalone && npx vitest run tests/wiki/obsidian-writer.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement ObsidianWriter**

```typescript
// packages/standalone/src/wiki/obsidian-writer.ts

import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'fs';
import { join, dirname } from 'path';
import type { WikiPage } from './types.js';

const HUMAN_MARKER = '<!-- human -->';

export class ObsidianWriter {
  private readonly wikiPath: string;

  constructor(
    private readonly vaultPath: string,
    private readonly wikiDir: string = 'wiki'
  ) {
    this.wikiPath = join(vaultPath, wikiDir);
  }

  ensureDirectories(): void {
    for (const sub of ['', 'projects', 'lessons', 'synthesis']) {
      const dir = join(this.wikiPath, sub);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    }
    // Seed index.md and log.md if missing
    const indexPath = join(this.wikiPath, 'index.md');
    if (!existsSync(indexPath)) {
      writeFileSync(indexPath, '# Wiki Index\n\nAuto-compiled by MAMA.\n\n## Pages\n\n', 'utf8');
    }
    const logPath = join(this.wikiPath, 'log.md');
    if (!existsSync(logPath)) {
      writeFileSync(logPath, '# Compilation Log\n\n', 'utf8');
    }
  }

  writePage(page: WikiPage): void {
    const filePath = join(this.wikiPath, page.path);
    const dir = dirname(filePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    // Preserve human sections if file exists
    let humanSection = '';
    if (existsSync(filePath)) {
      const existing = readFileSync(filePath, 'utf8');
      const markerIdx = existing.indexOf(HUMAN_MARKER);
      if (markerIdx !== -1) {
        humanSection = existing.slice(markerIdx);
      }
    }

    const frontmatter = [
      '---',
      `title: ${page.title}`,
      `type: ${page.type}`,
      `confidence: ${page.confidence}`,
      `compiled_at: ${page.compiledAt}`,
      `source_ids:`,
      ...page.sourceIds.map((id) => `  - ${id}`),
      '---',
    ].join('\n');

    let body = `${frontmatter}\n\n# ${page.title}\n\n${page.content}`;
    if (humanSection) {
      body += '\n\n' + humanSection;
    }

    writeFileSync(filePath, body, 'utf8');
  }

  appendLog(action: string, message: string): void {
    const logPath = join(this.wikiPath, 'log.md');
    const date = new Date().toISOString().split('T')[0];
    const entry = `## [${date}] ${action} | ${message}\n\n`;
    appendFileSync(logPath, entry, 'utf8');
  }

  updateIndex(pages: WikiPage[]): void {
    const indexPath = join(this.wikiPath, 'index.md');
    const lines = ['# Wiki Index\n', 'Auto-compiled by MAMA.\n', '## Pages\n'];

    // Group by type
    const byType = new Map<string, WikiPage[]>();
    for (const p of pages) {
      const list = byType.get(p.type) || [];
      list.push(p);
      byType.set(p.type, list);
    }

    for (const [type, typePages] of byType) {
      lines.push(`### ${type.charAt(0).toUpperCase() + type.slice(1)}\n`);
      for (const p of typePages) {
        const link = p.path.replace(/\.md$/, '');
        lines.push(`- [[${link}|${p.title}]] — ${p.type}, confidence: ${p.confidence}`);
      }
      lines.push('');
    }

    writeFileSync(indexPath, lines.join('\n'), 'utf8');
  }

  getWikiPath(): string {
    return this.wikiPath;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/standalone && npx vitest run tests/wiki/obsidian-writer.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add packages/standalone/src/wiki/obsidian-writer.ts packages/standalone/tests/wiki/obsidian-writer.test.ts
git commit -m "feat(wiki): ObsidianWriter — writes pages with frontmatter, preserves human sections"
```

---

### Task 4: WikiCompiler — compilation prompt + LLM integration

**Files:**

- Create: `packages/standalone/src/wiki/wiki-compiler.ts`
- Test: `packages/standalone/tests/wiki/wiki-compiler.test.ts`

- [ ] **Step 1: Write the tests**

````typescript
import { describe, expect, it } from 'vitest';
import { buildCompilationPrompt, parseCompilationResponse } from '../../src/wiki/wiki-compiler.js';

const SAMPLE_DECISIONS = [
  {
    id: 'd_1',
    topic: 'project-alpha/sd_characterA',
    decision: 'ABC 모션 완성, 키포즈까지 완성됨',
    reasoning: '작업 진행 상태 변경',
    status: 'active',
    confidence: 0.9,
    updated_at: '2026-04-07T12:00:00Z',
  },
  {
    id: 'd_2',
    topic: 'project-alpha/sd_characterA',
    decision: 'UserA에게 확인 요청, 수신 확인됨',
    reasoning: '리뷰 단계 진입',
    status: 'active',
    confidence: 0.85,
    updated_at: '2026-04-07T13:00:00Z',
  },
];

describe('buildCompilationPrompt', () => {
  it('includes project name and decisions in prompt', () => {
    const prompt = buildCompilationPrompt('ProjectAlpha', SAMPLE_DECISIONS);
    expect(prompt).toContain('ProjectAlpha');
    expect(prompt).toContain('ABC 모션 완성');
    expect(prompt).toContain('UserA에게 확인 요청');
  });

  it('instructs LLM to output JSON with pages array', () => {
    const prompt = buildCompilationPrompt('ProjectAlpha', SAMPLE_DECISIONS);
    expect(prompt).toContain('"pages"');
    expect(prompt).toContain('title');
    expect(prompt).toContain('content');
  });

  it('handles empty decisions', () => {
    const prompt = buildCompilationPrompt('EmptyProject', []);
    expect(prompt).toContain('EmptyProject');
    expect(prompt).toContain('no decisions');
  });
});

describe('parseCompilationResponse', () => {
  it('parses valid JSON response', () => {
    const response = JSON.stringify({
      pages: [
        {
          path: 'projects/ProjectAlpha.md',
          title: 'ProjectAlpha',
          type: 'entity',
          content: '## Status\n\nIn progress.',
          confidence: 'high',
        },
      ],
    });
    const result = parseCompilationResponse(response, ['d_1', 'd_2']);
    expect(result.pages).toHaveLength(1);
    expect(result.pages[0].title).toBe('ProjectAlpha');
    expect(result.pages[0].sourceIds).toEqual(['d_1', 'd_2']);
    expect(result.pages[0].compiledAt).toBeTruthy();
  });

  it('handles JSON wrapped in markdown code block', () => {
    const response =
      '```json\n{"pages": [{"path": "p.md", "title": "P", "type": "entity", "content": "text", "confidence": "medium"}]}\n```';
    const result = parseCompilationResponse(response, ['d_1']);
    expect(result.pages).toHaveLength(1);
  });

  it('returns empty pages for invalid response', () => {
    const result = parseCompilationResponse('not valid json', []);
    expect(result.pages).toEqual([]);
  });
});
````

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/standalone && npx vitest run tests/wiki/wiki-compiler.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement WikiCompiler**

````typescript
// packages/standalone/src/wiki/wiki-compiler.ts

import type { WikiPage, CompilationResult } from './types.js';
import { isValidPageType } from './types.js';

export interface DecisionForCompilation {
  id: string;
  topic: string;
  decision: string;
  reasoning?: string | null;
  status: string;
  confidence: number | null;
  updated_at: string;
}

export function buildCompilationPrompt(
  project: string,
  decisions: DecisionForCompilation[]
): string {
  if (decisions.length === 0) {
    return `Project "${project}" has no decisions to compile. Respond with: {"pages": []}`;
  }

  const decisionLines = decisions
    .map(
      (d, i) =>
        `${i + 1}. [${d.status}] ${d.topic}: ${d.decision}` +
        (d.reasoning ? ` (reason: ${d.reasoning})` : '') +
        ` — confidence: ${d.confidence ?? 'N/A'}, updated: ${d.updated_at}`
    )
    .join('\n');

  return `You are a knowledge compiler. Given a project's decisions from a memory database, compile them into wiki pages for human reading in Obsidian.

## Project: ${project}

## Decisions (${decisions.length} total)
${decisionLines}

## Output Format
Respond with a JSON object containing a "pages" array. Each page:
- "path": relative path (e.g. "projects/${project}.md")
- "title": page title
- "type": one of "entity", "lesson", "synthesis", "process"
- "content": markdown content (NO frontmatter — system adds it)
- "confidence": "high", "medium", or "low"

## Compilation Rules
1. Create ONE entity page for the project with current status, timeline, and key decisions
2. If you find lessons or patterns, create separate lesson pages
3. Use [[wikilinks]] to reference other potential pages
4. Write in the same language as the decisions (Korean/Japanese/English)
5. Synthesize, don't list — the goal is human understanding, not data dump
6. Include a "## Timeline" section with key events in reverse chronological order

Respond ONLY with the JSON object. No explanation.`;
}

export function parseCompilationResponse(response: string, sourceIds: string[]): CompilationResult {
  const now = new Date().toISOString();

  // Strip markdown code block wrapper if present
  let cleaned = response.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
  }

  try {
    const parsed = JSON.parse(cleaned) as {
      pages?: Array<{
        path: string;
        title: string;
        type: string;
        content: string;
        confidence?: string;
      }>;
    };

    if (!parsed.pages || !Array.isArray(parsed.pages)) {
      return { pages: [], indexUpdated: false, logEntry: 'No pages in response' };
    }

    const pages: WikiPage[] = parsed.pages
      .filter((p) => p.path && p.title && p.content)
      .map((p) => ({
        path: p.path,
        title: p.title,
        type: isValidPageType(p.type) ? p.type : 'entity',
        content: p.content,
        sourceIds,
        compiledAt: now,
        confidence: (p.confidence as WikiPage['confidence']) || 'medium',
      }));

    return {
      pages,
      indexUpdated: pages.length > 0,
      logEntry: `Compiled ${pages.length} pages`,
    };
  } catch {
    return { pages: [], indexUpdated: false, logEntry: 'Failed to parse LLM response' };
  }
}
````

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/standalone && npx vitest run tests/wiki/wiki-compiler.test.ts`
Expected: PASS (7 tests)

- [ ] **Step 5: Commit**

```bash
git add packages/standalone/src/wiki/wiki-compiler.ts packages/standalone/tests/wiki/wiki-compiler.test.ts
git commit -m "feat(wiki): WikiCompiler — compilation prompt builder and response parser"
```

---

### Task 5: AgentEventBus — cross-agent event system

**Files:**

- Create: `packages/standalone/src/multi-agent/agent-event-bus.ts`
- Test: `packages/standalone/tests/multi-agent/agent-event-bus.test.ts`

- [ ] **Step 1: Write the tests**

```typescript
import { describe, expect, it, vi } from 'vitest';
import { AgentEventBus, type AgentEvent } from '../../src/multi-agent/agent-event-bus.js';

describe('AgentEventBus', () => {
  it('emits and receives events', () => {
    const bus = new AgentEventBus();
    const handler = vi.fn();
    bus.on('memory:saved', handler);
    bus.emit({ type: 'memory:saved', topic: 'auth', project: 'MAMA' });
    expect(handler).toHaveBeenCalledWith({ type: 'memory:saved', topic: 'auth', project: 'MAMA' });
  });

  it('supports multiple listeners per event', () => {
    const bus = new AgentEventBus();
    const h1 = vi.fn();
    const h2 = vi.fn();
    bus.on('memory:saved', h1);
    bus.on('memory:saved', h2);
    bus.emit({ type: 'memory:saved', topic: 'db' });
    expect(h1).toHaveBeenCalled();
    expect(h2).toHaveBeenCalled();
  });

  it('does not call handlers for other event types', () => {
    const bus = new AgentEventBus();
    const handler = vi.fn();
    bus.on('wiki:compiled', handler);
    bus.emit({ type: 'memory:saved', topic: 'x' });
    expect(handler).not.toHaveBeenCalled();
  });

  it('off removes a listener', () => {
    const bus = new AgentEventBus();
    const handler = vi.fn();
    bus.on('memory:saved', handler);
    bus.off('memory:saved', handler);
    bus.emit({ type: 'memory:saved', topic: 'x' });
    expect(handler).not.toHaveBeenCalled();
  });

  it('debounced emit coalesces rapid events', async () => {
    const bus = new AgentEventBus();
    const handler = vi.fn();
    bus.on('memory:saved', handler);
    bus.emitDebounced({ type: 'memory:saved', topic: 'a' }, 50);
    bus.emitDebounced({ type: 'memory:saved', topic: 'b' }, 50);
    bus.emitDebounced({ type: 'memory:saved', topic: 'c' }, 50);
    expect(handler).not.toHaveBeenCalled();
    await new Promise((r) => setTimeout(r, 80));
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith({ type: 'memory:saved', topic: 'c' });
  });

  it('handles async listeners without blocking', async () => {
    const bus = new AgentEventBus();
    const order: string[] = [];
    bus.on('memory:saved', async () => {
      await new Promise((r) => setTimeout(r, 10));
      order.push('async');
    });
    bus.emit({ type: 'memory:saved', topic: 'x' });
    order.push('after-emit');
    expect(order).toEqual(['after-emit']);
    await new Promise((r) => setTimeout(r, 30));
    expect(order).toEqual(['after-emit', 'async']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/standalone && npx vitest run tests/multi-agent/agent-event-bus.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement AgentEventBus**

```typescript
// packages/standalone/src/multi-agent/agent-event-bus.ts

export type AgentEvent =
  | { type: 'memory:saved'; topic: string; project?: string }
  | { type: 'extraction:completed'; projects: string[] }
  | { type: 'wiki:compiled'; pages: string[] }
  | { type: 'dashboard:refresh' };

export type AgentEventType = AgentEvent['type'];
type EventHandler = (event: AgentEvent) => void | Promise<void>;

export class AgentEventBus {
  private listeners = new Map<AgentEventType, Set<EventHandler>>();
  private debounceTimers = new Map<AgentEventType, ReturnType<typeof setTimeout>>();

  on(type: AgentEventType, handler: EventHandler): void {
    if (!this.listeners.has(type)) {
      this.listeners.set(type, new Set());
    }
    this.listeners.get(type)!.add(handler);
  }

  off(type: AgentEventType, handler: EventHandler): void {
    this.listeners.get(type)?.delete(handler);
  }

  emit(event: AgentEvent): void {
    const handlers = this.listeners.get(event.type);
    if (!handlers) return;
    for (const handler of handlers) {
      try {
        const result = handler(event);
        // Fire-and-forget for async handlers
        if (result && typeof (result as Promise<void>).catch === 'function') {
          (result as Promise<void>).catch((err) =>
            console.error(`[EventBus] Handler error for ${event.type}:`, err)
          );
        }
      } catch (err) {
        console.error(`[EventBus] Sync handler error for ${event.type}:`, err);
      }
    }
  }

  emitDebounced(event: AgentEvent, delayMs: number): void {
    const existing = this.debounceTimers.get(event.type);
    if (existing) clearTimeout(existing);
    this.debounceTimers.set(
      event.type,
      setTimeout(() => {
        this.debounceTimers.delete(event.type);
        this.emit(event);
      }, delayMs)
    );
  }

  destroy(): void {
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();
    this.listeners.clear();
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/standalone && npx vitest run tests/multi-agent/agent-event-bus.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add packages/standalone/src/multi-agent/agent-event-bus.ts packages/standalone/tests/multi-agent/agent-event-bus.test.ts
git commit -m "feat(multi-agent): AgentEventBus — cross-agent event system with debounce"
```

---

### Task 6: Wiki Agent persona

**Files:**

- Create: `packages/standalone/src/multi-agent/wiki-agent-persona.ts`

- [ ] **Step 1: Create the persona module** (follows memory-agent-persona.ts pattern)

```typescript
// packages/standalone/src/multi-agent/wiki-agent-persona.ts

import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const MANAGED_WIKI_PERSONA_MARKER = '<!-- MAMA managed wiki persona v1 -->';

export const WIKI_AGENT_PERSONA = `${MANAGED_WIKI_PERSONA_MARKER}

You are MAMA's Wiki Compiler — an internal agent that transforms structured decisions from the memory database into human-readable Obsidian wiki pages.

## Your Role
- Read project decisions via mama_search
- Compile them into wiki pages that humans can understand at a glance
- Write pages via wiki_publish
- Maintain index and log files

## Tools
- **mama_search**(query, limit?) — Search decisions. Always search by project scope first.
- **wiki_publish**(pages: [{path, title, type, content, confidence}]) — Publish compiled pages to Obsidian vault.

## Page Types
- **entity**: Project/person/client page with status, timeline, key decisions
- **lesson**: Extracted pattern or learning from multiple decisions
- **synthesis**: Cross-project analysis or weekly summary
- **process**: Workflow or procedure derived from observed patterns

## Compilation Rules
1. SYNTHESIZE, don't list — the goal is human understanding, not data dump
2. Write in the same language as the decisions (Korean/Japanese/English)
3. Use [[wikilinks]] to reference related pages
4. Include a "## Timeline" section with key events in reverse chronological order
5. Add a "## Key Decisions" section summarizing active decisions
6. Flag contradictions or stale information explicitly
7. Keep pages focused — one project per entity page

## HTML/Markdown Rules
- Pure markdown only (no HTML)
- Use YAML frontmatter: title, type, confidence, compiled_at
- Headings: ## for sections, ### for subsections

## Strict Limits
- Call mama_search at most 3 times per compilation run
- Call wiki_publish exactly once with all pages
- Do NOT ask follow-up questions
- After publishing, respond with exactly: DONE`;

export function ensureWikiPersona(mamaHomeDir: string = join(homedir(), '.mama')): string {
  const personaDir = join(mamaHomeDir, 'personas');
  const personaPath = join(personaDir, 'wiki.md');

  if (!existsSync(personaDir)) {
    mkdirSync(personaDir, { recursive: true });
  }

  if (!existsSync(personaPath)) {
    writeFileSync(personaPath, WIKI_AGENT_PERSONA, 'utf-8');
    return personaPath;
  }

  const existingContent = readFileSync(personaPath, 'utf-8');
  if (
    existingContent.includes(MANAGED_WIKI_PERSONA_MARKER) &&
    existingContent !== WIKI_AGENT_PERSONA
  ) {
    writeFileSync(personaPath, WIKI_AGENT_PERSONA, 'utf-8');
  }

  return personaPath;
}
```

- [ ] **Step 2: Build to verify**

Run: `pnpm build`
Expected: 0 errors

- [ ] **Step 3: Commit**

```bash
git add packages/standalone/src/multi-agent/wiki-agent-persona.ts
git commit -m "feat(multi-agent): Wiki Agent persona — compile decisions into Obsidian wiki"
```

---

### Task 7: Wire Wiki Agent + EventBus in start.ts

**Files:**

- Modify: `packages/standalone/src/cli/commands/start.ts`

- [ ] **Step 1: Add AgentEventBus initialization** (near other agent setup, ~line 2540)

After dashboard agent setup, add:

```typescript
// === Agent Event Bus ===
const { AgentEventBus } = await import('../../multi-agent/agent-event-bus.js');
const eventBus = new AgentEventBus();

// === Wiki Agent ===
const wikiConfig = config.wiki as
  | { enabled?: boolean; vaultPath?: string; wikiDir?: string }
  | undefined;

if (wikiConfig?.enabled && wikiConfig.vaultPath) {
  const { ensureWikiPersona } = await import('../../multi-agent/wiki-agent-persona.js');
  const { ObsidianWriter } = await import('../../wiki/obsidian-writer.js');
  const { parseCompilationResponse } = await import('../../wiki/wiki-compiler.js');

  const wikiPersonaPath = ensureWikiPersona();
  const wikiPersona = readFileSync(wikiPersonaPath, 'utf-8');
  const obsWriter = new ObsidianWriter(wikiConfig.vaultPath, wikiConfig.wikiDir || 'wiki');
  obsWriter.ensureDirectories();
  console.log(`[Wiki Agent] Persona loaded from ${wikiPersonaPath}`);
  console.log(`[Wiki Agent] Vault: ${obsWriter.getWikiPath()}`);

  // wiki_publish tool handler
  const wikiToolExecutor = toolExecutor;
  wikiToolExecutor.setWikiPublisher((pages) => {
    for (const page of pages) {
      obsWriter.writePage(page);
    }
    if (pages.length > 0) {
      obsWriter.updateIndex(pages);
      obsWriter.appendLog('compile', `Published ${pages.length} pages`);
    }
    console.log(`[Wiki Agent] Published ${pages.length} pages`);
    eventBus.emit({ type: 'wiki:compiled', pages: pages.map((p) => p.path) });
  });

  const wikiAgentLoop = new AgentLoop(
    oauthManager,
    {
      useCodeAct: true,
      disallowedTools: [
        'Bash',
        'Read',
        'Write',
        'Edit',
        'Grep',
        'Glob',
        'Agent',
        'WebSearch',
        'WebFetch',
      ],
      systemPrompt: wikiPersona,
      model: 'claude-haiku-4-5-20251001',
      maxTurns: 5,
      backend: 'claude' as const,
      toolsConfig: { gateway: ['mama_search', 'wiki_publish'], mcp: [] },
    },
    undefined,
    { mamaApi: mamaApi as MAMAApiInterface }
  );
  wikiAgentLoop.setSessionKey('wiki-agent:shared');

  const wikiAgentContext: AgentContext = {
    source: 'wiki-agent',
    platform: 'cli',
    roleName: 'wiki_agent',
    role: {
      allowedTools: ['mama_search', 'wiki_publish'],
      blockedTools: ['Read', 'Write', 'Bash', 'Grep', 'Glob', 'Edit'],
      systemControl: false,
      sensitiveAccess: false,
    },
    session: { sessionId: 'wiki-agent:shared', channelId: 'system', startedAt: new Date() },
    capabilities: ['mama_search', 'wiki_publish'],
    limitations: ['No file or shell access'],
    tier: 2,
    backend: 'claude',
  };

  const runWikiAgent = async () => {
    try {
      console.log('[Wiki Agent] Starting compilation...');
      await wikiAgentLoop.run(
        'Search for recent decisions across all projects using mama_search, then compile them into wiki pages and publish with wiki_publish.',
        {
          source: 'wiki-agent',
          channelId: 'system',
          agentContext: wikiAgentContext,
          stopAfterSuccessfulTools: ['wiki_publish'],
        }
      );
      console.log('[Wiki Agent] Compilation complete');
    } catch (err) {
      console.error('[Wiki Agent] Error:', err instanceof Error ? err.message : err);
    }
  };

  // Event-driven: compile on memory save (debounced 5 min)
  eventBus.on('memory:saved', () => {
    eventBus.emitDebounced({ type: 'extraction:completed', projects: [] }, 5 * 60 * 1000);
  });
  eventBus.on('extraction:completed', () => runWikiAgent());

  // Also run nightly via cron
  scheduler.addJob({
    id: 'wiki-compile-nightly',
    name: 'Wiki Nightly Compilation',
    cronExpr: '0 22 * * *',
    prompt: '__wiki_compile__',
    enabled: true,
  });

  // Manual trigger API
  apiServer.app.post('/api/wiki/compile', requireAuth, async (_req, res) => {
    runWikiAgent().catch(() => {});
    res.json({ ok: true, message: 'Wiki compilation triggered' });
  });
}

// Wire memory:saved events from memory agent saves
// (emit after mama_save succeeds in message-router or tool-executor)
```

- [ ] **Step 2: Build to verify**

Run: `pnpm build`
Expected: 0 errors

- [ ] **Step 3: Run full test suite**

Run: `pnpm test`
Expected: All tests pass

- [ ] **Step 4: Commit**

```bash
git add packages/standalone/src/cli/commands/start.ts
git commit -m "feat(wiki): Wiki Agent + EventBus wiring — event-driven compilation + nightly cron"
```

---

### Task 8: Config schema + Obsidian connector setup

**Files:**

- Modify: `~/.mama/config.yaml` (runtime config, not committed)
- Modify: `~/.mama/connectors.json` (runtime config, not committed)

- [ ] **Step 1: Add wiki config to config.yaml**

Append to `~/.mama/config.yaml`:

```yaml
wiki:
  enabled: true
  vaultPath: /Users/jeongjaehun/obsidian-vault
  wikiDir: mama-wiki
```

(User should create or specify their actual vault path)

- [ ] **Step 2: Enable Obsidian connector for feedback loop**

Add to `~/.mama/connectors.json`:

```json
"obsidian": {
  "enabled": true,
  "pollIntervalMinutes": 60,
  "channels": {
    "mama-wiki": {
      "role": "spoke",
      "name": "mama-wiki",
      "vaultPath": "/Users/jeongjaehun/obsidian-vault"
    }
  },
  "auth": { "type": "none" }
}
```

- [ ] **Step 3: Create vault directory and verify**

```bash
mkdir -p /Users/jeongjaehun/obsidian-vault
mama stop && mama start
mama status
tail -20 ~/.mama/logs/daemon.log | grep -i wiki
```

- [ ] **Step 4: Test manual compilation trigger**

```bash
curl -s -X POST http://localhost:3847/api/wiki/compile | python3 -m json.tool
# Wait 10s, then check vault
ls ~/.mama/obsidian-vault/mama-wiki/ 2>/dev/null || ls /Users/jeongjaehun/obsidian-vault/mama-wiki/
```

---

### Task 9: Integration test — end-to-end compilation

**Files:**

- Create: `packages/standalone/tests/wiki/integration.test.ts`

- [ ] **Step 1: Write the integration test**

```typescript
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ObsidianWriter } from '../../src/wiki/obsidian-writer.js';
import { buildCompilationPrompt, parseCompilationResponse } from '../../src/wiki/wiki-compiler.js';
import type { WikiPage } from '../../src/wiki/types.js';

let tempDir: string;

describe('Wiki compilation integration', () => {
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'wiki-integration-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('full pipeline: prompt → parse → write → read', () => {
    // 1. Build prompt
    const decisions = [
      {
        id: 'd_1',
        topic: 'testproj/feature',
        decision: 'Chose React over Vue',
        reasoning: 'Team familiarity',
        status: 'active',
        confidence: 0.95,
        updated_at: '2026-04-08T10:00:00Z',
      },
    ];
    const prompt = buildCompilationPrompt('TestProject', decisions);
    expect(prompt).toContain('TestProject');

    // 2. Simulate LLM response
    const llmResponse = JSON.stringify({
      pages: [
        {
          path: 'projects/TestProject.md',
          title: 'TestProject',
          type: 'entity',
          content: '## Overview\n\nA test project.\n\n## Timeline\n\n- 04/08: Chose React over Vue',
          confidence: 'high',
        },
      ],
    });

    // 3. Parse response
    const result = parseCompilationResponse(llmResponse, ['d_1']);
    expect(result.pages).toHaveLength(1);

    // 4. Write to vault
    const writer = new ObsidianWriter(tempDir, 'wiki');
    writer.ensureDirectories();
    for (const page of result.pages) {
      writer.writePage(page);
    }
    writer.updateIndex(result.pages);
    writer.appendLog('compile', result.logEntry);

    // 5. Verify files
    const pageContent = readFileSync(join(tempDir, 'wiki', 'projects', 'TestProject.md'), 'utf8');
    expect(pageContent).toContain('title: TestProject');
    expect(pageContent).toContain('type: entity');
    expect(pageContent).toContain('Chose React over Vue');

    const index = readFileSync(join(tempDir, 'wiki', 'index.md'), 'utf8');
    expect(index).toContain('TestProject');

    const log = readFileSync(join(tempDir, 'wiki', 'log.md'), 'utf8');
    expect(log).toContain('compile');
  });

  it('preserves human sections across recompilation', () => {
    const writer = new ObsidianWriter(tempDir, 'wiki');
    writer.ensureDirectories();

    // First compilation
    const page1: WikiPage = {
      path: 'projects/A.md',
      title: 'Project A',
      type: 'entity',
      content: '## Status\n\nDraft.',
      sourceIds: ['d_1'],
      compiledAt: '2026-04-08T10:00:00Z',
      confidence: 'medium',
    };
    writer.writePage(page1);

    // Human adds notes
    const filePath = join(tempDir, 'wiki', 'projects', 'A.md');
    const existing = readFileSync(filePath, 'utf8');
    const withHuman =
      existing + '\n\n<!-- human -->\n## My Observations\n\nThis project needs attention.\n';
    require('fs').writeFileSync(filePath, withHuman, 'utf8');

    // Recompilation
    const page2: WikiPage = {
      ...page1,
      content: '## Status\n\nCompleted!',
      compiledAt: '2026-04-08T14:00:00Z',
      confidence: 'high',
    };
    writer.writePage(page2);

    const result = readFileSync(filePath, 'utf8');
    expect(result).toContain('Completed!');
    expect(result).toContain('My Observations');
    expect(result).toContain('This project needs attention.');
    expect(result).toContain('confidence: high');
  });
});
```

- [ ] **Step 2: Run tests**

Run: `cd packages/standalone && npx vitest run tests/wiki/integration.test.ts`
Expected: PASS

- [ ] **Step 3: Run full test suite**

Run: `pnpm build && pnpm test`
Expected: All tests pass

- [ ] **Step 4: Commit**

```bash
git add packages/standalone/tests/wiki/integration.test.ts
git commit -m "test(wiki): integration test — full compilation pipeline + human section preservation"
```

---

## Verification Checklist

After all tasks complete:

- [ ] `pnpm build` — 0 errors
- [ ] `pnpm test` — all pass
- [ ] `mama stop && mama start` — starts without errors
- [ ] `tail -50 ~/.mama/logs/daemon.log | grep -i wiki` — "Wiki Agent" persona loaded message
- [ ] `curl -s -X POST http://localhost:3847/api/wiki/compile` — manual trigger works
- [ ] After compilation, `.md` files appear in vault wiki directory with frontmatter
- [ ] Obsidian opens vault and shows compiled pages with graph view
- [ ] Adding `<!-- human -->` section to a compiled page survives recompilation
- [ ] Memory agent `mama_save` → EventBus `memory:saved` → Wiki Agent triggers (debounced 5min)
- [ ] Dashboard agent refreshes after `wiki:compiled` event
