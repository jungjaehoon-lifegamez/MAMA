import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createAdapter, createPrincipalRepository } from '@jungjaehoon/mama-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { OWNER_PRINCIPAL_ID } from '../../src/cli/commands/daemon.js';
import { runRegisterOwner } from '../../src/cli/commands/register-owner.js';
import { openCoreDatabase } from '../../src/runtime/core-db.js';

describe('manual owner registration command', () => {
  let home: string;
  let dbPath: string;
  let configPath: string;

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'register-owner-'));
    dbPath = join(home, 'core.db');
    configPath = join(home, '.mama', 'config.yaml');
    vi.stubEnv('HOME', home);
    vi.stubEnv('MAMA_DB_PATH', dbPath);
    mkdirSync(join(home, '.mama'));
    // The one-shot command uses the daemon's already-initialized database.
    const database = await openCoreDatabase({ path: dbPath });
    await database.close();
    writeConfig({ owner_user_ids: ['1001'] });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  });

  function writeConfig(telegram: Record<string, unknown>) {
    writeFileSync(
      configPath,
      JSON.stringify({
        version: 1,
        agent: {
          backend: 'codex',
          model: 'fixture-model',
          effort: 'medium',
          max_turns: 20,
          timeout: 1000,
        },
        database: { path: dbPath },
        logging: { level: 'info', file: join(home, 'fixture.log') },
        telegram: { enabled: false, allowed_chats: ['1001'], polling: false, ...telegram },
        jev: {
          enabled: false,
          keyFile: join(home, 'fixture.key'),
          vocabFile: join(home, 'vocab.json'),
        },
      })
    );
  }

  function readRows() {
    const adapter = createAdapter({ dbPath });
    adapter.connect();
    try {
      return {
        principals: adapter.prepare('SELECT * FROM principals ORDER BY principal_id').all(),
        identities: adapter
          .prepare('SELECT * FROM external_identities ORDER BY connector, namespace, external_id')
          .all(),
      };
    } finally {
      adapter.disconnect();
    }
  }

  it('creates the daemon principal and repeats without changing any registry row', async () => {
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    const diagnostics = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await runRegisterOwner()).toBe('created');
    const before = readRows();
    expect(before.principals).toHaveLength(1);
    expect(before.principals[0]).toMatchObject({
      principal_id: OWNER_PRINCIPAL_ID,
      kind: 'owner',
      status: 'active',
    });
    expect(before.identities).toHaveLength(1);
    expect(before.identities[0]).toMatchObject({
      principal_id: OWNER_PRINCIPAL_ID,
      connector: 'telegram',
      namespace: 'private',
      external_id: '1001',
    });
    expect(await runRegisterOwner()).toBe('exists');
    expect(readRows()).toEqual(before);
    expect(output.mock.calls).toEqual([
      ['created principals=1 identities=1'],
      ['exists principals=1 identities=1'],
    ]);
    expect(diagnostics).not.toHaveBeenCalled();
  });

  it('registers the id config derives from a single allowed chat, as the gateway admits it', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    writeConfig({});
    expect(await runRegisterOwner()).toBe('created');
    expect(readRows().identities).toEqual([
      expect.objectContaining({ principal_id: OWNER_PRINCIPAL_ID, external_id: '1001' }),
    ]);
  });

  it.each([{ owner_user_ids: [] }, { allowed_chats: ['1001', '1002'] }])(
    'refuses when config admits no single owner id %#',
    async (telegram) => {
      writeConfig(telegram);
      await expect(runRegisterOwner()).rejects.toThrow('telegram.owner_user_ids');
      expect(readRows()).toEqual({ principals: [], identities: [] });
    }
  );

  it('refuses multiple authorized senders instead of treating them as one identity', async () => {
    writeConfig({ owner_user_ids: ['1001', '1002'] });
    await expect(runRegisterOwner()).rejects.toThrow('telegram.owner_user_ids');
    expect(readRows()).toEqual({ principals: [], identities: [] });
  });

  it('reports an identity conflict without printing the sender or changing rows', async () => {
    const adapter = createAdapter({ dbPath });
    adapter.connect();
    try {
      createPrincipalRepository(adapter).registerMember({
        connector: 'telegram',
        namespace: 'private',
        externalId: '1001',
        now: 1,
      });
    } finally {
      adapter.disconnect();
    }
    const before = readRows();
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await runRegisterOwner()).toBe('conflict');
    expect(output.mock.calls).toEqual([['conflict principals=1 identities=1']]);
    expect(readRows()).toEqual(before);
  });

  it('rejects extra arguments before accessing config', async () => {
    await expect(runRegisterOwner(['unexpected'])).rejects.toThrow('Usage: mama register-owner');
  });
});
