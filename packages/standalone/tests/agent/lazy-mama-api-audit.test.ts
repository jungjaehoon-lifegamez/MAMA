import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { closeDB } from '@jungjaehoon/mama-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { GatewayToolExecutor } from '../../src/agent/gateway-tool-executor.js';
import type { MAMAApiInterface } from '../../src/agent/types.js';

describe('Story ONB-10: lazy MAMA API exposes audit findings', () => {
  let testDir: string;
  let originalDbPath: string | undefined;

  beforeEach(async () => {
    originalDbPath = process.env.MAMA_DB_PATH;
    testDir = mkdtempSync(join(tmpdir(), 'mama-lazy-audit-api-'));
    await closeDB();
    process.env.MAMA_DB_PATH = join(testDir, 'memory.db');
  });

  afterEach(async () => {
    await closeDB();
    if (originalDbPath === undefined) {
      delete process.env.MAMA_DB_PATH;
    } else {
      process.env.MAMA_DB_PATH = originalDbPath;
    }
    rmSync(testDir, { recursive: true, force: true });
  });

  it('binds the open-finding reader and writer when no API is injected', async () => {
    const executor = new GatewayToolExecutor();
    const api = await (
      executor as unknown as { initializeMAMAApi(): Promise<MAMAApiInterface> }
    ).initializeMAMAApi();

    expect(api.createAuditFinding).toBeTypeOf('function');
    expect(api.listOpenAuditFindings).toBeTypeOf('function');
  });
});
