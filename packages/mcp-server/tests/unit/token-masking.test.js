import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
// eslint-disable-next-line no-unused-vars
import { MAMAServer } from '../../src/server.js';

describe('Story 1.2: Token Masking', () => {
  const ORIGINAL_ENV = process.env;
  const TEST_TOKEN = 'secret-token-123';
  let originalConsoleError;
  let originalConsoleLog;
  let consoleOutput = [];

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...ORIGINAL_ENV, MAMA_SERVER_TOKEN: TEST_TOKEN };

    // Capture console output
    consoleOutput = [];
    originalConsoleError = console.error;
    originalConsoleLog = console.log;

    console.error = (...args) => {
      consoleOutput.push(args.join(' '));
    };
    console.log = (...args) => {
      consoleOutput.push(args.join(' '));
    };
  });

  afterEach(() => {
    process.env = ORIGINAL_ENV;
    console.error = originalConsoleError;
    console.log = originalConsoleLog;
    vi.restoreAllMocks();
  });

  it('should mask token in console logs', async () => {
    // We need to re-import server.js to trigger the console override if it's done at top level
    // Or we can check if the masking function is exported or applied

    // Assuming we will implement a `setupLogging` function or similar, or it runs on module load.
    // If it runs on module load, we might need to use `vi.mock` or dynamic import.

    // Let's assume we modify server.js to export a setupLogging function or we just rely on the side effect.
    // Since we can't easily reload the module with side effects in vitest without isolation,
    // we might want to extract the logging logic to a separate file or function.

    // For now, let's try to import the server and see if we can trigger the masking logic.
    // If the masking logic is inside the MAMAServer class or a function we can call.

    const { setupLogging } = await import('../../src/server.js');
    if (setupLogging) {
      setupLogging();
    }

    console.error('Error with token:', TEST_TOKEN);
    console.log('Log with token:', TEST_TOKEN);

    expect(consoleOutput.length).toBe(2);
    expect(consoleOutput[0]).toContain('***token***');
    expect(consoleOutput[0]).not.toContain(TEST_TOKEN);
    expect(consoleOutput[1]).toContain('***token***');
    expect(consoleOutput[1]).not.toContain(TEST_TOKEN);
  });

  it('should not mask other text', async () => {
    const { setupLogging } = await import('../../src/server.js');
    if (setupLogging) {
      setupLogging();
    }

    console.log('This is a safe message');

    expect(consoleOutput[0]).toBe('This is a safe message');
  });
});
