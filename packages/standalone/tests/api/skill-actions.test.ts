import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createKnowledge,
  createPrincipalRepository,
  type ActionResult,
  type JudgmentAccess,
} from '@jungjaehoon/mama-core';
import { Mailbox } from '@jungjaehoon/mama-core/runtime/mailbox';
import { openCoreDatabase } from '../../src/runtime/core-db.js';
import { createActionSurface } from '../../src/runtime/action-surface.js';
import { resolvePrincipalAccess } from '../../src/runtime/principal-access.js';
import { createTimeZoneSetting } from '../../src/runtime/timezone.js';

function data<T>(result: ActionResult): T {
  expect(result.status, JSON.stringify(result)).toBe('completed');
  if (result.status !== 'completed') throw new Error('Action failed');
  return result.data as T;
}
type Skill = {
  id: string;
  name: string;
  kind: string;
  scope: string;
  path?: string;
  applies_when?: string;
  error?: string;
};

describe('scoped skills through the product dispatcher', () => {
  let root: string;
  let db: Awaited<ReturnType<typeof openCoreDatabase>>;
  let surface: ReturnType<typeof createActionSurface>;
  let a: string;
  let b: string;
  let owner: string;
  let sequence: number;
  const workspace = (id: string) => join(root, 'workspaces', id);
  const tools = () => join(root, 'tools');
  const access = (id: string): JudgmentAccess =>
    id === 'common'
      ? surface.ownerAccess
      : resolvePrincipalAccess(id, {
          adapter: db.adapter,
          ownerAccess: surface.ownerAccess,
          agentId: 'fixture-agent',
        });
  const call = (action: string, input: unknown, id = a, message = true, sender = owner) => {
    const ref = `telegram:fixture:message-${sequence++}`;
    if (message && id === 'common')
      new Mailbox(db.adapter).enqueue({
        id: ref,
        kind: 'owner_message',
        principalId: id,
        channelKey: 'fixture',
        occurredAt: sequence,
        payload: { senderPrincipalId: sender },
      });
    return surface.hostToolCall(action, input, `fixture-call-${sequence++}`, {
      access: access(id),
      ...(message ? { session: { sourceMessageRef: ref } } : {}),
    });
  };
  const save = async (id = a, kind = 'workflow') =>
    data<{ id: string }>(
      await call(
        'memory.save',
        {
          topic: 'fixture-procedure',
          kind,
          summary: 'Prepare a fixture artifact',
          details: 'Fixture guidance',
          appliesWhen: 'When making a fixture artifact',
          steps: ['Create the artifact', 'Read it back'],
          evidenceChecks: ['Verify the artifact content'],
          source: { package: 'fixture', source_type: 'fixture' },
        },
        id
      )
    ).id;
  const file = (id: string, name = 'fixture-script', frontmatter = true) => {
    const path = join(workspace(id), 'skills', name);
    mkdirSync(join(path, 'scripts'), { recursive: true });
    writeFileSync(
      join(path, 'SKILL.md'),
      frontmatter
        ? `---\nname: ${name}\ndescription: Creates a fixture artifact\n---\nRun scripts/run.sh in your workspace.\n`
        : 'Run the script.'
    );
    writeFileSync(join(path, 'scripts', 'run.sh'), 'printf "fixture artifact" > artifact.txt\n');
    chmodSync(join(path, 'scripts', 'run.sh'), 0o755);
    return path;
  };
  const list = async (id = a) => data<{ skills: Skill[] }>(await call('skill.list', {}, id)).skills;
  const buildSurface = (toolsRoot: string | undefined = tools()) =>
    createActionSurface({
      runtimeRoot: root,
      configPath: join(root, 'config.yaml'),
      adapter: db.adapter,
      knowledge: createKnowledge({
        adapter: db.adapter,
        embedder: { embed: async () => new Float32Array(1024) },
      }),
      ownerPrincipalId: 'common',
      agentId: 'fixture-agent',
      connectors: [],
      timeZone: createTimeZoneSetting('UTC'),
      isOwnerMessageTurn: () => true,
      skillPaths: { workspace, toolsRoot },
    });

  beforeEach(async () => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'fixture-skills-')));
    db = await openCoreDatabase({ path: join(root, 'state.db') });
    const repo = createPrincipalRepository(db.adapter);
    repo.ensureOwner({
      principalId: 'common',
      connector: 'fixture',
      namespace: 'fixture',
      externalId: 'fixture-common',
      now: 1,
    });
    [a, b, owner] = ['a', 'b', 'owner'].map((externalId) =>
      repo.registerMember({
        connector: 'telegram',
        namespace: 'private',
        externalId: `fixture-${externalId}`,
        now: 2,
      })
    ) as [string, string, string];
    repo.grantRole({ principalId: owner, role: 'owner', now: 3 });
    sequence = 0;
    mkdirSync(tools(), { mode: 0o700 });
    writeFileSync(join(tools(), '.mama-document-toolkit'), 'mama-document-toolkit-v1\n');
    surface = buildSurface();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    syncBuiltinESMExports();
    const writable = (path: string) => {
      if (!existsSync(path) || !lstatSync(path).isDirectory() || lstatSync(path).isSymbolicLink())
        return;
      chmodSync(path, 0o700);
      for (const name of readdirSync(path)) writable(join(path, name));
    };
    db.close();
    writable(root);
    rmSync(root, { recursive: true, force: true });
  });

  it('lists only the caller personal workflows plus common workflows for every role', async () => {
    const personal = await save();
    const common = await save('common');
    const fact = await save('common', 'fact');
    expect(await list()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: personal,
          kind: 'workflow',
          scope: 'personal',
          applies_when: 'When making a fixture artifact',
        }),
        expect.objectContaining({ id: common, kind: 'workflow', scope: 'common' }),
      ])
    );
    for (const id of [b, owner, 'common']) {
      const entries = await list(id);
      expect(entries.map((entry) => entry.id)).toContain(common);
      expect(entries.map((entry) => entry.id)).not.toContain(personal);
      expect(entries.map((entry) => entry.id)).not.toContain(fact);
    }
    expect(
      data<{ steps: string[]; evidence_checks: string[] }>(
        await call('skill.read', { id: common }, b)
      )
    ).toMatchObject({
      steps: ['Create the artifact', 'Read it back'],
      evidence_checks: ['Verify the artifact content'],
    });
    expect(await call('skill.read', { id: personal }, b)).toMatchObject({
      status: 'failed',
      error: { kind: 'denied' },
    });
    expect(await call('skill.read', { id: personal }, owner)).toMatchObject({
      status: 'failed',
      error: { kind: 'denied' },
    });
    expect(await call('skill.read', { id: personal }, 'common')).toMatchObject({
      status: 'failed',
      error: { kind: 'denied' },
    });
    expect(await call('skill.read', { id: fact }, b)).toMatchObject({
      status: 'failed',
      error: { kind: 'denied' },
    });
    expect(
      data<{ record: unknown }>(await call('memory.read:record', { memory_id: common }, b)).record
    ).toBeNull();
  });

  it('preserves workflow guidance on an owner DM share into the common records', async () => {
    const personal = await save(owner);
    const shared = data<{ id: string }>(
      await call('memory.share', { memory_id: personal, reason: 'Share this procedure' }, owner)
    ).id;
    expect(
      data<Record<string, unknown>>(await call('skill.read', { id: shared }, b))
    ).toMatchObject({
      kind: 'workflow',
      scope: 'common',
      applies_when: 'When making a fixture artifact',
      steps: ['Create the artifact', 'Read it back'],
      evidence_checks: ['Verify the artifact content'],
    });
  });

  it('keeps a plain member partition share as fact rather than common guidance', async () => {
    createPrincipalRepository(db.adapter).grantScope({
      targetPrincipalId: a,
      ownerPrincipalId: 'common',
      now: 4,
      scope: { kind: 'memory', scopeKind: 'project', scopeId: 'fixture-partition' },
    });
    const personal = await save();
    const shared = data<{ id: string }>(
      await call('memory.share', {
        memory_id: personal,
        partition_id: 'fixture-partition',
        reason: 'Share fixture procedure',
      })
    ).id;
    const record = data<{ record: { kind: string } }>(
      await call('memory.read:record', { memory_id: shared })
    );
    expect(record.record.kind).toBe('fact');
    expect(await call('skill.read', { id: shared }, 'common')).toMatchObject({ status: 'failed' });
  });

  it('lists and reads a personal file skill with paths confined to its workspace and runs its script there', async () => {
    const path = file(a);
    const skill = (await list()).find((entry) => entry.kind === 'file')!;
    expect(skill).toMatchObject({ name: 'fixture-script', scope: 'personal', path });
    const read = data<{ text: string; files: Array<{ path: string }> }>(
      await call('skill.read', { id: skill.id })
    );
    expect(read.text).toContain('Run scripts/run.sh');
    const script = read.files.find((entry) => entry.path.endsWith('run.sh'))!;
    execFileSync('/bin/sh', [script.path], { cwd: workspace(a) });
    expect(readFileSync(join(workspace(a), 'artifact.txt'), 'utf8')).toBe('fixture artifact');
    expect((await list(b)).some((entry) => entry.kind === 'file')).toBe(false);
  });

  it('reports an unfinished personal file skill so the agent can repair it on its next turn', async () => {
    file(a, 'fixture-unfinished', false);
    expect(await list()).toEqual([
      expect.objectContaining({
        name: 'fixture-unfinished',
        scope: 'personal',
        error: expect.stringContaining('frontmatter'),
      }),
    ]);
    expect(await list(b)).toEqual([]);
    file(a, 'fixture-unfinished');
    expect((await list())[0]).not.toHaveProperty('error');
  });

  it('does not follow a personal skills parent symlink or expose its target files', async () => {
    file(b);
    mkdirSync(workspace(a), { recursive: true });
    symlinkSync(join(workspace(b), 'skills'), join(workspace(a), 'skills'));
    expect(await list()).toEqual([
      expect.objectContaining({ error: expect.stringContaining('symlink') }),
    ]);
    expect(await call('skill.read', { id: 'file:personal:fixture-script' })).toMatchObject({
      status: 'failed',
    });
  });

  it.each(['personal', 'common'] as const)(
    'keeps valid %s skills when stray entries or an unreadable skill are present',
    async (scope) => {
      const valid = file(scope === 'personal' ? a : 'common');
      if (scope === 'common')
        data(await call('skill.publish', { name: 'fixture-script' }, 'common'));
      const parent = scope === 'personal' ? join(workspace(a), 'skills') : join(tools(), 'skills');
      for (const name of ['README.md', '.gitkeep', 'Uppercase', 'spaced name', 'readme']) {
        if (name === 'Uppercase' || name === 'spaced name') mkdirSync(join(parent, name));
        else writeFileSync(join(parent, name), 'fixture');
      }
      symlinkSync(valid, join(parent, 'linked-skill'));
      const unreadable = file(scope === 'personal' ? a : 'common', 'unreadable');
      if (scope === 'common') data(await call('skill.publish', { name: 'unreadable' }, 'common'));
      const skillPath =
        scope === 'personal'
          ? join(unreadable, 'SKILL.md')
          : join(realpathSync(join(parent, 'unreadable')), 'SKILL.md');
      chmodSync(skillPath, 0o000);
      const hostErrors = vi.spyOn(console, 'error').mockImplementation(() => {});
      const found = await list();
      expect(found.map((skill) => skill.name)).toEqual([
        'fixture-script',
        'linked-skill',
        'unreadable',
      ]);
      expect(found.find((skill) => skill.name === 'fixture-script')).not.toHaveProperty('error');
      expect(found.find((skill) => skill.name === 'linked-skill')).toHaveProperty('error');
      expect(found.find((skill) => skill.name === 'unreadable')?.error).toContain('EACCES');
      expect(hostErrors.mock.calls.length).toBe(scope === 'common' ? 2 : 0);
    }
  );

  it.each(['personal', 'common'] as const)(
    'reports a %s skills parent that is a plain file without dropping workflows',
    async (scope) => {
      const id = await save();
      const parent = scope === 'personal' ? join(workspace(a), 'skills') : join(tools(), 'skills');
      mkdirSync(workspace(a), { recursive: true });
      writeFileSync(parent, 'fixture');
      const hostErrors = vi.spyOn(console, 'error').mockImplementation(() => {});
      const found = await list();
      expect(found.map((skill) => skill.id)).toContain(id);
      expect(found.find((skill) => skill.kind === 'file')?.error).toContain('ENOTDIR');
      expect(hostErrors.mock.calls.length).toBe(scope === 'common' ? 1 : 0);
    }
  );

  it('bounds inventory reads to SKILL.md metadata and detects supporting file edits without reading their bytes', async () => {
    const path = file(a);
    const skillPath = join(path, 'SKILL.md');
    writeFileSync(
      skillPath,
      '---\nname: fixture-script\ndescription: Fixture\n---\n' + 'x'.repeat(1024 * 1024)
    );
    const open = vi.spyOn(fs, 'openSync');
    const read = vi.spyOn(fs, 'readSync');
    syncBuiltinESMExports();
    const entries = await list();
    expect(entries[0]).not.toHaveProperty('error');
    expect(open.mock.calls.map((args) => args[0])).toEqual([skillPath]);
    expect(read.mock.calls.reduce((total, args) => total + Number(args[3]), 0)).toBeLessThanOrEqual(
      16 * 1024
    );
    const { createSkillTurnContext } = await import('../../src/runtime/skills.js');
    const context = createSkillTurnContext(() => surface.skills.list(a));
    await context(true);
    writeFileSync(join(path, 'scripts', 'run.sh'), 'printf revised fixture\n');
    expect(await context(false)).toContain('updated: fixture-script');
  });

  it('refuses publication before toolkit installation without creating skills in the unmarked root', async () => {
    rmSync(join(tools(), '.mama-document-toolkit'));
    file('common');
    expect(await call('skill.publish', { name: 'fixture-script' }, 'common')).toMatchObject({
      status: 'failed',
      error: { message: expect.stringContaining('mama tools install') },
    });
    expect(existsSync(join(tools(), 'skills'))).toBe(false);
  });

  it.each(['count', 'total', 'mismatch'])(
    'refuses a skill with invalid %s before making a publication',
    async (bad) => {
      const source = file('common');
      if (bad === 'count')
        for (let i = 0; i < 129; i++) writeFileSync(join(source, `fixture-${i}`), 'fixture');
      if (bad === 'total')
        for (let i = 0; i < 5; i++)
          writeFileSync(join(source, `fixture-${i}`), Buffer.alloc(2 * 1024 * 1024));
      if (bad === 'mismatch')
        writeFileSync(
          join(source, 'SKILL.md'),
          '---\nname: different-name\ndescription: Fixture\n---\nFixture'
        );
      expect(await call('skill.publish', { name: 'fixture-script' }, 'common')).toMatchObject({
        status: 'failed',
      });
      expect(existsSync(join(tools(), 'skills', 'fixture-script'))).toBe(false);
    }
  );

  it('refuses a linked common destination before creating files outside tools_root', async () => {
    file('common');
    mkdirSync(workspace(b), { recursive: true });
    symlinkSync(workspace(b), join(tools(), 'skills'));
    expect(await call('skill.publish', { name: 'fixture-script' }, 'common')).toMatchObject({
      status: 'failed',
    });
    expect(existsSync(join(workspace(b), '.versions'))).toBe(false);
  });

  it('publishes, atomically replaces and removes a common file skill for both member roles', async () => {
    const source = file('common');
    data(await call('skill.publish', { name: 'fixture-script' }, 'common'));
    const published = join(tools(), 'skills', 'fixture-script');
    const oldVersion = realpathSync(published);
    writeFileSync(
      join(source, 'SKILL.md'),
      '---\nname: fixture-script\ndescription: Revised fixture\n---\nRevised steps'
    );
    data(await call('skill.publish', { name: 'fixture-script' }, 'common'));
    expect(realpathSync(published)).not.toBe(oldVersion);
    expect(existsSync(oldVersion)).toBe(true);
    data(await call('skill.publish', { name: 'fixture-script' }, 'common'));
    expect(existsSync(oldVersion)).toBe(false);
    const versions = readdirSync(join(tools(), 'skills', '.versions'));
    expect(versions).toHaveLength(2);
    for (const id of [owner, b]) {
      const skill = (await list(id)).find((entry) => entry.kind === 'file')!;
      expect(skill).toMatchObject({ scope: 'common', name: 'fixture-script' });
      const read = data<{ text: string; files: Array<{ path: string }> }>(
        await call('skill.read', { id: skill.id }, id)
      );
      expect(read.text).toContain('Revised steps');
      mkdirSync(workspace(id), { recursive: true });
      execFileSync('/bin/sh', [read.files.find((entry) => entry.path.endsWith('run.sh'))!.path], {
        cwd: workspace(id),
      });
      expect(readFileSync(join(workspace(id), 'artifact.txt'), 'utf8')).toBe('fixture artifact');
      expect(existsSync(join(published, 'artifact.txt'))).toBe(false);
    }
    data(await call('skill.unpublish', { name: 'fixture-script' }, 'common'));
    expect((await list(b)).some((entry) => entry.kind === 'file')).toBe(false);
    expect(readdirSync(join(tools(), 'skills', '.versions'))).toEqual([]);
  });

  it.each(['skill.publish', 'skill.unpublish'])(
    '%s requires a recorded active owner in the common message turn',
    async (action) => {
      file('common');
      for (const [id, message, sender] of [
        [a, true, owner],
        [owner, true, owner],
        ['common', false, owner],
        ['common', true, b],
      ] as const)
        expect(await call(action, { name: 'fixture-script' }, id, message, sender)).toMatchObject({
          status: 'failed',
          error: { kind: 'denied' },
        });
      createPrincipalRepository(db.adapter).suspend(owner, 4);
      expect(await call(action, { name: 'fixture-script' }, 'common')).toMatchObject({
        status: 'failed',
        error: { kind: 'denied' },
      });
    }
  );

  it('refuses a missing frontmatter, symlink, directory escape and oversized skill without replacing publication', async () => {
    const source = file('common');
    data(await call('skill.publish', { name: 'fixture-script' }, 'common'));
    const published = realpathSync(join(tools(), 'skills', 'fixture-script'));
    symlinkSync(join(root, 'state.db'), join(source, 'linked'));
    expect(await call('skill.publish', { name: 'fixture-script' }, 'common')).toMatchObject({
      status: 'failed',
    });
    rmSync(join(source, 'linked'));
    file('common', 'fixture-script', false);
    expect(await call('skill.publish', { name: 'fixture-script' }, 'common')).toMatchObject({
      status: 'failed',
    });
    expect(await call('skill.publish', { name: '../escape' }, 'common')).toMatchObject({
      status: 'failed',
    });
    file('common');
    writeFileSync(join(source, 'large'), Buffer.alloc(2 * 1024 * 1024 + 1));
    expect(await call('skill.publish', { name: 'fixture-script' }, 'common')).toMatchObject({
      status: 'failed',
    });
    expect(realpathSync(join(tools(), 'skills', 'fixture-script'))).toBe(published);
    rmSync(source, { recursive: true });
    symlinkSync(workspace(a), source);
    expect(await call('skill.publish', { name: 'fixture-script' }, 'common')).toMatchObject({
      status: 'failed',
    });
  });

  it.each(['skill.publish', 'skill.unpublish'])(
    '%s names host installation when tools_root is absent',
    async (action) => {
      // An explicit absent root (the default fixture supplies one).
      surface = createActionSurface({
        runtimeRoot: root,
        configPath: join(root, 'config.yaml'),
        adapter: db.adapter,
        knowledge: createKnowledge({ adapter: db.adapter, embedder: null }),
        ownerPrincipalId: 'common',
        agentId: 'fixture-agent',
        connectors: [],
        timeZone: createTimeZoneSetting('UTC'),
        isOwnerMessageTurn: () => true,
        skillPaths: { workspace },
      });
      const result = await call(action, { name: 'fixture-script' }, 'common');
      expect(result).toMatchObject({
        status: 'failed',
        error: { message: expect.stringContaining('mama tools install') },
      });
    }
  );
});
