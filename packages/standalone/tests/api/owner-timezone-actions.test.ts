import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ownerTimeZoneActionRegistrations } from '../../src/api/owner-timezone-actions.js';
import { createPrincipalRepository } from '@jungjaehoon/mama-core';
import { Mailbox } from '@jungjaehoon/mama-core/runtime/mailbox';
import { openCoreDatabase } from '../../src/runtime/core-db.js';
import { createTimeZoneSetting } from '../../src/runtime/timezone.js';

const homes: string[] = [];
const databases: Awaited<ReturnType<typeof openCoreDatabase>>[] = [];
async function authority() {
  const home = mkdtempSync(join(tmpdir(), 'timezone-authority-'));
  homes.push(home);
  vi.stubEnv('HOME', home);
  vi.stubEnv('MAMA_DB_PATH', join(home, 'state.db'));
  const db = await openCoreDatabase({ path: join(home, 'state.db') });
  databases.push(db);
  const repo = createPrincipalRepository(db.adapter);
  repo.ensureOwner({ principalId: 'owner', now: 1 });
  const person = repo.registerMember({
    connector: 'telegram',
    namespace: 'private',
    externalId: 'fixture-owner',
    now: 2,
  });
  repo.grantRole({ principalId: person, role: 'owner', now: 3 });
  const mailbox = new Mailbox(db.adapter);
  mailbox.enqueue({
    id: 'telegram:fixture:owner-ref',
    principalId: 'owner',
    kind: 'owner_message',
    channelKey: 'fixture',
    occurredAt: 1,
    refs: [],
    payload: { senderPrincipalId: person },
  });
  return { adapter: db.adapter, repo, person };
}
function configFile(contents: string): string {
  const home = mkdtempSync(join(tmpdir(), 'timezone-action-'));
  homes.push(home);
  const path = join(home, 'config.yaml');
  writeFileSync(path, contents);
  return path;
}
afterEach(async () => {
  for (const db of databases.splice(0)) await db.close();
  vi.unstubAllEnvs();
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

describe('owner.timezone.set', () => {
  it('requires a bound owner message and rewrites only the timezone line', async () => {
    const original =
      'version: 1\ntimezone: Asia/Seoul\n# retained exactly\nreports:\n  full_report_hours: [8]\n';
    const path = configFile(original);
    const setting = createTimeZoneSetting('Asia/Seoul');
    const f = await authority();
    const registration = ownerTimeZoneActionRegistrations({
      adapter: f.adapter,
      configPath: path,
      ownerPrincipalId: 'owner',
      setting,
      isOwnerMessageTurn: (ref) => ref === 'telegram:fixture:owner-ref',
    })[0]!;
    const owner = { principalId: 'owner', agentId: 'agent', scopes: [] };
    expect(() => registration.exec({ timeZone: 'Europe/Paris' }, { access: owner })).toThrow(
      expect.objectContaining({ name: 'denied' })
    );
    expect(() =>
      registration.exec(
        { timeZone: 'Europe/Paris' },
        { access: owner, session: { sourceMessageRef: 'delta-ref' } }
      )
    ).toThrow(expect.objectContaining({ name: 'denied' }));
    expect(() =>
      registration.exec(
        { timeZone: 'Europe/Paris' },
        {
          access: owner,
          session: { sourceMessageRef: 'telegram:fixture:owner-ref', replaySourceEndMs: 1 },
        }
      )
    ).toThrow(expect.objectContaining({ name: 'denied' }));
    expect(() =>
      registration.exec(
        { timeZone: 'Europe/Paris' },
        {
          access: { ...owner, principalId: 'other' },
          session: { sourceMessageRef: 'telegram:fixture:owner-ref' },
        }
      )
    ).toThrow(expect.objectContaining({ name: 'denied' }));
    expect(() =>
      registration.exec(
        { timeZone: 'Invalid/Zone' },
        {
          access: owner,
          session: { sourceMessageRef: 'telegram:fixture:owner-ref' },
        }
      )
    ).toThrow(expect.objectContaining({ name: 'invalid_input' }));
    expect(
      registration.exec(
        { timeZone: 'Europe/Paris' },
        { access: owner, session: { sourceMessageRef: 'telegram:fixture:owner-ref' } }
      )
    ).toEqual({ timeZone: 'Europe/Paris', previous: 'Asia/Seoul' });
    expect(setting.get()).toBe('Europe/Paris');
    const updated = readFileSync(path, 'utf8');
    expect(updated.replace('timezone: "Europe/Paris"', 'timezone: Asia/Seoul')).toBe(original);
    expect(updated).not.toContain('telegram:fixture:owner-ref');
  });

  it('appends the setting when it is absent', async () => {
    const path = configFile('version: 1\nreports: {}\n');
    const setting = createTimeZoneSetting('UTC');
    const f = await authority();
    const registration = ownerTimeZoneActionRegistrations({
      adapter: f.adapter,
      configPath: path,
      ownerPrincipalId: 'owner',
      setting,
      isOwnerMessageTurn: () => true,
    })[0]!;
    const owner = { principalId: 'owner', agentId: 'agent', scopes: [] };
    expect(
      registration.exec(
        { timeZone: 'Europe/Paris' },
        {
          access: owner,
          session: { sourceMessageRef: 'telegram:fixture:owner-ref' },
        }
      )
    ).toEqual({ timeZone: 'Europe/Paris', previous: 'UTC' });
    expect(readFileSync(path, 'utf8')).toBe('version: 1\nreports: {}\ntimezone: "Europe/Paris"\n');
  });
});
