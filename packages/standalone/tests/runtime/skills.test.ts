import { expect, it, vi } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPrincipalRepository, type ActionResult } from '@jungjaehoon/mama-core';
import { fixture, roots } from '../helpers/member-runtime.js';
import { memberPaths } from '../../src/runtime/member-paths.js';
import { resolvePrincipalAccess } from '../../src/runtime/principal-access.js';
import {
  ownerDataReadPaths,
  ownerNativeDataReadPaths,
  credentialReadPaths,
} from '../../src/runtime/backend-security.js';
import { assertToolsReadable } from '../../src/runtime/tools-paths.js';
import { createSkillTurnContext, type SkillEntry } from '../../src/runtime/skills.js';

const workflow = {
  topic: 'fixture-artifact-skill',
  kind: 'workflow',
  summary: 'Make a fixture artifact',
  details: 'Fixture skill',
  appliesWhen: 'When making a fixture artifact',
  steps: ['Write a fixture artifact', 'Read the artifact'],
  evidenceChecks: ['Check fixture content'],
  source: { package: 'fixture', source_type: 'fixture' },
};

it('caps start inventories, tracks each session separately, and keeps stateless turns from consuming DM changes', async () => {
  let skills: SkillEntry[] = Array.from({ length: 40 }, (_, i) => ({
    id: `fixture-${i}`,
    name: `fixture-${i}`,
    kind: 'workflow',
    scope: 'personal',
    description: 'x'.repeat(300),
  }));
  const context = createSkillTurnContext(async () => skills);
  const start = await context(true, false, 'dm');
  expect(start.length).toBeLessThan(4_000);
  expect(start).toContain('more; use skill.list');
  await context(true, false, 'replay');
  skills = [
    ...skills,
    {
      id: 'fixture-added',
      name: 'fixture-added',
      kind: 'workflow',
      scope: 'personal',
      description: 'Fixture',
    },
  ];
  expect(await context(true, true, 'job')).toContain('skill.list');
  expect(await context(false, false, 'dm')).toContain('added: fixture-added');
  expect(await context(false, false, 'dm')).toBe('');
  expect(await context(false, false, 'replay')).toContain('fixture-added');
  skills = skills.filter((skill) => skill.id !== 'fixture-added');
  expect(await context(false, false, 'dm')).toContain('removed: fixture-added');
});

it('lists skills on the first resumed turn after a host restart', async () => {
  const context = createSkillTurnContext(async () => [
    { id: 'fixture', name: 'fixture', description: 'Fixture', kind: 'workflow', scope: 'common' },
  ]);
  const text = await context(false);
  expect(text).toContain('[skills]');
  expect(text).not.toContain('added:');
  expect(await context(false)).toBe('');
});
function data<T>(r: ActionResult): T {
  expect(r.status, JSON.stringify(r)).toBe('completed');
  if (r.status !== 'completed') throw new Error('Action failed');
  return r.data as T;
}

it.each(['claude', 'codex'] as const)(
  'a saved DM workflow reaches the next %s turn, survives lesson suppression and never reaches another person',
  async (backend) => {
    const f = await fixture(backend);
    const saved = data<{ id: string }>((await f.act('memory.save', workflow)).result).id;
    let ref = f.message(f.member, 'Make a fixture artifact');
    await f.settled(ref, f.member);
    let prompt = f.turns.filter((turn) => turn.principal === f.member).at(-1)!.prompt;
    expect(prompt).toContain('[skills changed]');
    expect(prompt).toContain(workflow.topic);
    expect(prompt).toContain(`skill.read ${saved}`);
    expect(prompt).toContain('skill');
    ref = f.message(f.member, 'Make another fixture artifact');
    await f.settled(ref, f.member);
    prompt = f.turns.filter((turn) => turn.principal === f.member).at(-1)!.prompt;
    expect(prompt).not.toContain('[skills changed]');
    expect(prompt).not.toContain('Readable sources:');
    expect(prompt).toContain(`skill.read ${saved}`);
    ref = f.message(f.managingOwner, 'Make a fixture artifact');
    await f.settled(ref, f.managingOwner);
    expect(
      f.turns.filter((turn) => turn.principal === f.managingOwner).at(-1)!.prompt
    ).not.toContain(workflow.topic);
    expect(
      f.turns.filter((turn) => turn.principal === f.managingOwner).at(-1)!.prompt
    ).not.toContain(saved);
    const read = data<{ steps: string[] }>((await f.act('skill.read', { id: saved })).result);
    expect(read.steps).toEqual(workflow.steps);
    await f.restart();
    ref = f.message(f.member, 'Make a fixture artifact');
    await f.settled(ref, f.member);
    prompt = f.turns.filter((turn) => turn.principal === f.member).at(-1)!.prompt;
    expect(prompt).toContain('[skills]');
    expect(prompt).toContain(workflow.topic);
    // A session resumed across a restart is told where its readable sources live again.
    expect(prompt).toContain('Readable sources:');
  }
);

