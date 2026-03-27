import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import {
  buildExtractionPrompt,
  parseExtractionResponse,
} from '../../src/memory/extraction-prompt.js';
import { ingestConversation, recallMemory, setExtractionFn } from '../../src/memory/api.js';
import type { ConversationMessage } from '../../src/memory/types.js';
import fs from 'node:fs';

describe('extraction-prompt', () => {
  const sampleMessages: ConversationMessage[] = [
    { role: 'user', content: 'I just bought a Sony A7IV camera.' },
    { role: 'assistant', content: 'Great choice! The Sony A7IV is excellent.' },
    { role: 'user', content: 'I prefer Sony-compatible lenses over third-party ones.' },
  ];

  describe('buildExtractionPrompt', () => {
    it('should include all conversation messages in the prompt', () => {
      const prompt = buildExtractionPrompt(sampleMessages);
      expect(prompt).toContain('Sony A7IV');
      expect(prompt).toContain('Sony-compatible lenses');
      expect(prompt).toContain('preference');
    });

    it('should include extraction instructions', () => {
      const prompt = buildExtractionPrompt(sampleMessages);
      expect(prompt).toContain('lowercase_snake_case');
      expect(prompt).toContain('JSON');
    });
  });

  describe('parseExtractionResponse', () => {
    it('should parse valid JSON array response', () => {
      const response = JSON.stringify([
        {
          kind: 'preference',
          topic: 'camera_lens_preference',
          summary: 'Prefers Sony-compatible lenses over third-party',
          details: 'User stated preference for Sony-compatible lenses.',
          confidence: 0.9,
        },
        {
          kind: 'fact',
          topic: 'camera_ownership',
          summary: 'Owns a Sony A7IV camera',
          details: 'User recently purchased a Sony A7IV.',
          confidence: 0.95,
        },
      ]);
      const result = parseExtractionResponse(response);
      expect(result).toHaveLength(2);
      expect(result[0].kind).toBe('preference');
      expect(result[0].topic).toBe('camera_lens_preference');
      expect(result[1].kind).toBe('fact');
    });

    it('should extract JSON from markdown code fences', () => {
      const response =
        'Here are the extracted units:\n```json\n[{"kind":"fact","topic":"test","summary":"s","details":"d","confidence":0.8}]\n```';
      const result = parseExtractionResponse(response);
      expect(result).toHaveLength(1);
      expect(result[0].topic).toBe('test');
    });

    it('should return empty array for invalid JSON', () => {
      const result = parseExtractionResponse('not json at all');
      expect(result).toEqual([]);
    });

    it('should return empty array for empty response', () => {
      const result = parseExtractionResponse('');
      expect(result).toEqual([]);
    });

    it('should filter out units with invalid kind', () => {
      const response = JSON.stringify([
        { kind: 'preference', topic: 'a', summary: 's', details: 'd', confidence: 0.9 },
        { kind: 'invalid_kind', topic: 'b', summary: 's', details: 'd', confidence: 0.5 },
      ]);
      const result = parseExtractionResponse(response);
      expect(result).toHaveLength(1);
      expect(result[0].kind).toBe('preference');
    });

    it('should filter out units missing required fields', () => {
      const response = JSON.stringify([
        { kind: 'fact', topic: 'valid', summary: 'yes', details: 'd', confidence: 0.8 },
        { kind: 'fact', summary: 'no topic' },
        { kind: 'fact', topic: 'no_summary' },
      ]);
      const result = parseExtractionResponse(response);
      expect(result).toHaveLength(1);
      expect(result[0].topic).toBe('valid');
    });

    it('should clamp confidence to 0-1 range', () => {
      const response = JSON.stringify([
        { kind: 'fact', topic: 'a', summary: 's', details: 'd', confidence: 1.5 },
        { kind: 'fact', topic: 'b', summary: 's', details: 'd', confidence: -0.3 },
      ]);
      const result = parseExtractionResponse(response);
      expect(result[0].confidence).toBe(1.0);
      expect(result[1].confidence).toBe(0.0);
    });
  });
});

