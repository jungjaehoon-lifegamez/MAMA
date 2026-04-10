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

  it('filters out pages with missing required fields', () => {
    const response = JSON.stringify({
      pages: [
        { path: 'a.md', title: 'A', type: 'entity', content: 'ok', confidence: 'high' },
        { path: '', title: 'B', type: 'entity', content: 'missing path' },
        { path: 'c.md', title: '', type: 'entity', content: 'missing title' },
      ],
    });
    const result = parseCompilationResponse(response, ['d_1']);
    expect(result.pages).toHaveLength(1);
    expect(result.pages[0].title).toBe('A');
  });

  it('defaults invalid page type to entity', () => {
    const response = JSON.stringify({
      pages: [{ path: 'a.md', title: 'A', type: 'garbage', content: 'text' }],
    });
    const result = parseCompilationResponse(response, []);
    expect(result.pages[0].type).toBe('entity');
  });
});