it('common workflows and published file skills reach both member roles and the common session', async () => {
  const tools = realpathSync(mkdtempSync(join(tmpdir(), 'fixture-skill-tools-')));
  roots.push(tools);
  writeFileSync(join(tools, '.mama-document-toolkit'), 'mama-document-toolkit-v1\n');
  const f = await fixture(
    'codex',
    true,
    false,
    'UTC',
    undefined,
    'fixture-member',
    undefined,
    undefined,
    [],
    tools
  );
  const ref = f.message('owner', 'Save the common skill', f.managingOwner, {
    action: 'memory.save',
    input: workflow,
  });
  await f.settled(ref);
  const id = data<{ id: string }>(f.resultFor(ref)!).id;
  const source = join(f.home, 'workspace', 'skills', 'fixture-script');
  mkdirSync(source, { recursive: true });
  writeFileSync(
    join(source, 'SKILL.md'),
    '---\nname: fixture-script\ndescription: Run the common fixture script\n---\nRun script.sh in your workspace'
  );
  writeFileSync(join(source, 'script.sh'), 'printf fixture > result.txt\n');
  const publish = f.message('owner', 'Publish the common file skill', f.managingOwner, {
    action: 'skill.publish',
    input: { name: 'fixture-script' },
  });
  await f.settled(publish);
  data(f.resultFor(publish)!);
  for (const principal of [f.member, f.managingOwner, 'owner']) {
    const turn = f.message(principal, 'Make a fixture artifact');
    await f.settled(turn, principal);
    const prompt = f.turns.filter((turn) => turn.principal === principal).at(-1)!.prompt;
    expect(prompt).toContain(workflow.topic);
    expect(prompt).toContain(`skill.read ${id}`);
    expect(prompt).toContain('fixture-script');
    if (principal !== 'owner') expect(prompt).toContain('common');
  }
  rmSync(join(memberPaths(f.root, f.member).workspaceDir, 'skills'), {
    recursive: true,
    force: true,
  });
  const remove = f.message('owner', 'Remove the common file skill', f.managingOwner, {
    action: 'skill.unpublish',
    input: { name: 'fixture-script' },
  });
  await f.settled(remove);
  data(f.resultFor(remove)!);
  const after = f.message(f.member, 'Next fixture turn');
  await f.settled(after, f.member);
  expect(f.turns.filter((turn) => turn.principal === f.member).at(-1)!.prompt).toContain(
    'removed: fixture-script'
  );
  expect(readFileSync(join(source, 'SKILL.md'), 'utf8')).toContain('fixture-script');
  expect(existsSync(join(tools, 'skills', 'fixture-script'))).toBe(false);
});

it('searches personal guidance separately from common workflows for a plain member', async () => {
  const f = await fixture();
  const common = f.message('owner', 'Save fixture workflow', f.managingOwner, {
    action: 'memory.save',
    input: workflow,
  });
  await f.settled(common);
  const hostCall = vi.spyOn(f.runtime.surface, 'hostToolCall');
  const ref = f.message(f.member, 'Make a fixture artifact');
  await f.settled(ref, f.member);
  expect(f.turns.filter((turn) => turn.principal === f.member).at(-1)!.prompt).toContain(
    workflow.topic
  );
  const searches = hostCall.mock.calls.filter(([name]) => name === 'memory.search');
  expect(searches).toHaveLength(2);
  expect(searches[1]![1]).toMatchObject({
    kind: 'workflow',
    scopes: f.runtime.surface.ownerAccess.defaultScopes,
  });
});

