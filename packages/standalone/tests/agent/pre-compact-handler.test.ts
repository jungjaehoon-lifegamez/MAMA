import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PreCompactHandler } from '../../src/agent/pre-compact-handler.js';

describe('PreCompactHandler', () => {
  let mockExecuteTool: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockExecuteTool = vi.fn();
  });

  describe('process() with empty conversation history', () => {
    it('should return empty result when conversation history is empty', async () => {
      const handler = new PreCompactHandler(mockExecuteTool, { enabled: true });
      const result = await handler.process([]);

      expect(result.unsavedDecisions).toEqual([]);
      expect(result.compactionPrompt).toBe('');
      expect(result.warningMessage).toBe('');
    });
  });

  describe('process() when disabled', () => {
    it('should return empty result when handler is disabled', async () => {
      const handler = new PreCompactHandler(mockExecuteTool, { enabled: false });
      const result = await handler.process(['some conversation']);

      expect(result.unsavedDecisions).toEqual([]);
      expect(result.compactionPrompt).toBe('');
      expect(result.warningMessage).toBe('');
    });
  });

  describe('Decision detection regex - English patterns', () => {
    it('should detect "decided:" pattern', async () => {
      const handler = new PreCompactHandler(mockExecuteTool, { enabled: true });
      mockExecuteTool.mockResolvedValue({ results: [] });

      const result = await handler.process(['We decided: use JWT for authentication in the API']);

      expect(result.unsavedDecisions).toContain('use JWT for authentication in the API');
    });

    it('should detect "decision:" pattern', async () => {
      const handler = new PreCompactHandler(mockExecuteTool, { enabled: true });
      mockExecuteTool.mockResolvedValue({ results: [] });

      const result = await handler.process(['The decision: implement OAuth2 with refresh tokens']);

      expect(result.unsavedDecisions).toContain('implement OAuth2 with refresh tokens');
    });

    it('should detect "chose:" pattern', async () => {
      const handler = new PreCompactHandler(mockExecuteTool, { enabled: true });
      mockExecuteTool.mockResolvedValue({ results: [] });

      const result = await handler.process(['We chose: PostgreSQL for the database']);

      expect(result.unsavedDecisions).toContain('PostgreSQL for the database');
    });

    it('should detect "we\'ll use:" pattern', async () => {
      const handler = new PreCompactHandler(mockExecuteTool, { enabled: true });
      mockExecuteTool.mockResolvedValue({ results: [] });

      const result = await handler.process(["We'll use: React with TypeScript for the frontend"]);

      expect(result.unsavedDecisions).toContain('React with TypeScript for the frontend');
    });

    it('should detect "going with:" pattern', async () => {
      const handler = new PreCompactHandler(mockExecuteTool, { enabled: true });
      mockExecuteTool.mockResolvedValue({ results: [] });

      const result = await handler.process(['Going with: microservices architecture']);

      expect(result.unsavedDecisions).toContain('microservices architecture');
    });

    it('should detect "approach:" pattern', async () => {
      const handler = new PreCompactHandler(mockExecuteTool, { enabled: true });
      mockExecuteTool.mockResolvedValue({ results: [] });

      const result = await handler.process(['Approach: implement caching layer with Redis']);

      expect(result.unsavedDecisions).toContain('implement caching layer with Redis');
    });

    it('should detect "architecture:" pattern', async () => {
      const handler = new PreCompactHandler(mockExecuteTool, { enabled: true });
      mockExecuteTool.mockResolvedValue({ results: [] });

      const result = await handler.process(['Architecture: event-driven with message queues']);

      expect(result.unsavedDecisions).toContain('event-driven with message queues');
    });

    it('should detect "strategy:" pattern', async () => {
      const handler = new PreCompactHandler(mockExecuteTool, { enabled: true });
      mockExecuteTool.mockResolvedValue({ results: [] });

      const result = await handler.process(['Strategy: blue-green deployment for zero downtime']);

      expect(result.unsavedDecisions).toContain('blue-green deployment for zero downtime');
    });
  });

  describe('Decision detection regex - Korean patterns', () => {
    it('should detect "선택:" pattern', async () => {
      const handler = new PreCompactHandler(mockExecuteTool, { enabled: true });
      mockExecuteTool.mockResolvedValue({ results: [] });

      const result = await handler.process(['선택: 데이터베이스로 MongoDB를 사용하기']);

      expect(result.unsavedDecisions).toContain('데이터베이스로 MongoDB를 사용하기');
    });

    it('should detect "결정:" pattern', async () => {
      const handler = new PreCompactHandler(mockExecuteTool, { enabled: true });
      mockExecuteTool.mockResolvedValue({ results: [] });

      const result = await handler.process(['결정: 프론트엔드는 Vue.js로 구현하기']);

      expect(result.unsavedDecisions).toContain('프론트엔드는 Vue.js로 구현하기');
    });

    it('should detect "설계:" pattern', async () => {
      const handler = new PreCompactHandler(mockExecuteTool, { enabled: true });
      mockExecuteTool.mockResolvedValue({ results: [] });

      const result = await handler.process(['설계: REST API 기반의 아키텍처']);

      expect(result.unsavedDecisions).toContain('REST API 기반의 아키텍처');
    });

    it('should detect "방식:" pattern', async () => {
      const handler = new PreCompactHandler(mockExecuteTool, { enabled: true });
      mockExecuteTool.mockResolvedValue({ results: [] });

      const result = await handler.process(['방식: 클라이언트 사이드 렌더링 사용']);

      expect(result.unsavedDecisions).toContain('클라이언트 사이드 렌더링 사용');
    });
  });

  describe('MAMA search integration', () => {
    it('should call executeTool with mama_search', async () => {
      const handler = new PreCompactHandler(mockExecuteTool, { enabled: true });
      mockExecuteTool.mockResolvedValue({ results: [] });

      await handler.process(['decided: use JWT tokens']);

      expect(mockExecuteTool).toHaveBeenCalledWith('mama_search', {
        type: 'decision',
        limit: 20,
      });
    });

    it('should extract topics from search results', async () => {
      const handler = new PreCompactHandler(mockExecuteTool, { enabled: true });
      mockExecuteTool.mockResolvedValue({
        results: [
          { topic: 'use JWT tokens', decision: 'JWT with refresh tokens' },
          { topic: 'database_choice', decision: 'PostgreSQL' },
        ],
      });

      const result = await handler.process(['decided: use JWT tokens']);

      expect(result.unsavedDecisions).toEqual([]);
    });

    it('should extract decisions from search results', async () => {
      const handler = new PreCompactHandler(mockExecuteTool, { enabled: true });
      mockExecuteTool.mockResolvedValue({
        results: [{ decision: 'use MongoDB for caching' }],
      });

      const result = await handler.process(['decided: use MongoDB for caching']);

      expect(result.unsavedDecisions).toEqual([]);
    });
  });

  describe('Filters out already-saved decisions', () => {
    it('should filter decisions that match saved topics', async () => {
      const handler = new PreCompactHandler(mockExecuteTool, { enabled: true });
      mockExecuteTool.mockResolvedValue({
        results: [{ topic: 'authentication' }],
      });

      const result = await handler.process([
        'decided: use JWT for authentication',
        'decided: implement rate limiting',
      ]);

      expect(result.unsavedDecisions).toContain('implement rate limiting');
      expect(result.unsavedDecisions).not.toContain('use JWT for authentication');
    });

    it('should perform case-insensitive matching', async () => {
      const handler = new PreCompactHandler(mockExecuteTool, { enabled: true });
      mockExecuteTool.mockResolvedValue({
        results: [{ topic: 'DATABASE' }],
      });

      const result = await handler.process(['decided: use database for storage']);

      expect(result.unsavedDecisions).toEqual([]);
    });

    it('should filter partial matches', async () => {
      const handler = new PreCompactHandler(mockExecuteTool, { enabled: true });
      mockExecuteTool.mockResolvedValue({
        results: [{ topic: 'JWT' }],
      });

      const result = await handler.process(['decided: use JWT tokens for auth']);

      expect(result.unsavedDecisions).toEqual([]);
    });
  });

  describe('Builds 7-section compaction prompt', () => {
    it('should include all 7 sections in compaction prompt', async () => {
      const handler = new PreCompactHandler(mockExecuteTool, { enabled: true });
      mockExecuteTool.mockResolvedValue({ results: [] });

      const result = await handler.process(['decided: use JWT']);

      expect(result.compactionPrompt).toContain('## 1. User Requests');
      expect(result.compactionPrompt).toContain('## 2. Final Goal');
      expect(result.compactionPrompt).toContain('## 3. Work Completed');
      expect(result.compactionPrompt).toContain('## 4. Remaining Tasks');
      expect(result.compactionPrompt).toContain('## 5. Active Working Context');
      expect(result.compactionPrompt).toContain('## 6. Explicit Constraints');
      expect(result.compactionPrompt).toContain('## 7. Agent Verification State');
    });

    it('should include header and instructions', async () => {
      const handler = new PreCompactHandler(mockExecuteTool, { enabled: true });
      mockExecuteTool.mockResolvedValue({ results: [] });

      const result = await handler.process(['decided: use JWT']);

      expect(result.compactionPrompt).toContain('# Compaction Summary');
      expect(result.compactionPrompt).toContain(
        'Before compressing context, preserve the following information'
      );
    });

    it('should include line count at the end', async () => {
      const handler = new PreCompactHandler(mockExecuteTool, { enabled: true });
      mockExecuteTool.mockResolvedValue({ results: [] });

      const result = await handler.process(['line1', 'line2', 'line3']);

      expect(result.compactionPrompt).toContain('Conversation context: ~3 lines before compaction');
    });
  });

  describe('Warning message format with unsaved decisions', () => {
    it('should include warning header', async () => {
      const handler = new PreCompactHandler(mockExecuteTool, { enabled: true });
      mockExecuteTool.mockResolvedValue({ results: [] });

      const result = await handler.process(['decided: use JWT tokens']);

      expect(result.warningMessage).toContain('[MAMA PreCompact Warning]');
    });

    it('should include decision count', async () => {
      const handler = new PreCompactHandler(mockExecuteTool, { enabled: true });
      mockExecuteTool.mockResolvedValue({ results: [] });

      const result = await handler.process(['decided: use JWT tokens']);

      expect(result.warningMessage).toContain('1 potential unsaved decision(s) detected');
    });

    it('should list unsaved decisions with numbers', async () => {
      const handler = new PreCompactHandler(mockExecuteTool, { enabled: true });
      mockExecuteTool.mockResolvedValue({ results: [] });

      const result = await handler.process([
        'decided: use JWT tokens',
        'decided: implement caching',
      ]);

      expect(result.warningMessage).toContain('1. use JWT tokens');
      expect(result.warningMessage).toContain('2. implement caching');
    });

    it('should include save instruction', async () => {
      const handler = new PreCompactHandler(mockExecuteTool, { enabled: true });
      mockExecuteTool.mockResolvedValue({ results: [] });

      const result = await handler.process(['decided: use JWT tokens']);

      expect(result.warningMessage).toContain('mama_save');
      expect(result.warningMessage).toContain('before they are lost to compaction');
    });

    it('should return empty warning when no unsaved decisions', async () => {
      const handler = new PreCompactHandler(mockExecuteTool, { enabled: true });
      mockExecuteTool.mockResolvedValue({
        results: [{ topic: 'JWT' }],
      });

      const result = await handler.process(['decided: use JWT tokens']);

      expect(result.warningMessage).toBe('');
    });
  });

  describe('Handles executeTool errors gracefully', () => {
    it('should return empty result on executeTool error', async () => {
      const handler = new PreCompactHandler(mockExecuteTool, { enabled: true });
      mockExecuteTool.mockRejectedValue(new Error('Search failed'));

      const result = await handler.process(['decided: use JWT tokens']);

      expect(result.unsavedDecisions).toContain('use JWT tokens');
      expect(result.warningMessage).toContain('[MAMA PreCompact Warning]');
    });

    it('should still build compaction prompt on executeTool error', async () => {
      const handler = new PreCompactHandler(mockExecuteTool, { enabled: true });
      mockExecuteTool.mockRejectedValue(new Error('Search failed'));

      const result = await handler.process(['decided: use JWT tokens']);

      expect(result.compactionPrompt).toContain('## 1. User Requests');
    });

    it('should handle undefined response from executeTool', async () => {
      const handler = new PreCompactHandler(mockExecuteTool, { enabled: true });
      mockExecuteTool.mockResolvedValue(undefined);

      const result = await handler.process(['decided: use JWT tokens']);

      expect(result.unsavedDecisions).toContain('use JWT tokens');
    });

    it('should handle response without results array', async () => {
      const handler = new PreCompactHandler(mockExecuteTool, { enabled: true });
      mockExecuteTool.mockResolvedValue({ data: 'something' });

      const result = await handler.process(['decided: use JWT tokens']);

      expect(result.unsavedDecisions).toContain('use JWT tokens');
    });
  });

  describe('maxDecisionsToDetect limits results', () => {
    it('should limit decisions to maxDecisionsToDetect', async () => {
      const handler = new PreCompactHandler(mockExecuteTool, {
        enabled: true,
        maxDecisionsToDetect: 2,
      });
      mockExecuteTool.mockResolvedValue({ results: [] });

      const result = await handler.process([
        'decided: decision one',
        'decided: decision two',
        'decided: decision three',
        'decided: decision four',
      ]);

      expect(result.unsavedDecisions.length).toBeLessThanOrEqual(2);
    });

    it('should use default maxDecisionsToDetect when not specified', async () => {
      const handler = new PreCompactHandler(mockExecuteTool, { enabled: true });
      mockExecuteTool.mockResolvedValue({ results: [] });

      const result = await handler.process([
        'decided: decision one',
        'decided: decision two',
        'decided: decision three',
        'decided: decision four',
        'decided: decision five',
        'decided: decision six',
      ]);

      expect(result.unsavedDecisions.length).toBeLessThanOrEqual(5);
    });

    it('should return most recent decisions when exceeding limit', async () => {
      const handler = new PreCompactHandler(mockExecuteTool, {
        enabled: true,
        maxDecisionsToDetect: 2,
      });
      mockExecuteTool.mockResolvedValue({ results: [] });

      const result = await handler.process([
        'decided: first decision',
        'decided: second decision',
        'decided: third decision',
      ]);

      expect(result.unsavedDecisions).toContain('third decision');
    });
  });

  describe('No false positives on non-decision text', () => {
    it('should not match text without decision keywords', async () => {
      const handler = new PreCompactHandler(mockExecuteTool, { enabled: true });
      mockExecuteTool.mockResolvedValue({ results: [] });

      const result = await handler.process(['This is just regular conversation about the weather']);

      expect(result.unsavedDecisions).toEqual([]);
    });

    it('should not match text shorter than 10 characters', async () => {
      const handler = new PreCompactHandler(mockExecuteTool, { enabled: true });
      mockExecuteTool.mockResolvedValue({ results: [] });

      const result = await handler.process(['decided: short']);

      expect(result.unsavedDecisions).toEqual([]);
    });

    it('should not match text without proper decision keyword format', async () => {
      const handler = new PreCompactHandler(mockExecuteTool, { enabled: true });
      mockExecuteTool.mockResolvedValue({ results: [] });

      const result = await handler.process([
        'We discussed the architecture but did not make a formal decision',
      ]);

      expect(result.unsavedDecisions).toEqual([]);
    });

    it('should deduplicate identical decisions', async () => {
      const handler = new PreCompactHandler(mockExecuteTool, { enabled: true });
      mockExecuteTool.mockResolvedValue({ results: [] });

      const result = await handler.process([
        'decided: use JWT tokens',
        'decided: use JWT tokens',
        'decided: use JWT tokens',
      ]);

      expect(result.unsavedDecisions.filter((d) => d === 'use JWT tokens').length).toBe(1);
    });
  });

  describe('Unsaved decisions in compaction prompt', () => {
    it('should include unsaved decisions section when present', async () => {
      const handler = new PreCompactHandler(mockExecuteTool, { enabled: true });
      mockExecuteTool.mockResolvedValue({ results: [] });

      const result = await handler.process(['decided: use JWT tokens']);

      expect(result.compactionPrompt).toContain('## Unsaved Decisions');
      expect(result.compactionPrompt).toContain('NOT saved to MAMA memory');
    });

    it('should list unsaved decisions in prompt', async () => {
      const handler = new PreCompactHandler(mockExecuteTool, { enabled: true });
      mockExecuteTool.mockResolvedValue({ results: [] });

      const result = await handler.process(['decided: use JWT tokens']);

      expect(result.compactionPrompt).toContain('1. use JWT tokens');
    });

    it('should not include unsaved decisions section when empty', async () => {
      const handler = new PreCompactHandler(mockExecuteTool, { enabled: true });
      mockExecuteTool.mockResolvedValue({
        results: [{ topic: 'JWT' }],
      });

      const result = await handler.process(['decided: use JWT tokens']);

      expect(result.compactionPrompt).not.toContain('## Unsaved Decisions');
    });
  });

  describe('Integration tests', () => {
    it('should handle complex conversation with mixed decisions', async () => {
      const handler = new PreCompactHandler(mockExecuteTool, { enabled: true });
      mockExecuteTool.mockResolvedValue({
        results: [{ topic: 'database' }],
      });

      const result = await handler.process([
        'User: Build an API',
        'decided: use PostgreSQL for database',
        'decided: implement JWT authentication',
        'approach: REST API design',
        'Some other conversation',
      ]);

      expect(result.unsavedDecisions).toContain('implement JWT authentication');
      expect(result.unsavedDecisions).toContain('REST API design');
      expect(result.unsavedDecisions).not.toContain('use PostgreSQL for database');
    });

    it('should include all components in result', async () => {
      const handler = new PreCompactHandler(mockExecuteTool, { enabled: true });
      mockExecuteTool.mockResolvedValue({ results: [] });

      const result = await handler.process(['decided: use JWT tokens']);

      expect(result).toHaveProperty('unsavedDecisions');
      expect(result).toHaveProperty('compactionPrompt');
      expect(result).toHaveProperty('warningMessage');
      expect(Array.isArray(result.unsavedDecisions)).toBe(true);
      expect(typeof result.compactionPrompt).toBe('string');
      expect(typeof result.warningMessage).toBe('string');
    });
  });
});
