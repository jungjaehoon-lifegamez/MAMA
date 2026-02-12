/**
 * @fileoverview Session Manager - tracks multiple Claude Code sessions in SQLite
 * @module mobile/session-manager
 * @version 1.5.0
 *
 * Manages session lifecycle including creation, tracking, and termination.
 * Sessions are persisted to SQLite for durability across server restarts.
 *
 * @example
 * import { SessionManager } from './session-manager';
 * const manager = new SessionManager();
 * await manager.initDB();
 * const { sessionId, daemon } = await manager.createSession('/path/to/project');
 */

import path from 'path';
import os from 'os';
import type Database from 'better-sqlite3';
import { ClaudeDaemon } from './daemon.js';

/**
 * Default database path
 */
export const DEFAULT_DB_PATH: string =
  process.env.MAMA_DB_PATH || path.join(os.homedir(), '.claude', 'mama-memory.db');

/**
 * Sessions table creation SQL
 */
export const CREATE_SESSIONS_TABLE: string = `
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    project_dir TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    last_active TEXT DEFAULT (datetime('now')),
    status TEXT DEFAULT 'active',
    pid INTEGER,
    client_id TEXT
  )
`;

/**
 * Create index for status queries
 */
const CREATE_STATUS_INDEX: string = `
  CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status)
`;

/**
 * Session database row
 */
interface SessionRow {
  id: string;
  project_dir: string;
  started_at?: string;
  created_at?: string;
  last_active_at?: string;
  last_active?: string;
  status: string;
  pid: number | null;
  client_id: string | null;
}

/**
 * In-memory session data
 */
interface MemorySession {
  daemon: ClaudeDaemon;
  clientId: string | null;
  projectDir: string;
  createdAt: string;
}

/**
 * Session info returned from getActiveSessions
 */
export interface SessionInfo {
  id: string;
  projectDir: string;
  createdAt: string | undefined;
  lastActive: string | undefined;
  status: string;
  pid: number | null;
  clientId: string | null;
  isAlive: boolean;
}

/**
 * Create session result
 */
export interface CreateSessionResult {
  sessionId: string;
  daemon: ClaudeDaemon;
}

/**
 * SessionManager class - manages Claude Code sessions
 */
export class SessionManager {
  private dbPath: string;
  private sessions: Map<string, MemorySession>;
  private db: Database.Database | null;
  private initialized: boolean;

  /**
   * Create a new SessionManager instance
   * @param dbPath - Path to SQLite database
   */
  constructor(dbPath: string = DEFAULT_DB_PATH) {
    this.dbPath = dbPath;
    this.sessions = new Map();
    this.db = null;
    this.initialized = false;
  }

  /**
   * Initialize the SQLite database and create sessions table
   */
  async initDB(): Promise<void> {
    if (this.initialized) {
      return;
    }

    try {
      // Dynamically import better-sqlite3 to handle cases where it's not installed
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const Database = require('better-sqlite3') as typeof import('better-sqlite3');
      this.db = new Database(this.dbPath);

      // Create sessions table if not exists
      this.db.exec(CREATE_SESSIONS_TABLE);
      this.db.exec(CREATE_STATUS_INDEX);

      // Mark any orphaned 'active' sessions as 'terminated'
      // (from previous server crashes)
      this.db
        .prepare(
          `
        UPDATE sessions
        SET status = 'terminated', last_active = datetime('now')
        WHERE status = 'active'
      `
        )
        .run();

      this.initialized = true;
      console.error(`[SessionManager] Database initialized at ${this.dbPath}`);

      // Setup cleanup on process exit
      this._setupProcessCleanup();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[SessionManager] Failed to initialize database:', message);
      throw err;
    }
  }