it.each([false, true])(
  'keeps a personal correction in lessons despite 40 more similar common records (owner role: %s)',
  async (ownerRole) => {
    const f = await fixture();
    if (ownerRole)
      createPrincipalRepository(f.runtime.database.adapter).grantRole({
        principalId: f.member,
        role: 'owner',
      });
    const correction = {
      ...workflow,
      topic: 'fixture-format-rule',
      kind: 'constraint',
      summary: 'Check fixture artifact output before delivery',
      appliesWhen: 'When making fixture artifacts',
    };
    data((await f.act('memory.save', correction)).result);
    for (let i = 0; i < 40; i++)
      data(
        await f.runtime.surface.hostToolCall(
          'memory.save',
          {
            ...workflow,
            topic: `fixture-common-${i}`,
            kind: ['fact', 'decision', 'lesson'][i % 3],
            summary: 'Make a fixture artifact',
            details: 'Make a fixture artifact',
          },
          `fixture-common-save-${i}`,
          { access: f.runtime.surface.ownerAccess }
        )
      );
    const common = f.message('owner', 'Save fixture workflow', f.managingOwner, {
      action: 'memory.save',
      input: workflow,
    });
    await f.settled(common);
    const ref = f.message(f.member, 'Make a fixture artifact');
    await f.settled(ref, f.member);
    const prompt = f.turns.filter((turn) => turn.principal === f.member).at(-1)!.prompt;
    const lessons = prompt.slice(prompt.indexOf('<lessons>'), prompt.indexOf('</lessons>'));
    expect(lessons).toContain(correction.topic);
    expect(lessons).toContain(workflow.topic);
    // A plain member sees only common workflows; an owner also reads common rule kinds.
    if (!ownerRole) expect(lessons).not.toContain('fixture-common-');
  }
);

it('deduplicates owner-role shared workflows before the ten session-start decisions', async () => {
  const f = await fixture();
  const access = resolvePrincipalAccess(f.managingOwner, {
    adapter: f.runtime.database.adapter,
    ownerAccess: f.runtime.surface.ownerAccess,
    agentId: 'fixture-agent',
  });
  const save = async (topic: string, kind: string) =>
    data<{ id: string }>(
      await f.runtime.surface.hostToolCall(
        'memory.save',
        {
          ...workflow,
          topic,
          kind,
          summary: 'Fixture',
        },
        `fixture-save-${topic}`,
        { access }
      )
    ).id;
  const correction = 'fixture-earlier-rule';
  await save(correction, 'constraint');
  for (let i = 0; i < 5; i++) {
    const id = await save(`fixture-shared-${i}`, 'workflow');
    const share = await f.actAs(f.managingOwner, 'memory.share', {
      memory_id: id,
      reason: 'Share fixture workflow',
    });
    await f.settled(share.ref, f.managingOwner);
    const shared = data<{ id: string }>(share.result);
    f.runtime.database.adapter
      .prepare('UPDATE decisions SET created_at = ? WHERE id = ?')
      .run(new Date(Date.now() + 1_000 + i).toISOString(), shared.id);
    // Retire the original so only the shared projection occupies a decision slot.
    data(
      await f.runtime.surface.hostToolCall(
        'memory.retire',
        {
          memory_id: id,
          status: 'stale',
          reason: 'Use the shared workflow',
        },
        `fixture-retire-${i}`,
        { access }
      )
    );
  }
  await f.restart();
  const ref = f.message(f.managingOwner);
  await f.settled(ref, f.managingOwner);
  const prompt = f.turns.filter((turn) => turn.principal === f.managingOwner).at(-1)!.prompt;
  const start = prompt.slice(prompt.indexOf('[session_start]')).split('[skills]')[0]!;
  expect(start).toContain(correction);
  for (let i = 0; i < 5; i++)
    expect(start.match(new RegExp(`fixture-shared-${i}`, 'g'))).toHaveLength(1);
});

