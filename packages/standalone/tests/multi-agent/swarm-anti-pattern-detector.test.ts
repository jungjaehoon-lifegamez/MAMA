/**
 * Tests for Swarm Anti-Pattern Detector
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  SwarmAntiPatternDetector,
  type AntiPatternWarning,
} from '../../src/multi-agent/swarm/swarm-anti-pattern-detector.js';
import type { MamaApiClient, SearchResult } from '../../src/gateways/context-injector.js';

describe('SwarmAntiPatternDetector', () => {
  let mockMamaApi: MamaApiClient;
  let detector: SwarmAntiPatternDetector;

  beforeEach(() => {
    // Create mock MamaApiClient
    mockMamaApi = {
      search: vi.fn().mockResolvedValue([]),
    };
  });

  describe('constructor', () => {
    it('should use default minFailures of 2', () => {
      detector = new SwarmAntiPatternDetector({
        mamaApi: mockMamaApi,
      });

      expect(detector).toBeDefined();
    });

    it('should accept custom minFailures option', () => {
      detector = new SwarmAntiPatternDetector({
        mamaApi: mockMamaApi,
        minFailures: 5,
      });

      expect(detector).toBeDefined();
    });

    it('should accept verbose option', () => {
      detector = new SwarmAntiPatternDetector({
        mamaApi: mockMamaApi,
        verbose: true,
      });

      expect(detector).toBeDefined();
    });
  });

  describe('detect()', () => {
    it('should return empty array when no failure history exists', async () => {
      detector = new SwarmAntiPatternDetector({
        mamaApi: mockMamaApi,
        minFailures: 2,
      });

      const warnings = await detector.detect('developer', 'Implement authentication');

      expect(mockMamaApi.search).toHaveBeenCalledWith('swarm:developer:failed', 10);
      expect(warnings).toEqual([]);
    });

    it('should return empty array when failure count < minFailures', async () => {
      const mockResults: SearchResult[] = [
        {
          id: 'decision_1',
          topic: 'swarm:developer:failed',
          decision: 'Task failed',
          reasoning: 'Network timeout',
          outcome: 'failed',
          similarity: 0.9,
        },
      ];

      mockMamaApi.search = vi.fn().mockResolvedValue(mockResults);

      detector = new SwarmAntiPatternDetector({
        mamaApi: mockMamaApi,
        minFailures: 2,
      });

      const warnings = await detector.detect('developer', 'Implement feature');

      expect(warnings).toEqual([]);
    });

    it('should return warning when failure count >= minFailures', async () => {
      const mockResults: SearchResult[] = [
        {
          id: 'decision_1',
          topic: 'swarm:developer:failed',
          decision: 'Task abc failed',
          reasoning: 'Database connection failed',
          outcome: 'failed',
          similarity: 0.9,
        },
        {
          id: 'decision_2',
          topic: 'swarm:developer:failed',
          decision: 'Task def failed',
          reasoning: 'API timeout',
          outcome: 'failed',
          similarity: 0.85,
        },
      ];

      mockMamaApi.search = vi.fn().mockResolvedValue(mockResults);

      detector = new SwarmAntiPatternDetector({
        mamaApi: mockMamaApi,
        minFailures: 2,
      });

      const warnings = await detector.detect('developer', 'Implement feature');

      expect(warnings.length).toBe(1);
      expect(warnings[0]).toMatchObject({
        agentId: 'developer',
        failureCount: 2,
        lastError: 'Database connection failed',
      });
      expect(warnings[0].pattern).toContain('High failure rate');
      expect(warnings[0].recommendation).toContain('2 recent failures');
    });

    it('should filter out non-failed outcomes', async () => {
      const mockResults: SearchResult[] = [
        {
          id: 'decision_1',
          topic: 'swarm:developer:completed',
          decision: 'Task completed',
          outcome: 'success',
          similarity: 0.9,
        },
        {
          id: 'decision_2',
          topic: 'swarm:developer:failed',
          decision: 'Task failed',
          reasoning: 'Error occurred',
          outcome: 'failed',
          similarity: 0.85,
        },
      ];

      mockMamaApi.search = vi.fn().mockResolvedValue(mockResults);

      detector = new SwarmAntiPatternDetector({
        mamaApi: mockMamaApi,
        minFailures: 2,
      });

      const warnings = await detector.detect('developer', 'Implement feature');

      // Only 1 failed result, below minFailures threshold
      expect(warnings).toEqual([]);
    });

    it('should detect similar error patterns in task description', async () => {
      const mockResults: SearchResult[] = [
        {
          id: 'decision_1',
          topic: 'swarm:developer:failed',
          decision: 'Task failed',
          reasoning: 'Authentication token expired while connecting to database',
          outcome: 'failed',
          similarity: 0.9,
        },
        {
          id: 'decision_2',
          topic: 'swarm:developer:failed',
          decision: 'Task failed',
          reasoning: 'Database authentication failed with token error',
          outcome: 'failed',
          similarity: 0.85,
        },
      ];

      mockMamaApi.search = vi.fn().mockResolvedValue(mockResults);

      detector = new SwarmAntiPatternDetector({
        mamaApi: mockMamaApi,
        minFailures: 2,
      });

      // Task description contains similar keywords: authentication, database, token
      const warnings = await detector.detect(
        'developer',
        'Fix authentication token for database connection'
      );

      expect(warnings.length).toBe(1);
      expect(warnings[0].pattern).toContain('similar tasks');
      expect(warnings[0].failureCount).toBe(2);
      expect(warnings[0].recommendation).toContain('Review previous error');
    });

    it('should return empty array when mamaApi.search() fails (graceful fallback)', async () => {
      mockMamaApi.search = vi.fn().mockRejectedValue(new Error('Database error'));

      detector = new SwarmAntiPatternDetector({
        mamaApi: mockMamaApi,
        minFailures: 2,
      });

      const warnings = await detector.detect('developer', 'Implement feature');

      expect(warnings).toEqual([]);
    });

    it('should log in verbose mode when patterns are found', async () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      const mockResults: SearchResult[] = [
        {
          id: 'decision_1',
          topic: 'swarm:developer:failed',
          decision: 'Task failed',
          reasoning: 'Error 1',
          outcome: 'failed',
          similarity: 0.9,
        },
        {
          id: 'decision_2',
          topic: 'swarm:developer:failed',
          decision: 'Task failed',
          reasoning: 'Error 2',
          outcome: 'failed',
          similarity: 0.85,
        },
      ];

      mockMamaApi.search = vi.fn().mockResolvedValue(mockResults);

      detector = new SwarmAntiPatternDetector({
        mamaApi: mockMamaApi,
        minFailures: 2,
        verbose: true,
      });

      await detector.detect('developer', 'Implement feature');

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('[AntiPatternDetector] Found 2 past failures for agent developer')
      );
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('[AntiPatternDetector] Generated 1 warnings for agent developer')
      );

      consoleSpy.mockRestore();
    });

    it('should warn in verbose mode when search fails', async () => {
      const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      mockMamaApi.search = vi.fn().mockRejectedValue(new Error('Search failed'));

      detector = new SwarmAntiPatternDetector({
        mamaApi: mockMamaApi,
        verbose: true,
      });

      await detector.detect('developer', 'Task');

      expect(consoleWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining(
          '[AntiPatternDetector] Failed to detect patterns for agent developer'
        ),
        expect.any(Error)
      );

      consoleWarnSpy.mockRestore();
    });
  });

  describe('formatWarnings()', () => {
    beforeEach(() => {
      detector = new SwarmAntiPatternDetector({
        mamaApi: mockMamaApi,
      });
    });

    it('should return empty string when warnings array is empty', () => {
      const formatted = detector.formatWarnings([]);

      expect(formatted).toBe('');
    });

    it('should format single warning correctly', () => {
      const warnings: AntiPatternWarning[] = [
        {
          agentId: 'developer',
          pattern: 'Repeated database errors',
          failureCount: 3,
          lastError: 'Connection timeout',
          recommendation: 'Check database connection settings',
        },
      ];

      const formatted = detector.formatWarnings(warnings);

      expect(formatted).toContain('⚠️ **Anti-pattern Warning**');
      expect(formatted).toContain('Previous failures detected');
      expect(formatted).toContain('Agent `developer`');
      expect(formatted).toContain('Repeated database errors');
      expect(formatted).toContain('3 failures');
      expect(formatted).toContain('Check database connection settings');
    });

    it('should format multiple warnings correctly', () => {
      const warnings: AntiPatternWarning[] = [
        {
          agentId: 'developer',
          pattern: 'Database errors',
          failureCount: 3,
          recommendation: 'Fix database connection',
        },
        {
          agentId: 'tester',
          pattern: 'Test timeouts',
          failureCount: 2,
          recommendation: 'Increase timeout duration',
        },
      ];

      const formatted = detector.formatWarnings(warnings);

      expect(formatted).toContain('Agent `developer`');
      expect(formatted).toContain('Database errors');
      expect(formatted).toContain('3 failures');
      expect(formatted).toContain('Agent `tester`');
      expect(formatted).toContain('Test timeouts');
      expect(formatted).toContain('2 failures');
    });
  });

  describe('integration scenarios', () => {
    it('should handle agent with no similar pattern but high failure count', async () => {
      const mockResults: SearchResult[] = [
        {
          id: 'decision_1',
          topic: 'swarm:developer:failed',
          decision: 'Task A failed',
          reasoning: 'Network timeout',
          outcome: 'failed',
          similarity: 0.9,
        },
        {
          id: 'decision_2',
          topic: 'swarm:developer:failed',
          decision: 'Task B failed',
          reasoning: 'Disk full',
          outcome: 'failed',
          similarity: 0.85,
        },
        {
          id: 'decision_3',
          topic: 'swarm:developer:failed',
          decision: 'Task C failed',
          reasoning: 'Memory error',
          outcome: 'failed',
          similarity: 0.8,
        },
      ];

      mockMamaApi.search = vi.fn().mockResolvedValue(mockResults);

      detector = new SwarmAntiPatternDetector({
        mamaApi: mockMamaApi,
        minFailures: 2,
      });

      // Completely different task
      const warnings = await detector.detect(
        'developer',
        'Implement user authentication with OAuth2'
      );

      expect(warnings.length).toBe(1);
      expect(warnings[0].pattern).toContain('High failure rate');
      expect(warnings[0].failureCount).toBe(3);
    });

    it('should respect custom minFailures threshold', async () => {
      const mockResults: SearchResult[] = [
        { id: '1', outcome: 'failed', reasoning: 'Error 1', similarity: 0.9 },
        { id: '2', outcome: 'failed', reasoning: 'Error 2', similarity: 0.8 },
        { id: '3', outcome: 'failed', reasoning: 'Error 3', similarity: 0.7 },
      ];

      mockMamaApi.search = vi.fn().mockResolvedValue(mockResults);

      detector = new SwarmAntiPatternDetector({
        mamaApi: mockMamaApi,
        minFailures: 5, // High threshold
      });

      const warnings = await detector.detect('developer', 'Task');

      // Only 3 failures, below threshold of 5
      expect(warnings).toEqual([]);
    });
  });
});
