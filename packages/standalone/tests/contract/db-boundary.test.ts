import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { initDB, resetDBState } from '../../../mama-core/src/db-manager.js';

const REAL_DB_PATH = join(homedir(), '.claude', 'mama-memory.db');

describe('db boundary contract', () => {
  let previousMamaDbPath: string | undefined;
  let previousMamaDatabasePath: string | undefined;
  let previousVitest: string | undefined;
  let previousNodeEnv: string | undefined;

  beforeEach(() => {
    previousMamaDbPath = process.env.MAMA_DB_PATH;
    previousMamaDatabasePath = process.env.MAMA_DATABASE_PATH;
    previousVitest = process.env.VITEST;
    previousNodeEnv = process.env.NODE_ENV;
    resetDBState({ disconnect: true });
  });

  afterEach(() => {
    resetDBState({ disconnect: true });
    restoreEnv('MAMA_DB_PATH', previousMamaDbPath);
    restoreEnv('MAMA_DATABASE_PATH', previousMamaDatabasePath);
    restoreEnv('VITEST', previousVitest);
    restoreEnv('NODE_ENV', previousNodeEnv);
  });

  it('test env is not configured to use the real user DB', () => {
    const envPath = process.env.MAMA_DB_PATH;
    if (envPath) {
      expect(envPath).not.toBe(REAL_DB_PATH);
    }

    expect(process.env.VITEST || process.env.NODE_ENV).toBeDefined();
  });

  it('initDB throws if VITEST=true and MAMA_DB_PATH points at the real DB', async () => {
    process.env.VITEST = 'true';
    process.env.MAMA_DB_PATH = REAL_DB_PATH;
    delete process.env.MAMA_DATABASE_PATH;

    await expect(initDB()).rejects.toThrow(/db-boundary|real DB|Refusing/i);
  });

  it('initDB throws if VITEST=true and MAMA_DATABASE_PATH points at the real DB', async () => {
    process.env.VITEST = 'true';
    delete process.env.MAMA_DB_PATH;
    process.env.MAMA_DATABASE_PATH = '~/.claude/mama-memory.db';

    await expect(initDB()).rejects.toThrow(/db-boundary|real DB|Refusing/i);
  });
});

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}
