import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { validateEnvironment, REQUIRED_ENV_VARS } from '../../src/server.js';

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
    process.env.MAMA_SERVER_TOKEN = ''; // Empty string
    process.env.MAMA_DB_PATH = 'valid';
    process.env.MAMA_SERVER_PORT = '3000';

    validateEnvironment();

    expect(process.exit).toHaveBeenCalledWith(1);
  });
});