  /**
   * Create a new Claude Code session
   * @param projectDir - Working directory for the session
   * @returns Session ID and daemon
   */
  async createSession(projectDir: string): Promise<CreateSessionResult> {
    if (!this.initialized) {
      await this.initDB();
    }

    // Generate unique session ID
    const sessionId = `session_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;

    // Create daemon instance
    const daemon = new ClaudeDaemon(projectDir, sessionId);

    try {
      // Spawn the daemon
      await daemon.spawn();

      // Insert into database
      const stmt = this.db!.prepare(`
        INSERT INTO sessions (id, project_dir, status, pid)
        VALUES (?, ?, 'active', ?)
      `);
      stmt.run(sessionId, projectDir, daemon.getPid());

      // Store in memory map
      this.sessions.set(sessionId, {
        daemon,
        clientId: null,
        projectDir,
        createdAt: new Date().toISOString(),
      });

      // Setup daemon event handlers
      this._setupDaemonHandlers(sessionId, daemon);

      console.error(`[SessionManager] Session ${sessionId} created for ${projectDir}`);

      return { sessionId, daemon };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[SessionManager] Failed to create session:`, message);
      // Cleanup on failure
      daemon.kill();
      throw err;
    }
  }

  /**
   * Get all active sessions
   * @returns Array of active session info
   */
  async getActiveSessions(): Promise<SessionInfo[]> {
    if (!this.initialized) {
      await this.initDB();
    }

    const stmt = this.db!.prepare(`
      SELECT id, project_dir, started_at, last_active_at, status, pid, client_id
      FROM sessions
      WHERE status = 'active'
      ORDER BY started_at DESC
    `);

    const rows = stmt.all() as SessionRow[];

    // Enrich with in-memory data
    return rows.map((row) => {
      const memSession = this.sessions.get(row.id);
      return {
        id: row.id,
        projectDir: row.project_dir,
        createdAt: row.started_at,
        lastActive: row.last_active_at,
        status: row.status,
        pid: row.pid,
        clientId: row.client_id,
        isAlive: memSession?.daemon?.isActive() || false,
      };
    });
  }

  /**
   * Terminate a session by ID
   * @param sessionId - Session to terminate
   * @returns True if session was terminated
   */
  async terminateSession(sessionId: string): Promise<boolean> {
    if (!this.initialized) {
      await this.initDB();
    }

    const session = this.sessions.get(sessionId);

    if (session) {
      // Kill the daemon
      if (session.daemon) {
        session.daemon.kill();
      }

      // Remove from memory
      this.sessions.delete(sessionId);
    }

    // Update database
    const stmt = this.db!.prepare(`
      UPDATE sessions
      SET status = 'terminated', last_active = datetime('now')
      WHERE id = ?
    `);
    const result = stmt.run(sessionId);

    console.error(`[SessionManager] Session ${sessionId} terminated`);

    return (result.changes as number) > 0;
  }

  /**
   * Get a session by ID
   * @param sessionId - Session ID to look up
   * @returns Session data or undefined
   */
  getSession(sessionId: string): MemorySession | undefined {
    return this.sessions.get(sessionId);
  }

  /**
   * Update session's last active timestamp
   * @param sessionId - Session ID
   */
  touchSession(sessionId: string): void {
    if (!this.db || !this.initialized) {
      return;
    }

    const stmt = this.db.prepare(`
      UPDATE sessions
      SET last_active = datetime('now')
      WHERE id = ?
    `);
    stmt.run(sessionId);
  }

  /**
   * Assign a client to a session
   * @param sessionId - Session ID
   * @param clientId - Client ID
   */
  assignClient(sessionId: string, clientId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.clientId = clientId;
    }

    if (this.db && this.initialized) {
      const stmt = this.db.prepare(`
        UPDATE sessions
        SET client_id = ?
        WHERE id = ?
      `);
      stmt.run(clientId, sessionId);
    }
  }

  /**
   * Remove client assignment from a session
   * @param sessionId - Session ID
   */
  unassignClient(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.clientId = null;
    }

    if (this.db && this.initialized) {
      const stmt = this.db.prepare(`
        UPDATE sessions
        SET client_id = NULL
        WHERE id = ?
      `);
      stmt.run(sessionId);
    }
  }

  /**
   * Get session count
   * @returns Number of active sessions
   */
  getSessionCount(): number {
    return this.sessions.size;
  }

  /**
   * Terminate all active sessions
   * @returns Number of sessions terminated
   */
  async terminateAll(): Promise<number> {
    const sessionIds = Array.from(this.sessions.keys());
    let count = 0;

    for (const sessionId of sessionIds) {
      if (await this.terminateSession(sessionId)) {
        count++;
      }
    }

    return count;
  }

  /**
   * Setup daemon event handlers
   * @private
   */
  private _setupDaemonHandlers(sessionId: string, daemon: ClaudeDaemon): void {
    daemon.on('exit', () => {
      // Update database on daemon exit
      if (this.db && this.initialized) {
        const stmt = this.db.prepare(`
          UPDATE sessions
          SET status = 'terminated', last_active = datetime('now')
          WHERE id = ?
        `);
        stmt.run(sessionId);
      }

      // Remove from memory
      this.sessions.delete(sessionId);
      console.error(`[SessionManager] Session ${sessionId} daemon exited, cleaned up`);
    });

    daemon.on('error', (err: { error: Error }) => {
      console.error(`[SessionManager] Session ${sessionId} daemon error:`, err.error);
    });
  }

  /**
   * Setup process cleanup handlers
   * @private
   */
  private _setupProcessCleanup(): void {
    const cleanup = async () => {
      console.error('[SessionManager] Process exiting, cleaning up sessions...');
      await this.terminateAll();
      if (this.db) {
        this.db.close();
      }
    };

    process.on('exit', () => void cleanup());
    process.on('SIGINT', () => void cleanup());
    process.on('SIGTERM', () => void cleanup());
  }

  /**
   * Close the database connection
   */
  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
      this.initialized = false;
    }
  }
}
