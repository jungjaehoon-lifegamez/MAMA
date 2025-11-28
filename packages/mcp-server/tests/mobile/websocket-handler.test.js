/**
 * @fileoverview Tests for WebSocket Handler
 * @module tests/mobile/websocket-handler.test
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Test the pure functions without requiring ws library
const {
  generateClientId,
  extractSessionFromUrl,
  handleClientMessage,
  HEARTBEAT_INTERVAL,
  CONNECTION_TIMEOUT,
} = await import('../../src/mobile/websocket-handler.js');

describe('WebSocket Handler', () => {
  describe('generateClientId()', () => {
    it('should generate unique client IDs', () => {
      const id1 = generateClientId();
      const id2 = generateClientId();

      expect(id1).not.toBe(id2);
    });

    it('should start with "client_" prefix', () => {
      const id = generateClientId();
      expect(id.startsWith('client_')).toBe(true);
    });

    it('should contain timestamp component', () => {
      const before = Date.now();
      const id = generateClientId();
      const after = Date.now();

      const parts = id.split('_');
      const timestamp = parseInt(parts[1], 10);

      expect(timestamp).toBeGreaterThanOrEqual(before);
      expect(timestamp).toBeLessThanOrEqual(after);
    });

    it('should have random suffix', () => {
      const id = generateClientId();
      const parts = id.split('_');

      expect(parts.length).toBe(3);
      expect(parts[2].length).toBeGreaterThan(0);
    });
  });

  describe('extractSessionFromUrl()', () => {
    it('should extract session from query parameter', () => {
      const sessionId = extractSessionFromUrl('/ws?session=session_123');
      expect(sessionId).toBe('session_123');
    });

    it('should return null for missing session param', () => {
      const sessionId = extractSessionFromUrl('/ws');
      expect(sessionId).toBeNull();
    });

    it('should return null for invalid URL', () => {
      const sessionId = extractSessionFromUrl('not-a-url');
      expect(sessionId).toBeNull();
    });

    it('should handle complex session IDs', () => {
      const sessionId = extractSessionFromUrl('/ws?session=session_12345_abc&other=param');
      expect(sessionId).toBe('session_12345_abc');
    });
  });

  describe('handleClientMessage()', () => {
    let mockWs;
    let mockClientInfo;
    let mockSessionManager;

    beforeEach(() => {
      mockWs = {
        send: vi.fn(),
        readyState: 1, // OPEN
      };

      mockClientInfo = {
        clientId: 'client_123',
        sessionId: 'session_456',
        ws: mockWs,
        isAlive: true,
      };

      mockSessionManager = {
        getSession: vi.fn().mockReturnValue({
          daemon: {
            send: vi.fn(),
          },
        }),
        touchSession: vi.fn(),
        assignClient: vi.fn(),
        unassignClient: vi.fn(),
      };
    });

    describe('send message type', () => {
      it('should send message to daemon', () => {
        handleClientMessage(
          'client_123',
          {
            type: 'send',
            content: 'Hello Claude',
          },
          mockClientInfo,
          mockSessionManager
        );

        const session = mockSessionManager.getSession('session_456');
        expect(session.daemon.send).toHaveBeenCalledWith('Hello Claude');
        expect(mockSessionManager.touchSession).toHaveBeenCalledWith('session_456');
      });

      it('should return error if no session assigned', () => {
        mockClientInfo.sessionId = null;

        handleClientMessage(
          'client_123',
          {
            type: 'send',
            content: 'Hello',
          },
          mockClientInfo,
          mockSessionManager
        );

        expect(mockWs.send).toHaveBeenCalledWith(
          JSON.stringify({
            type: 'error',
            error: 'No session assigned',
          })
        );
      });

      it('should return error if session not found', () => {
        mockSessionManager.getSession.mockReturnValue(null);

        handleClientMessage(
          'client_123',
          {
            type: 'send',
            content: 'Hello',
          },
          mockClientInfo,
          mockSessionManager
        );

        expect(mockWs.send).toHaveBeenCalledWith(
          JSON.stringify({
            type: 'error',
            error: 'Session not found or not active',
          })
        );
      });
    });

    describe('attach message type', () => {
      it('should attach to new session', () => {
        handleClientMessage(
          'client_123',
          {
            type: 'attach',
            sessionId: 'session_new',
          },
          mockClientInfo,
          mockSessionManager
        );

        expect(mockSessionManager.unassignClient).toHaveBeenCalledWith('session_456');
        expect(mockSessionManager.assignClient).toHaveBeenCalledWith('session_new', 'client_123');
        expect(mockClientInfo.sessionId).toBe('session_new');
        expect(mockWs.send).toHaveBeenCalledWith(
          JSON.stringify({
            type: 'attached',
            sessionId: 'session_new',
          })
        );
      });
    });

    describe('detach message type', () => {
      it('should detach from current session', () => {
        handleClientMessage(
          'client_123',
          {
            type: 'detach',
          },
          mockClientInfo,
          mockSessionManager
        );

        expect(mockSessionManager.unassignClient).toHaveBeenCalledWith('session_456');
        expect(mockClientInfo.sessionId).toBeNull();
        expect(mockWs.send).toHaveBeenCalledWith(
          JSON.stringify({
            type: 'detached',
          })
        );
      });
    });

    describe('ping message type', () => {
      it('should respond with pong', () => {
        handleClientMessage(
          'client_123',
          {
            type: 'ping',
          },
          mockClientInfo,
          mockSessionManager
        );

        const response = JSON.parse(mockWs.send.mock.calls[0][0]);
        expect(response.type).toBe('pong');
        expect(response.timestamp).toBeDefined();
      });
    });

    describe('unknown message type', () => {
      it('should return error for unknown type', () => {
        handleClientMessage(
          'client_123',
          {
            type: 'unknown',
          },
          mockClientInfo,
          mockSessionManager
        );

        expect(mockWs.send).toHaveBeenCalledWith(
          JSON.stringify({
            type: 'error',
            error: 'Unknown message type: unknown',
          })
        );
      });
    });
  });

  describe('Constants', () => {
    it('should have correct heartbeat interval', () => {
      expect(HEARTBEAT_INTERVAL).toBe(30000);
    });

    it('should have correct connection timeout', () => {
      expect(CONNECTION_TIMEOUT).toBe(35000);
    });
  });
});
