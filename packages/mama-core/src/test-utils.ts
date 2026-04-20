/**
 * MAMA Core Test Utilities
 *
 * Shared test helpers for mama-core consumers.
 * Optimizes test performance by sharing expensive resources (embedding model, DB adapter).
 *
 * @module test-utils
 * @version 1.1
 */

import path from 'path';
import fs from 'fs';
import os from 'os';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { resetDBState, initDB, closeDB } from './db-manager.js';
import { warn } from './debug-logger.js';

const MIGRATIONS_DIR = join(__dirname, '..', 'db', 'migrations');

/**
 * Returns migration SQL filenames sorted by their leading three-digit version.
 */
export function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((file) => /^\d{3}-.+\.sql$/.test(file))
    .sort((left, right) => left.localeCompare(right));
}

export function migrationVersion(file: string): number {
  return Number.parseInt(file.slice(0, 3), 10);
}

/**
 * Apply migrations in order up to `maxVersion` (inclusive), starting from
 * `fromVersion`. Mirrors the production runner's two-part contract:
 *   - skip files whose version is already recorded in `schema_version`
 *   - tolerate `duplicate column` errors (legacy migrations that add
 *     columns idempotently without recording into schema_version)
 */
export function applyMigrationsThrough(
  db: Database.Database,
  maxVersion: number,
  fromVersion = 1
): void {
  for (const file of migrationFiles()) {
    const version = migrationVersion(file);
    if (version < fromVersion) continue;
    if (version > maxVersion) break;
    let alreadyApplied = false;
    try {
      alreadyApplied = !!db
        .prepare('SELECT 1 FROM schema_version WHERE version = ?')
        .get(version);
    } catch {
      alreadyApplied = false;
    }
    if (alreadyApplied) continue;
    try {
      db.exec(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!/duplicate column/i.test(msg)) throw err;
    }
  }
}

// Track test databases for cleanup
const testDatabases: string[] = [];

// Embedding model preload state
let embeddingModelPreloaded = false;

/**
 * Preload embedding model (call once in globalSetup)
 *
 * This loads the embedding model into memory so subsequent tests don't pay the ~2s load time.
 * The model stays in memory due to singleton pattern in embeddings.ts.
 */
export async function preloadEmbeddingModel(): Promise<void> {
  if (embeddingModelPreloaded) {
    return;
  }

  try {
    const { generateEmbedding } = await import('./embeddings.js');
    await generateEmbedding('preload');
    embeddingModelPreloaded = true;
  } catch (error) {
    // Non-fatal: some CI environments may not have ONNX runtime
    const message = error instanceof Error ? error.message : String(error);
    warn(`[test-utils] Embedding model preload failed: ${message}`);
  }
}

/**
 * Create isolated test database
 *
 * Creates a unique test database and sets MAMA_DB_PATH.
 * Use in beforeAll() of each test file.
 *
 * @param testName - Unique test identifier (e.g., 'search-narrative')
 * @returns Test database path
 */
export async function initTestDB(testName: string): Promise<string> {
  // Reset any existing DB state first
  resetDBState({ disconnect: true });

  // Create unique test database path
  const testDbPath = path.join(os.tmpdir(), `mama-test-${testName}-${Date.now()}.db`);

  // Clean up any existing files
  cleanupDbFiles(testDbPath);

  // Set environment variable
  process.env.MAMA_DB_PATH = testDbPath;

  // Track for cleanup
  testDatabases.push(testDbPath);

  // Initialize database
  await initDB();

  return testDbPath;
}

/**
 * Cleanup test database
 *
 * Call in afterAll() to clean up test database files.
 *
 * @param testDbPath - Path returned by initTestDB
 */
export async function cleanupTestDB(testDbPath?: string): Promise<void> {
  // Close database connection
  await closeDB();

  // Clean up files
  if (testDbPath) {
    cleanupDbFiles(testDbPath);
  }
}

/**
 * Cleanup all test databases
 *
 * Call in globalTeardown to clean up all test databases.
 */
export function cleanupAllTestDBs(): void {
  for (const dbPath of testDatabases) {
    cleanupDbFiles(dbPath);
  }
  testDatabases.length = 0;
}

/**
 * Helper to clean up SQLite database files
 */
function cleanupDbFiles(dbPath: string): void {
  const files = [dbPath, `${dbPath}-wal`, `${dbPath}-shm`];

  for (const file of files) {
    try {
      if (fs.existsSync(file)) {
        fs.unlinkSync(file);
      }
    } catch {
      // Ignore cleanup errors
    }
  }
}

/**
 * Check if embeddings are available
 *
 * Returns false if embedding model failed to load (e.g., CI without ONNX).
 * Use to conditionally skip semantic search tests.
 */
export async function isEmbeddingsAvailable(): Promise<boolean> {
  try {
    const { generateEmbedding } = await import('./embeddings.js');
    await generateEmbedding('test');
    return true;
  } catch {
    return false;
  }
}

/**
 * Create mock tool context
 *
 * Returns a mock context object for MCP tool tests.
 */
export function createMockToolContext(): {
  logger: {
    info: () => void;
    warn: () => void;
    error: () => void;
  };
} {
  return {
    logger: {
      info: () => {},
      warn: () => {},
      error: () => {},
    },
  };
}

/**
 * Suppress console output during tests
 *
 * Returns restore function to call after test.
 */
export function suppressConsole(): () => void {
  const originalLog = console.log;
  const originalWarn = console.warn;
  const originalError = console.error;

  console.log = () => {};
  console.warn = () => {};
  console.error = () => {};

  return () => {
    console.log = originalLog;
    console.warn = originalWarn;
    console.error = originalError;
  };
}
