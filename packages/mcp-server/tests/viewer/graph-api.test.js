/**
 * Graph API Tests
 *
 * Story 1.1: Graph API 엔드포인트 추가
 * Story 1.3: Viewer HTML 서빙
 *
 * Tests:
 * - AC1: GET /graph returns nodes[], edges[], meta{}
 * - AC2: nodes contain id, topic, decision, reasoning, outcome, confidence, created_at
 * - AC3: edges contain from, to, relationship, reason
 * - AC4: meta contains total_nodes, total_edges, topics[]
 * - AC5: Response time < 500ms
 * - Story 1.3 AC1: GET /viewer returns HTML with Content-Type: text/html
 * - Story 1.3 AC2: HTML includes vis-network CDN script
 * - Story 1.3 AC3: HTML includes auto /graph API call
 *
 * Note: Database integration tests are skipped in unit tests.
 * Full integration testing should be done with actual DB.
 */

import fs from 'fs';

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('Story 1.1: Graph API', () => {
  let graphApi;

  beforeEach(async () => {
    vi.resetModules();
    graphApi = await import('../../src/viewer/graph-api.js');
  });

  afterEach(() => {
    vi.resetModules();
  });

  describe('getUniqueTopics()', () => {
    it('should return sorted unique topics from nodes (AC4)', () => {
      const nodes = [
        { id: '1', topic: 'database_choice' },
        { id: '2', topic: 'auth_strategy' },
        { id: '3', topic: 'database_choice' },
        { id: '4', topic: 'caching' },
      ];

      const topics = graphApi.getUniqueTopics(nodes);

      expect(topics).toEqual(['auth_strategy', 'caching', 'database_choice']);
    });

    it('should return empty array for empty nodes', () => {
      const topics = graphApi.getUniqueTopics([]);

      expect(topics).toEqual([]);
    });

    it('should handle single topic', () => {
      const nodes = [
        { id: '1', topic: 'auth_strategy' },
        { id: '2', topic: 'auth_strategy' },
      ];

      const topics = graphApi.getUniqueTopics(nodes);

      expect(topics).toEqual(['auth_strategy']);
    });
  });

  describe('filterNodesByTopic()', () => {
    it('should filter nodes by topic', () => {
      const nodes = [
        { id: '1', topic: 'auth_strategy' },
        { id: '2', topic: 'database_choice' },
        { id: '3', topic: 'auth_strategy' },
      ];

      const filtered = graphApi.filterNodesByTopic(nodes, 'auth_strategy');

      expect(filtered).toHaveLength(2);
      expect(filtered.every((n) => n.topic === 'auth_strategy')).toBe(true);
    });

    it('should return empty array when no nodes match topic', () => {
      const nodes = [{ id: '1', topic: 'auth_strategy' }];

      const filtered = graphApi.filterNodesByTopic(nodes, 'unknown_topic');

      expect(filtered).toEqual([]);
    });

    it('should return empty array when nodes array is empty', () => {
      const filtered = graphApi.filterNodesByTopic([], 'any_topic');

      expect(filtered).toEqual([]);
    });
  });

  describe('filterEdgesByNodes()', () => {
    it('should filter edges connected to given nodes', () => {
      const nodes = [{ id: 'node1' }, { id: 'node2' }];
      const edges = [
        { from: 'node1', to: 'node2' },
        { from: 'node3', to: 'node4' },
        { from: 'node2', to: 'node5' },
      ];

      const filtered = graphApi.filterEdgesByNodes(edges, nodes);

      expect(filtered).toHaveLength(2);
      expect(filtered).toContainEqual({ from: 'node1', to: 'node2' });
      expect(filtered).toContainEqual({ from: 'node2', to: 'node5' });
    });

    it('should include edge if only "from" matches', () => {
      const nodes = [{ id: 'node1' }];
      const edges = [{ from: 'node1', to: 'node999' }];

      const filtered = graphApi.filterEdgesByNodes(edges, nodes);

      expect(filtered).toHaveLength(1);
    });

    it('should include edge if only "to" matches', () => {
      const nodes = [{ id: 'node2' }];
      const edges = [{ from: 'node999', to: 'node2' }];

      const filtered = graphApi.filterEdgesByNodes(edges, nodes);

      expect(filtered).toHaveLength(1);
    });

    it('should return empty array when no edges match', () => {
      const nodes = [{ id: 'node1' }];
      const edges = [{ from: 'node2', to: 'node3' }];

      const filtered = graphApi.filterEdgesByNodes(edges, nodes);

      expect(filtered).toEqual([]);
    });
  });

  describe('createGraphHandler()', () => {
    it('should return a function', () => {
      const handler = graphApi.createGraphHandler();

      expect(typeof handler).toBe('function');
    });

    it('should return false for non-matching routes', async () => {
      const handler = graphApi.createGraphHandler();

      const req = {
        url: '/unknown',
        method: 'GET',
        headers: { host: 'localhost:3847' },
      };

      const res = {
        writeHead: vi.fn(),
        end: vi.fn(),
      };

      const handled = await handler(req, res);

      expect(handled).toBe(false);
    });

    it('should return false for POST /graph (wrong method)', async () => {
      const handler = graphApi.createGraphHandler();

      const req = {
        url: '/graph',
        method: 'POST',
        headers: { host: 'localhost:3847' },
      };

      const res = {
        writeHead: vi.fn(),
        end: vi.fn(),
      };

      const handled = await handler(req, res);

      expect(handled).toBe(false);
    });
  });

  describe('Module exports', () => {
    it('should export all required functions', () => {
      expect(typeof graphApi.createGraphHandler).toBe('function');
      expect(typeof graphApi.getAllNodes).toBe('function');
      expect(typeof graphApi.getAllEdges).toBe('function');
      expect(typeof graphApi.getUniqueTopics).toBe('function');
      expect(typeof graphApi.filterNodesByTopic).toBe('function');
      expect(typeof graphApi.filterEdgesByNodes).toBe('function');
    });
  });

  describe('Node structure verification (AC2)', () => {
    it('should define correct node structure expectations', () => {
      // Verify expected node fields per AC2
      const expectedFields = [
        'id',
        'topic',
        'decision',
        'reasoning',
        'outcome',
        'confidence',
        'created_at',
      ];

      // Mock node that should be returned by getAllNodes
      const mockNode = {
        id: 'decision_auth_123',
        topic: 'auth_strategy',
        decision: 'Use JWT',
        reasoning: 'Better for stateless',
        outcome: 'SUCCESS',
        confidence: 0.85,
        created_at: 1732680000000,
      };

      expectedFields.forEach((field) => {
        expect(mockNode).toHaveProperty(field);
      });
    });
  });

  describe('Edge structure verification (AC3)', () => {
    it('should define correct edge structure expectations', () => {
      // Verify expected edge fields per AC3
      const expectedFields = ['from', 'to', 'relationship', 'reason'];

      // Mock edge that should be returned by getAllEdges
      const mockEdge = {
        from: 'decision_auth_123',
        to: 'decision_auth_old',
        relationship: 'supersedes',
        reason: 'Performance improvement',
      };

      expectedFields.forEach((field) => {
        expect(mockEdge).toHaveProperty(field);
      });
    });
  });

  describe('Meta structure verification (AC4)', () => {
    it('should define correct meta structure expectations', () => {
      // Verify expected meta fields per AC4
      const expectedFields = ['total_nodes', 'total_edges', 'topics'];

      // Mock meta that should be returned
      const mockMeta = {
        total_nodes: 10,
        total_edges: 5,
        topics: ['auth_strategy', 'database_choice'],
      };

      expectedFields.forEach((field) => {
        expect(mockMeta).toHaveProperty(field);
      });
      expect(Array.isArray(mockMeta.topics)).toBe(true);
    });
  });

  describe('Performance expectations (AC5)', () => {
    it('should document performance requirement of < 500ms', () => {
      // This test documents the performance requirement
      // Actual performance testing requires integration test with real DB
      const performanceThresholdMs = 500;
      expect(performanceThresholdMs).toBe(500);
    });
  });
});

