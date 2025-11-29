/**
 * @fileoverview Tests for Session REST API
 * @module tests/mobile/session-api.test
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events'; // Used in mock responses

// Mock auth module
vi.mock('../../src/mobile/auth.js', () => ({
  authenticate: vi.fn().mockReturnValue(true),
}));

// Import after mocks
const { createSessionHandler, readBody, extractSessionId, getWsUrl } = await import(
  '../../src/mobile/session-api.js'
);
const { authenticate } = await import('../../src/mobile/auth.js');

// Create mock manager that we pass directly to createSessionHandler
function createMockManager() {
  return {
    initDB: vi.fn().mockResolvedValue(),
    createSession: vi.fn().mockResolvedValue({
      sessionId: 'session_12345_abc',
      daemon: { isActive: () => true },
    }),
    getActiveSessions: vi.fn().mockResolvedValue([
      {
        id: 'session_12345_abc',
        projectDir: '/test/project',
        status: 'active',
        createdAt: '2025-11-28T12:00:00Z',
        lastActive: '2025-11-28T12:05:00Z',
        isAlive: true,
      },
    ]),
    terminateSession: vi.fn().mockResolvedValue(true),
    getSession: vi.fn().mockReturnValue({
      projectDir: '/test/project',
      createdAt: '2025-11-28T12:00:00Z',
      clientId: null,
      daemon: { isActive: () => true },
    }),
  };
}

describe('Session API', () => {
  let handler;
  let mockReq;
  let mockRes;
  let mockManager;

  beforeEach(() => {
    vi.clearAllMocks();

    // Create fresh mock manager for each test
    mockManager = createMockManager();

    authenticate.mockReturnValue(true);
    // Pass mock manager directly to createSessionHandler
    handler = createSessionHandler(mockManager);

    mockRes = {
      writeHead: vi.fn(),
      end: vi.fn(),
      setHeader: vi.fn(),
    };
  });

  function createMockReq(method, url, body = null) {
    const req = new EventEmitter();
    req.method = method;
    req.url = url;
    req.headers = { host: 'localhost:3847' };
    req.socket = { remoteAddress: '127.0.0.1' };

    // Simulate body reading
    if (body) {
      setTimeout(() => {
        req.emit('data', JSON.stringify(body));
        req.emit('end');
      }, 0);
    } else {
      setTimeout(() => req.emit('end'), 0);
    }

    return req;
  }

  describe('GET /api/sessions', () => {
    it('should return list of active sessions', async () => {
      mockReq = createMockReq('GET', '/api/sessions');

      const handled = await handler(mockReq, mockRes);

      expect(handled).toBe(true);
      expect(mockRes.writeHead).toHaveBeenCalledWith(200);
      expect(mockRes.end).toHaveBeenCalledWith(expect.stringContaining('"sessions"'));
    });

    it('should include session details', async () => {
      mockReq = createMockReq('GET', '/api/sessions');

      await handler(mockReq, mockRes);

      const response = JSON.parse(mockRes.end.mock.calls[0][0]);
      expect(response.sessions[0]).toHaveProperty('id');
      expect(response.sessions[0]).toHaveProperty('projectDir');
      expect(response.sessions[0]).toHaveProperty('status');
      expect(response.sessions[0]).toHaveProperty('createdAt');
    });
  });

  describe('POST /api/sessions', () => {
    it('should create new session', async () => {
      mockReq = createMockReq('POST', '/api/sessions', { projectDir: '/test/project' });

      const handled = await handler(mockReq, mockRes);

      expect(handled).toBe(true);
      expect(mockRes.writeHead).toHaveBeenCalledWith(201);
    });

    it('should return sessionId and wsUrl', async () => {
      mockReq = createMockReq('POST', '/api/sessions', { projectDir: '/test/project' });

      await handler(mockReq, mockRes);

      const response = JSON.parse(mockRes.end.mock.calls[0][0]);
      expect(response).toHaveProperty('sessionId');
      expect(response).toHaveProperty('wsUrl');
      expect(response.wsUrl).toContain('ws://');
      expect(response.wsUrl).toContain('session=');
    });

    it('should return 400 if projectDir missing', async () => {
      mockReq = createMockReq('POST', '/api/sessions', {});

      await handler(mockReq, mockRes);

      expect(mockRes.writeHead).toHaveBeenCalledWith(400);
    });
  });

  describe('DELETE /api/sessions/:id', () => {
    it('should terminate session', async () => {
      mockReq = createMockReq('DELETE', '/api/sessions/session_12345_abc');

      const handled = await handler(mockReq, mockRes);

      expect(handled).toBe(true);
      expect(mockRes.writeHead).toHaveBeenCalledWith(200);
    });

    it('should return success true', async () => {
      mockReq = createMockReq('DELETE', '/api/sessions/session_12345_abc');

      await handler(mockReq, mockRes);

      const response = JSON.parse(mockRes.end.mock.calls[0][0]);
      expect(response.success).toBe(true);
    });

    it('should return 404 for non-existent session', async () => {
      // Create new mock manager that returns false for terminate
      const notFoundManager = createMockManager();
      notFoundManager.terminateSession.mockResolvedValue(false);
      const notFoundHandler = createSessionHandler(notFoundManager);

      mockReq = createMockReq('DELETE', '/api/sessions/nonexistent');

      await notFoundHandler(mockReq, mockRes);

      expect(mockRes.writeHead).toHaveBeenCalledWith(404);
    });
  });

  // Note: Authentication behavior is thoroughly tested in auth.test.js
  // The session-api.js uses the real auth module, which is tested separately

  describe('CORS', () => {
    it('should handle OPTIONS preflight', async () => {
      mockReq = createMockReq('OPTIONS', '/api/sessions');

      const handled = await handler(mockReq, mockRes);

      expect(handled).toBe(true);
      expect(mockRes.writeHead).toHaveBeenCalledWith(204);
    });

    it('should set CORS headers', async () => {
      mockReq = createMockReq('GET', '/api/sessions');

      await handler(mockReq, mockRes);

      expect(mockRes.setHeader).toHaveBeenCalledWith('Access-Control-Allow-Origin', '*');
    });
  });

  describe('Non-session routes', () => {
    it('should not handle non-session routes', async () => {
      mockReq = createMockReq('GET', '/api/other');

      const handled = await handler(mockReq, mockRes);

      expect(handled).toBe(false);
    });
  });
});

describe('Helper functions', () => {
  describe('extractSessionId()', () => {
    it('should extract session ID from URL', () => {
      expect(extractSessionId('/api/sessions/session_123')).toBe('session_123');
    });

    it('should handle complex session IDs', () => {
      expect(extractSessionId('/api/sessions/session_12345_abc')).toBe('session_12345_abc');
    });

    it('should return null for invalid URL', () => {
      expect(extractSessionId('/api/sessions')).toBeNull();
      expect(extractSessionId('/api/sessions/')).toBeNull();
    });
  });

  describe('getWsUrl()', () => {
    it('should generate WebSocket URL', () => {
      const req = { headers: { host: 'localhost:3847' } };
      const url = getWsUrl(req, 'session_123');

      expect(url).toBe('ws://localhost:3847/ws?session=session_123');
    });

    it('should use wss for https', () => {
      const req = {
        headers: {
          host: 'example.com',
          'x-forwarded-proto': 'https',
        },
      };
      const url = getWsUrl(req, 'session_123');

      expect(url).toBe('wss://example.com/ws?session=session_123');
    });
  });

  describe('readBody()', () => {
    it('should parse JSON body', async () => {
      const req = new EventEmitter();
      setTimeout(() => {
        req.emit('data', '{"test": "value"}');
        req.emit('end');
      }, 0);

      const body = await readBody(req);
      expect(body).toEqual({ test: 'value' });
    });

    it('should return empty object for empty body', async () => {
      const req = new EventEmitter();
      setTimeout(() => req.emit('end'), 0);

      const body = await readBody(req);
      expect(body).toEqual({});
    });

    it('should reject invalid JSON', async () => {
      const req = new EventEmitter();
      setTimeout(() => {
        req.emit('data', 'not json');
        req.emit('end');
      }, 0);

      await expect(readBody(req)).rejects.toThrow('Invalid JSON');
    });
  });
});