const TEST_DB = '/tmp/test-memory-v2-extraction.db';

describe('ingestConversation', () => {
  beforeAll(() => {
    [TEST_DB, `${TEST_DB}-journal`, `${TEST_DB}-wal`, `${TEST_DB}-shm`].forEach((file) => {
      try {
        fs.unlinkSync(file);
      } catch {
        /* cleanup */
      }
    });
    process.env.MAMA_DB_PATH = TEST_DB;
  });

  afterAll(async () => {
    const { closeDB } = await import('../../src/db-manager.js');
    await closeDB();
    delete process.env.MAMA_DB_PATH;
    [TEST_DB, `${TEST_DB}-journal`, `${TEST_DB}-wal`, `${TEST_DB}-shm`].forEach((file) => {
      try {
        fs.unlinkSync(file);
      } catch {
        /* cleanup */
      }
    });
  });

  it('should save raw conversation when extraction is disabled', async () => {
    const result = await ingestConversation({
      messages: [
        { role: 'user', content: 'I like using TypeScript.' },
        { role: 'assistant', content: 'TypeScript is great for type safety.' },
      ],
      scopes: [{ kind: 'project', id: 'test:extraction' }],
      source: { package: 'mama-core', source_type: 'test' },
    });

    expect(result.rawId).toBeTruthy();
    expect(result.extractedMemories).toEqual([]);
  });

  it('should extract and save memory units when extraction is enabled', async () => {
    setExtractionFn(async () => [
      {
        kind: 'preference',
        topic: 'camera_brand_preference',
        summary: 'Prefers Sony cameras over Canon for autofocus quality',
        details: 'User stated preference for Sony over Canon. Reason: superior autofocus.',
        confidence: 0.9,
      },
      {
        kind: 'fact',
        topic: 'painting_projects_completed',
        summary: 'Completed 3 painting projects',
        details: 'User mentioned completing 3rd painting project.',
        confidence: 0.85,
      },
    ]);

    const result = await ingestConversation({
      messages: [
        { role: 'user', content: 'I prefer Sony cameras over Canon.' },
        { role: 'assistant', content: 'Sony has great autofocus.' },
        { role: 'user', content: 'I completed my 3rd painting project yesterday.' },
      ],
      scopes: [{ kind: 'user', id: 'test-user' }],
      source: { package: 'mama-core', source_type: 'test' },
      extract: { enabled: true },
    });

    expect(result.rawId).toBeTruthy();
    expect(result.extractedMemories).toHaveLength(2);
    expect(result.extractedMemories[0].kind).toBe('preference');
    expect(result.extractedMemories[0].topic).toBe('camera_brand_preference');
    expect(result.extractedMemories[1].kind).toBe('fact');

    // Verify preference is individually recallable
    const recall = await recallMemory('Sony camera preference', {
      scopes: [{ kind: 'user', id: 'test-user' }],
    });
    expect(recall.memories.some((m) => m.topic === 'camera_brand_preference')).toBe(true);
  });

  it('should still save raw conversation when extraction fails', async () => {
    setExtractionFn(async () => {
      throw new Error('LLM unavailable');
    });

    const result = await ingestConversation({
      messages: [{ role: 'user', content: 'Some conversation content.' }],
      scopes: [],
      source: { package: 'mama-core', source_type: 'test' },
      extract: { enabled: true },
    });

    expect(result.rawId).toBeTruthy();
    expect(result.extractedMemories).toEqual([]);
  });

  it('should throw when messages array is empty', async () => {
    await expect(
      ingestConversation({
        messages: [],
        scopes: [],
        source: { package: 'mama-core', source_type: 'test' },
      })
    ).rejects.toThrow('messages array must not be empty');
  });

  afterEach(() => {
    setExtractionFn(null);
  });
});