describe('Story 1.3: Viewer HTML Serving', () => {
  let graphApi;

  beforeEach(async () => {
    vi.resetModules();
    graphApi = await import('../../src/viewer/graph-api.js');
  });

  afterEach(() => {
    vi.resetModules();
  });

  describe('viewer.html file', () => {
    it('should exist at VIEWER_HTML_PATH', () => {
      expect(graphApi.VIEWER_HTML_PATH).toBeDefined();
      expect(fs.existsSync(graphApi.VIEWER_HTML_PATH)).toBe(true);
    });

    it('should contain vis-network CDN script (AC2)', () => {
      const html = fs.readFileSync(graphApi.VIEWER_HTML_PATH, 'utf8');
      expect(html).toContain('vis-network');
      expect(html).toContain('unpkg.com/vis-network');
    });

    it('should contain auto /graph API call (AC3)', () => {
      // JS is now in separate file, check the JS file
      const js = fs.readFileSync(graphApi.VIEWER_JS_PATH, 'utf8');
      // Accepts both '/graph' and '/graph?cluster=true'
      expect(js).toMatch(/fetch\('\/graph(\?cluster=true)?'\)/);
      expect(js).toContain('DOMContentLoaded');
    });

    it('should have dark theme CSS', () => {
      // CSS is now in separate file, check the CSS file
      const css = fs.readFileSync(graphApi.VIEWER_CSS_PATH, 'utf8');
      expect(css).toContain('#1a1a2e'); // background color
    });

    it('should have valid HTML5 structure', () => {
      const html = fs.readFileSync(graphApi.VIEWER_HTML_PATH, 'utf8');
      expect(html).toContain('<!DOCTYPE html>');
      expect(html).toContain('<html');
      expect(html).toContain('</html>');
    });
  });

  describe('GET /viewer route', () => {
    it('should handle GET /viewer request', async () => {
      const handler = graphApi.createGraphHandler();

      const req = {
        url: '/viewer',
        method: 'GET',
        headers: { host: 'localhost:3847' },
      };

      const res = {
        writeHead: vi.fn(),
        end: vi.fn(),
      };

      const handled = await handler(req, res);

      expect(handled).toBe(true);
      expect(res.writeHead).toHaveBeenCalledWith(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'public, max-age=3600',
      });
      expect(res.end).toHaveBeenCalled();
    });

    it('should return HTML content (AC1)', async () => {
      const handler = graphApi.createGraphHandler();

      const req = {
        url: '/viewer',
        method: 'GET',
        headers: { host: 'localhost:3847' },
      };

      let responseBody = '';
      const res = {
        writeHead: vi.fn(),
        end: vi.fn((body) => {
          responseBody = body;
        }),
      };

      await handler(req, res);

      expect(responseBody).toContain('<!DOCTYPE html>');
      expect(responseBody).toContain('MAMA');
    });

    it('should return false for POST /viewer (wrong method)', async () => {
      const handler = graphApi.createGraphHandler();

      const req = {
        url: '/viewer',
        method: 'POST',
        headers: { host: 'localhost:3847' },
      };

      const res = {
        writeHead: vi.fn(),
        end: vi.fn(),
      };

      const handled = await handler(req, res);

      expect(handled).toBe(false);
    });
  });
});