it('refuses a publish in a replay turn through the runtime owner-message predicate', async () => {
  const f = await fixture();
  const result = await f.actDelta(
    'skill.publish',
    { name: 'fixture-script' },
    {
      kind: 'source_delta',
      collector: 'fixture',
      channel: 'fixture',
      coalesceKey: 'fixture',
      refs: [],
      preview: [],
      occurredAt: 10,
      replay: {
        runId: 'fixture-run',
        windowId: 'fixture-window',
        windowStartMs: 1,
        windowEndMs: 11,
      },
    }
  );
  expect(result).toMatchObject({ status: 'failed', error: { kind: 'denied' } });
});

it('keeps a granted-partition workflow as a lesson without an unreadable skill id in the common turn', async () => {
  const f = await fixture();
  createPrincipalRepository(f.runtime.database.adapter).grantScope({
    targetPrincipalId: f.member,
    ownerPrincipalId: 'owner',
    now: 5,
    scope: { kind: 'memory', scopeKind: 'project', scopeId: 'fixture-partition' },
  });
  const ref = f.message('owner', 'Save partition workflow', f.managingOwner, {
    action: 'memory.save',
    input: { ...workflow, scopes: [{ kind: 'project', id: 'fixture-partition' }] },
  });
  await f.settled(ref);
  const id = data<{ id: string }>(f.resultFor(ref)!).id;
  const turn = f.message('owner', 'Make a fixture artifact');
  await f.settled(turn);
  const prompt = f.turns.filter((turn) => turn.principal === 'owner').at(-1)!.prompt;
  expect(prompt).toContain(workflow.topic);
  expect(prompt).not.toContain(`skill.read ${id}`);
  expect(await f.runtime.surface.hostToolCall('skill.read', { id }, 'fixture-read')).toMatchObject({
    status: 'failed',
    error: { kind: 'denied' },
  });
});

it('keeps all session roles, replay and report turns running when the common skills parent is a file', async () => {
  const tools = realpathSync(mkdtempSync(join(tmpdir(), 'fixture-skill-errors-')));
  roots.push(tools);
  writeFileSync(join(tools, 'skills'), 'fixture');
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const f = await fixture(
    'codex',
    true,
    false,
    'UTC',
    undefined,
    'fixture-member',
    undefined,
    undefined,
    [],
    tools
  );
  for (const principal of ['owner', f.member, f.managingOwner]) {
    const ref = f.message(principal);
    await f.settled(ref, principal);
    expect(f.turns.filter((turn) => turn.principal === principal).at(-1)!.prompt).toContain(
      'Invalid skill'
    );
  }
  data(
    await f.actDelta(
      'skill.list',
      {},
      {
        kind: 'source_delta',
        collector: 'fixture',
        channel: 'fixture',
        coalesceKey: 'fixture',
        refs: [],
        preview: [],
        occurredAt: 10,
        replay: {
          runId: 'fixture-run',
          windowId: 'fixture-window',
          windowStartMs: 1,
          windowEndMs: 11,
        },
      }
    )
  );
  data(
    await f.actScheduled(
      {
        id: 'fixture-report',
        channelKey: 'schedule',
        occurredAt: Date.now(),
        payload: { report: 'full', hourKey: '2026-10-14:00' },
      },
      'skill.list',
      {}
    )
  );
});

it('the shared skills folder stays outside both native read deny lists', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'fixture-skill-denies-')));
  roots.push(root);
  const home = join(root, 'home');
  const options = {
    runtimeRoot: home,
    workspaceDir: join(home, 'workspace'),
    databasePath: join(home, 'state.db'),
    rawPath: join(home, 'raw'),
    memberRoot: join(root, 'members'),
    socketPath: join(home, 'socket'),
    credentialPath: join(home, 'runtime', 'credential'),
  } as Parameters<typeof ownerDataReadPaths>[0];
  const skills = join(root, 'tools', 'skills');
  expect(() =>
    assertToolsReadable(skills, [
      ...credentialReadPaths(home),
      ...ownerNativeDataReadPaths(options),
    ])
  ).not.toThrow();
  expect(() => assertToolsReadable(skills, ownerDataReadPaths(options))).not.toThrow();
});
