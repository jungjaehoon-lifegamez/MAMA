import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
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

    const result = parseCompilationResponse(llmResponse, ['d_1']);
    expect(result.pages).toHaveLength(1);

    const writer = new ObsidianWriter(tempDir, 'wiki');
    writer.ensureDirectories();
    for (const page of result.pages) {
      writer.writePage(page);
    }
    writer.updateIndex(result.pages);
    writer.appendLog('compile', result.logEntry);

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

    const filePath = join(tempDir, 'wiki', 'projects', 'A.md');
    const existing = readFileSync(filePath, 'utf8');
    writeFileSync(
      filePath,
      existing + '\n\n<!-- human -->\n## My Observations\n\nThis project needs attention.\n',
      'utf8'
    );

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

  it('handles multiple projects in one compilation', () => {
    const writer = new ObsidianWriter(tempDir, 'wiki');
    writer.ensureDirectories();

    const pages: WikiPage[] = [
      {
        path: 'projects/Alpha.md',
        title: 'Alpha',
        type: 'entity',
        content: '## Alpha project',
        sourceIds: ['d_1'],
        compiledAt: '2026-04-08T12:00:00Z',
        confidence: 'high',
      },
      {
        path: 'projects/Beta.md',
        title: 'Beta',
        type: 'entity',
        content: '## Beta project',
        sourceIds: ['d_2'],
        compiledAt: '2026-04-08T12:00:00Z',
        confidence: 'medium',
      },
      {
        path: 'lessons/testing-matters.md',
        title: 'Testing Matters',
        type: 'lesson',
        content: '## Lesson\n\nAlways write tests.',
        sourceIds: ['d_3'],
        compiledAt: '2026-04-08T12:00:00Z',
        confidence: 'high',
      },
    ];

    for (const page of pages) {
      writer.writePage(page);
    }
    writer.updateIndex(pages);

    const index = readFileSync(join(tempDir, 'wiki', 'index.md'), 'utf8');
    expect(index).toContain('Alpha');
    expect(index).toContain('Beta');
    expect(index).toContain('Testing Matters');
    expect(index).toContain('### Entity');
    expect(index).toContain('### Lesson');
  });
});
