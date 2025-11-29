/**
 * @fileoverview Tests for SessionManager class
 * @module tests/mobile/session-manager.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';

// Mock better-sqlite3
vi.mock('better-sqlite3', () => {
  return {
    default: vi.fn().mockImplementation(() => ({
      exec: vi.fn(),
      prepare: vi.fn().mockReturnValue({
        run: vi.fn().mockReturnValue({ changes: 1 }),
        all: vi.fn().mockReturnValue([]),
        get: vi.fn(),
      }),
      close: vi.fn(),
    })),
  };
});

// Mock ClaudeDaemon
vi.mock('../../src/mobile/daemon.js', () => ({
  ClaudeDaemon: vi.fn().mockImplementation((projectDir, sessionId) => {
    const emitter = new EventEmitter();
    return {
      ...emitter,
      on: emitter.on.bind(emitter),
      emit: emitter.emit.bind(emitter),
      projectDir,
      sessionId,
      spawn: vi.fn().mockResolvedValue(),
      kill: vi.fn(),
      getPid: vi.fn().mockReturnValue(12345),
      isActive: vi.fn().mockReturnValue(true),
    };
  }),
}));

const { SessionManager, DEFAULT_DB_PATH, CREATE_SESSIONS_TABLE } = await import(
  '../../src/mobile/session-manager.js'
);

describe('SessionManager', () => {
  let manager;

  beforeEach(() => {
    manager = new SessionManager(':memory:');
    vi.clearAllMocks();
  });

  afterEach(() => {
    if (manager) {
      manager.close();
    }
  });

  describe('constructor', () => {
    it('should initialize with default db path', () => {
      const defaultManager = new SessionManager();
      expect(defaultManager.dbPath).toBe(DEFAULT_DB_PATH);
    });

    it('should accept custom db path', () => {
      expect(manager.dbPath).toBe(':memory:');
    });

    it('should initialize with empty sessions map', () => {
      expect(manager.sessions.size).toBe(0);
    });

    it('should not be initialized initially', () => {
      expect(manager.initialized).toBe(false);
    });
  });

  describe('initDB()', () => {
    it('should create sessions table', async () => {
      await manager.initDB();

      expect(manager.db.exec).toHaveBeenCalledWith(
        expect.stringContaining('CREATE TABLE IF NOT EXISTS sessions')
      );
    });

    it('should create status index', async () => {
      await manager.initDB();

      expect(manager.db.exec).toHaveBeenCalledWith(
        expect.stringContaining('CREATE INDEX IF NOT EXISTS idx_sessions_status')
      );
    });

    it('should mark initialized as true', async () => {
      await manager.initDB();
      expect(manager.initialized).toBe(true);
    });

    it('should not reinitialize if already initialized', async () => {
      await manager.initDB();
      const firstDb = manager.db;

      await manager.initDB();
      expect(manager.db).toBe(firstDb);
    });
  });

  describe('createSession()', () => {
    beforeEach(async () => {
      await manager.initDB();
    });

    it('should generate unique session ID', async () => {
      const { sessionId } = await manager.createSession('/test/project');

      expect(sessionId).toMatch(/^session_\d+_[a-z0-9]+$/);
    });

    it('should spawn daemon', async () => {
      const { daemon } = await manager.createSession('/test/project');

      expect(daemon.spawn).toHaveBeenCalled();
    });

    it('should store session in memory', async () => {
      const { sessionId } = await manager.createSession('/test/project');

      expect(manager.sessions.has(sessionId)).toBe(true);
    });

    it('should insert into database', async () => {
      await manager.createSession('/test/project');

      expect(manager.db.prepare).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO sessions')
      );
    });

    it('should return sessionId and daemon', async () => {
      const result = await manager.createSession('/test/project');

      expect(result).toHaveProperty('sessionId');
      expect(result).toHaveProperty('daemon');
    });
  });

  describe('getActiveSessions()', () => {
    beforeEach(async () => {
      await manager.initDB();
    });

    it('should query active sessions', async () => {
      await manager.getActiveSessions();

      expect(manager.db.prepare).toHaveBeenCalledWith(
        expect.stringContaining("WHERE status = 'active'")
      );
    });

    it('should return array of sessions', async () => {
      const sessions = await manager.getActiveSessions();
      expect(Array.isArray(sessions)).toBe(true);
    });
  });

  describe('terminateSession()', () => {
    let sessionId;
    let daemon;

    beforeEach(async () => {
      await manager.initDB();
      const result = await manager.createSession('/test/project');
      sessionId = result.sessionId;
      daemon = result.daemon;
    });

    it('should kill daemon', async () => {
      await manager.terminateSession(sessionId);

      expect(daemon.kill).toHaveBeenCalled();
    });

    it('should remove from memory', async () => {
      await manager.terminateSession(sessionId);

      expect(manager.sessions.has(sessionId)).toBe(false);
    });

    it('should update database', async () => {
      await manager.terminateSession(sessionId);

      expect(manager.db.prepare).toHaveBeenCalledWith(
        expect.stringContaining("SET status = 'terminated'")
      );
    });

    it('should return true on success', async () => {
      const result = await manager.terminateSession(sessionId);
      expect(result).toBe(true);
    });

    it('should handle non-existent session gracefully', async () => {
      await manager.terminateSession('nonexistent');
      // Should still attempt DB update
      expect(manager.db.prepare).toHaveBeenCalled();
    });
  });

  describe('getSession()', () => {
    it('should return session from memory', async () => {
      await manager.initDB();
      const { sessionId } = await manager.createSession('/test/project');

      const session = manager.getSession(sessionId);
      expect(session).toBeDefined();
      expect(session.projectDir).toBe('/test/project');
    });

    it('should return undefined for non-existent session', () => {
      const session = manager.getSession('nonexistent');
      expect(session).toBeUndefined();
    });
  });

  describe('getSessionCount()', () => {
    it('should return 0 initially', () => {
      expect(manager.getSessionCount()).toBe(0);
    });

    it('should return correct count after creating sessions', async () => {
      await manager.initDB();
      await manager.createSession('/test/project1');
      await manager.createSession('/test/project2');

      expect(manager.getSessionCount()).toBe(2);
    });
  });

  describe('touchSession()', () => {
    it('should update last_active in database', async () => {
      await manager.initDB();
      const { sessionId } = await manager.createSession('/test/project');

      manager.touchSession(sessionId);

      expect(manager.db.prepare).toHaveBeenCalledWith(expect.stringContaining('SET last_active'));
    });
  });

  describe('assignClient()', () => {
    it('should assign client to session in memory', async () => {
      await manager.initDB();
      const { sessionId } = await manager.createSession('/test/project');

      manager.assignClient(sessionId, 'client_123');

      const session = manager.getSession(sessionId);
      expect(session.clientId).toBe('client_123');
    });

    it('should update database', async () => {
      await manager.initDB();
      const { sessionId } = await manager.createSession('/test/project');

      manager.assignClient(sessionId, 'client_123');

      expect(manager.db.prepare).toHaveBeenCalledWith(expect.stringContaining('SET client_id'));
    });
  });

  describe('unassignClient()', () => {
    it('should remove client from session', async () => {
      await manager.initDB();
      const { sessionId } = await manager.createSession('/test/project');
      manager.assignClient(sessionId, 'client_123');

      manager.unassignClient(sessionId);

      const session = manager.getSession(sessionId);
      expect(session.clientId).toBeNull();
    });
  });

  describe('terminateAll()', () => {
    it('should terminate all sessions', async () => {
      await manager.initDB();
      await manager.createSession('/test/project1');
      await manager.createSession('/test/project2');

      const count = await manager.terminateAll();

      expect(count).toBe(2);
      expect(manager.getSessionCount()).toBe(0);
    });
  });

  describe('close()', () => {
    it('should close database connection', async () => {
      await manager.initDB();
      manager.close();

      expect(manager.db).toBeNull();
      expect(manager.initialized).toBe(false);
    });
  });
});

describe('DEFAULT_DB_PATH', () => {
  it('should use MAMA_DB_PATH env if set', () => {
    // Default path check
    expect(DEFAULT_DB_PATH).toContain('.claude');
    expect(DEFAULT_DB_PATH).toContain('mama-memory.db');
  });
});

describe('CREATE_SESSIONS_TABLE', () => {
  it('should contain required columns', () => {
    expect(CREATE_SESSIONS_TABLE).toContain('id TEXT PRIMARY KEY');
    expect(CREATE_SESSIONS_TABLE).toContain('project_dir TEXT NOT NULL');
    expect(CREATE_SESSIONS_TABLE).toContain('created_at TEXT');
    expect(CREATE_SESSIONS_TABLE).toContain('last_active TEXT');
    expect(CREATE_SESSIONS_TABLE).toContain('status TEXT');
    expect(CREATE_SESSIONS_TABLE).toContain('pid INTEGER');
    expect(CREATE_SESSIONS_TABLE).toContain('client_id TEXT');
  });
});
