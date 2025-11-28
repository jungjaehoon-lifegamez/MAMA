/**
 * @fileoverview Tests for Authentication module
 * @module tests/mobile/auth.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Store original env
const originalEnv = process.env;

describe('Auth Module', () => {
  let auth;

  beforeEach(async () => {
    // Reset module cache to reload with new env
    vi.resetModules();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('isLocalhost()', () => {
    beforeEach(async () => {
      auth = await import('../../src/mobile/auth.js');
    });

    it('should return true for 127.0.0.1', () => {
      const req = {
        socket: { remoteAddress: '127.0.0.1' },
      };
      expect(auth.isLocalhost(req)).toBe(true);
    });

    it('should return true for ::1 (IPv6 localhost)', () => {
      const req = {
        socket: { remoteAddress: '::1' },
      };
      expect(auth.isLocalhost(req)).toBe(true);
    });

    it('should return true for ::ffff:127.0.0.1 (IPv4-mapped)', () => {
      const req = {
        socket: { remoteAddress: '::ffff:127.0.0.1' },
      };
      expect(auth.isLocalhost(req)).toBe(true);
    });

    it('should return false for external IP', () => {
      const req = {
        socket: { remoteAddress: '192.168.1.100' },
      };
      expect(auth.isLocalhost(req)).toBe(false);
    });

    it('should handle connection fallback', () => {
      const req = {
        socket: null,
        connection: { remoteAddress: '127.0.0.1' },
      };
      expect(auth.isLocalhost(req)).toBe(true);
    });
  });

  describe('authenticate()', () => {
    describe('localhost requests', () => {
      beforeEach(async () => {
        auth = await import('../../src/mobile/auth.js');
      });

      it('should always return true for localhost', () => {
        const req = {
          socket: { remoteAddress: '127.0.0.1' },
          headers: {},
          url: '/',
        };
        expect(auth.authenticate(req)).toBe(true);
      });

      it('should not require token for localhost', () => {
        process.env.MAMA_AUTH_TOKEN = 'secret';
        const req = {
          socket: { remoteAddress: '127.0.0.1' },
          headers: {},
          url: '/',
        };
        expect(auth.authenticate(req)).toBe(true);
      });
    });

    describe('external requests without token env', () => {
      beforeEach(async () => {
        delete process.env.MAMA_AUTH_TOKEN;
        auth = await import('../../src/mobile/auth.js');
      });

      it('should return false when MAMA_AUTH_TOKEN not set', () => {
        const req = {
          socket: { remoteAddress: '192.168.1.100' },
          headers: {},
          url: '/',
        };
        expect(auth.authenticate(req)).toBe(false);
      });
    });

    describe('external requests with token', () => {
      beforeEach(async () => {
        process.env.MAMA_AUTH_TOKEN = 'test-secret-token';
        vi.resetModules();
        auth = await import('../../src/mobile/auth.js');
      });

      it('should accept valid Bearer token', () => {
        const req = {
          socket: { remoteAddress: '192.168.1.100' },
          headers: { authorization: 'Bearer test-secret-token', host: 'localhost' },
          url: '/',
        };
        expect(auth.authenticate(req)).toBe(true);
      });

      it('should reject invalid Bearer token', () => {
        const req = {
          socket: { remoteAddress: '192.168.1.100' },
          headers: { authorization: 'Bearer wrong-token', host: 'localhost' },
          url: '/',
        };
        expect(auth.authenticate(req)).toBe(false);
      });

      it('should accept valid URL query token', () => {
        const req = {
          socket: { remoteAddress: '192.168.1.100' },
          headers: { host: 'localhost' },
          url: '/api/sessions?token=test-secret-token',
        };
        expect(auth.authenticate(req)).toBe(true);
      });

      it('should reject invalid URL query token', () => {
        const req = {
          socket: { remoteAddress: '192.168.1.100' },
          headers: { host: 'localhost' },
          url: '/api/sessions?token=wrong-token',
        };
        expect(auth.authenticate(req)).toBe(false);
      });

      it('should prefer header over query param', () => {
        const req = {
          socket: { remoteAddress: '192.168.1.100' },
          headers: { authorization: 'Bearer test-secret-token', host: 'localhost' },
          url: '/api/sessions?token=wrong-token',
        };
        expect(auth.authenticate(req)).toBe(true);
      });
    });
  });

  describe('authenticateWebSocket()', () => {
    beforeEach(async () => {
      auth = await import('../../src/mobile/auth.js');
    });

    it('should return true for authenticated request', () => {
      const req = {
        socket: { remoteAddress: '127.0.0.1' },
        headers: {},
        url: '/',
      };
      const ws = { close: vi.fn() };

      expect(auth.authenticateWebSocket(req, ws)).toBe(true);
      expect(ws.close).not.toHaveBeenCalled();
    });

    it('should close WebSocket with 4001 for unauthenticated request', () => {
      const req = {
        socket: { remoteAddress: '192.168.1.100' },
        headers: { host: 'localhost' },
        url: '/',
      };
      const ws = { close: vi.fn() };

      expect(auth.authenticateWebSocket(req, ws)).toBe(false);
      expect(ws.close).toHaveBeenCalledWith(4001, 'Authentication required');
    });
  });

  describe('createAuthMiddleware()', () => {
    beforeEach(async () => {
      auth = await import('../../src/mobile/auth.js');
    });

    it('should call next() for authenticated requests', () => {
      const middleware = auth.createAuthMiddleware();
      const req = {
        socket: { remoteAddress: '127.0.0.1' },
        headers: {},
        url: '/',
      };
      const res = {
        writeHead: vi.fn(),
        end: vi.fn(),
      };
      const next = vi.fn();

      middleware(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(res.writeHead).not.toHaveBeenCalled();
    });

    it('should return 401 for unauthenticated requests', () => {
      const middleware = auth.createAuthMiddleware();
      const req = {
        socket: { remoteAddress: '192.168.1.100' },
        headers: { host: 'localhost' },
        url: '/',
      };
      const res = {
        writeHead: vi.fn(),
        end: vi.fn(),
      };
      const next = vi.fn();

      middleware(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.writeHead).toHaveBeenCalledWith(401, { 'Content-Type': 'application/json' });
      expect(res.end).toHaveBeenCalledWith(JSON.stringify({ error: 'Unauthorized' }));
    });
  });
});
