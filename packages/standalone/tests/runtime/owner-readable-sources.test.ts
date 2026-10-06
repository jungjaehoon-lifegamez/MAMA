import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openCoreDatabase } from '../../src/runtime/core-db.js';
import { upsertConnectorEventIndex } from '../../src/connectors/framework/event-index.js';
import { createOwnerRuntime } from '../../src/runtime/owner-runtime.js';
import { createNativeSession } from '../../src/runtime/native-session.js';
import { createTimeZoneSetting } from '../../src/runtime/timezone.js';

// Stop at the native-driver boundary: exercise the real database, grant and prompt assembly
// without starting a model process or the runtime's IPC server.
vi.mock('../../src/runtime/native-session.js', () => ({ createNativeSession: vi.fn() }));

const homes: string[] = [];
afterEach(() => {
  vi.resetAllMocks();
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

async function assembledPrompt(backend: 'codex' | 'claude', connectors: string[]): Promise<string> {
  const home = mkdtempSync(join(tmpdir(), 'owner-readable-sources-'));
  homes.push(home);
  const databasePath = join(home, 'state.db');
  const db = await openCoreDatabase({ path: databasePath });
  try {
    const rows = [
      ['fixture-archive', 'fixture-archive:family-chat:room-one'],
      ['fixture-archive', 'fixture-archive:family-chat:room-two'],
      ['fixture-archive', 'fixture-archive:family-chat:room-two:thread-one'],
      ['fixture-archive', 'fixture-archive:family-mail:room-three'],
      ['fixture-archive', 'fixture-archive:family-feedback'],
      ['fixture-archive', 'fixture-archive'],
      ['fixture-archive', null],
      ['fixture-direct', 'room-four'],
      ['fixture-hidden', 'fixture-hidden:family-secret:room-five'],
      ['calendar', 'calendar'],
    ];
    for (const [index, [source, channel]] of rows.entries()) {
      upsertConnectorEventIndex(db.adapter, {
        source_connector: source!,
        source_type: 'message',
        source_id: `fixture-source-${index}`,
        channel,
        content: 'Synthetic source content',
        source_timestamp_ms: 1_000 + index,
      });
    }
  } finally {
    await db.close();
  }
  let prompt = '';
  const boundary = new Error('Native driver boundary reached');
  vi.mocked(createNativeSession).mockImplementation((options) => {
    prompt = options.ownerSystemPrompt!;
    throw boundary;
  });
  await expect(
    createOwnerRuntime({
      backend,
      model: 'fixture-model',
      rawPath: join(home, 'raw'),
      databasePath,
      socketPath: join(home, 'runtime.sock'),
      credentialPath: join(home, 'credential'),
      runtimeRoot: home,
      timeZone: createTimeZoneSetting('UTC'),
      workspaceDir: join(home, 'workspace'),
      ownerPrincipalId: 'fixture-owner',
      agentId: 'fixture-agent',
      scopes: [],
      connectors,
      maxTurns: 10,
      timeout: 1_000,
    })
  ).rejects.toBe(boundary);
  return prompt;
}

describe('readable sources at owner session startup', () => {
  it.each(['codex', 'claude'] as const)(
    'includes stored calendar events in the %s owner prompt',
    async (backend) => {
      const prompt = await assembledPrompt(backend, ['calendar']);
      expect(prompt).toContain('Readable sources: calendar (1)');
      expect(prompt).not.toContain('fixture-hidden');
    }
  );

  it.each(['codex', 'claude'] as const)(
    'gives %s granted stored connectors and family row counts without rooms',
    async (backend) => {
      const prompt = await assembledPrompt(backend, [
        'fixture-direct',
        'fixture-archive',
        'fixture-empty',
      ]);
      const lines = prompt.split('\n').filter((line) => line.includes('Readable sources:'));
      expect(lines).toEqual([
        '- Readable sources: fixture-archive (7; family-chat 3, family-feedback 1, family-mail 1, bare 2), fixture-direct (1); chats of a family are channels "<source>:<family>:<room>".',
      ]);
      for (const hidden of [
        'room-one',
        'room-two',
        'room-three',
        'room-four',
        'room-five',
        'thread-one',
        'fixture-hidden',
        'family-secret',
        'fixture-empty',
      ]) {
        expect(prompt).not.toContain(hidden);
      }
    }
  );

  it.each([{ connectors: [] }, { connectors: ['fixture-empty'] }])(
    'reports an empty readable stored index for grant $connectors',
    async ({ connectors }) => {
      const prompt = await assembledPrompt('codex', connectors);
      const lines = prompt.split('\n').filter((line) => line.includes('Readable sources:'));
      expect(lines).toEqual(['- Readable sources: none stored for this grant.']);
    }
  );
});
