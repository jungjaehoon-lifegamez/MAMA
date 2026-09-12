import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MAMAServer, validateEnvironment, REQUIRED_ENV_VARS } from '../../src/server.js';

const SERVER_SOURCE = readFileSync(join(process.cwd(), 'src/server.js'), 'utf8');
const PACKAGE_VERSION = JSON.parse(
  readFileSync(join(process.cwd(), 'package.json'), 'utf8')
).version;

describe('Story 1.2: Environment Variable Validation', () => {
  const ORIGINAL_ENV = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...ORIGINAL_ENV };

    // Mock console.error and process.exit
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(process, 'exit').mockImplementation(() => {});
  });

  afterEach(() => {
    process.env = ORIGINAL_ENV;
    vi.restoreAllMocks();
  });

  it('should pass validation when all required variables are present', () => {
    expect(REQUIRED_ENV_VARS).toEqual(['MAMA_DB_PATH']);
    REQUIRED_ENV_VARS.forEach((key) => {
      process.env[key] = 'valid_value';
    });

    validateEnvironment();

    expect(process.exit).not.toHaveBeenCalled();
    // console.error might be called for other things if not careful, but here we expect clean run
    // Actually, checking specific error calls is safer
    expect(console.error).not.toHaveBeenCalledWith(expect.stringContaining('MISSING_ENV_VARS'));
  });

  it('should use defaults and warn in development mode when variables are missing', () => {
    process.env.NODE_ENV = 'development';
    delete process.env.MAMA_SERVER_TOKEN;
    delete process.env.MAMA_SERVER_PORT;
    // Ensure required vars are missing
    REQUIRED_ENV_VARS.forEach((key) => {
      delete process.env[key];
    });

    validateEnvironment();

    expect(process.exit).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('Warning: Using default values'),
      expect.any(String)
    );

    // Check if defaults were applied
    REQUIRED_ENV_VARS.forEach((key) => {
      expect(process.env[key]).toBeDefined();
    });
    expect(process.env.MAMA_SERVER_TOKEN).toBeUndefined();
    expect(process.env.MAMA_SERVER_PORT).toBeUndefined();
  });

  it('should exit with error in production mode when variables are missing', () => {
    process.env.NODE_ENV = 'production';
    // Ensure required vars are missing
    REQUIRED_ENV_VARS.forEach((key) => {
      delete process.env[key];
    });

    validateEnvironment();

    expect(process.exit).toHaveBeenCalledWith(1);

    // Check for JSON error output
    // Since console.error is mocked, we check the calls
    const errorCalls = console.error.mock.calls.map((args) => args[0]);
    const jsonError = errorCalls.find((arg) => arg.includes('MISSING_ENV_VARS'));
    expect(jsonError).toBeDefined();

    const parsedError = JSON.parse(jsonError);
    expect(parsedError.error.code).toBe('MISSING_ENV_VARS');
    expect(parsedError.error.details.missing.length).toBe(REQUIRED_ENV_VARS.length);
  });

  it('should fail if a variable is empty string', () => {
    process.env.NODE_ENV = 'production';
    process.env.MAMA_DB_PATH = '';

    validateEnvironment();

    expect(process.exit).toHaveBeenCalledWith(1);
  });
});

describe('PR2B: stdio-only MCP runtime', () => {
  it('reports the installed package version through MCP server metadata', () => {
    const server = new MAMAServer();

    expect(server.server._serverInfo).toEqual({
      name: 'mama-server',
      version: PACKAGE_VERSION,
    });
  });

  it('has no HTTP embedding opt-in, import, probe, notice, or startup branch', () => {
    expect(SERVER_SOURCE).not.toMatch(
      /MAMA_MCP_START_HTTP_EMBEDDING|MAMA_EMBEDDING_PORT|embedding-server/
    );
    expect(SERVER_SOURCE).not.toMatch(
      /isEmbeddingServerRunning|startEmbeddingServer|warmModel|migration_notice/
    );
    expect(SERVER_SOURCE).not.toMatch(/require\(['"]http['"]\)/);
    expect(SERVER_SOURCE).not.toMatch(/MAMA_SERVER_TOKEN|MAMA_SERVER_PORT|setupLogging/);
  });

  it('ignores the retired opt-in even when the environment variable is set', () => {
    const originalOptIn = process.env.MAMA_MCP_START_HTTP_EMBEDDING;
    try {
      process.env.MAMA_MCP_START_HTTP_EMBEDDING = 'true';

      const server = new MAMAServer();

      expect(server).not.toHaveProperty('legacyHttpEmbeddingMode');
      expect(SERVER_SOURCE).toContain('StdioServerTransport');
    } finally {
      if (originalOptIn === undefined) {
        delete process.env.MAMA_MCP_START_HTTP_EMBEDDING;
      } else {
        process.env.MAMA_MCP_START_HTTP_EMBEDDING = originalOptIn;
      }
    }
  });
});
