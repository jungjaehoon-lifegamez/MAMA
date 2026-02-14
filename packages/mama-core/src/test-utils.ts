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
import { resetDBState, initDB, closeDB } from './db-manager.js';

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
    console.warn(`[test-utils] Embedding model preload failed: ${message}`);
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

  // Reset state for next test
  resetDBState({ disconnect: false });

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
