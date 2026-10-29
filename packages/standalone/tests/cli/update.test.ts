/**
 * `mama update` as the owner runs it, on a temp install (tests/helpers/update-install.ts): each
 * refusal, each failing step, and each step an updater can be killed at.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { acquireInstallLock } from '../../src/cli/runtime/daemon-control.js';
import { isCredentialEnvName } from '../../src/runtime/backend-security.js';
import { rollbackCommand } from '../../src/cli/runtime/update-journal.js';
import { expectClean, fixture, killedAt, NAME, roots } from '../helpers/update-install.js';

// This Mac's live daemon has the global LaunchAgent label; nothing here may reach launchctl.
vi.mock('node:child_process', async (original) => {
  const refuse = () => {
    throw new Error('a test reached a child process');
  };
  return {
    ...(await original<typeof import('node:child_process')>()),
    spawnSync: vi.fn(refuse),
    spawn: vi.fn(refuse),
    execFile: vi.fn(refuse),
  };
});

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('mama update', () => {
  it('prints the plan with --dry-run and changes nothing', async () => {
    const f = fixture();
    expect(await f.run(['--dry-run'])).toBe(0);
    expect(f.output()).toContain(`update: ${NAME} 1.0.0 → 1.1.0 (npm install, prefix ${f.prefix})`);
    expect(f.output()).toContain('registry: http://registry.fixture.test/');
    expect(f.output()).toContain('now: the daemon runs 1.0.0 (running); 0 turns running');
    expect(f.output()).toContain(`stage 1.1.0 in ${join(f.scope, '.mama-update-1.1.0')}`);
    expect(f.calls).toEqual(['doctor', 'status']);
    expectClean(f, '1.0.0');
    expect(f.state.running).toBe('1.0.0');
  });

  it('stages, drains, snapshots, swaps, and confirms the candidate it booted held', async () => {
    const f = fixture();
    const before = f.inputs();
    expect(await f.run([])).toBe(0);
    expect(f.calls).toEqual([
      'doctor',
      'status',
      'npm install',
      'stop',
      'backup',
      'service install',
      'doctor',
      'start',
      'status',
      'release',
    ]);
    expect(f.state.heldAtBoot).toEqual(['1.1.0']);
    expect(f.state.held).toBe(false);
    expect(f.state.running).toBe('1.1.0');
    expectClean(f, '1.1.0');
    expect(f.inputs()).toBe(before + 1);
    expect(f.state.journalModes).toEqual([0o600]);
    expect(f.output()).toContain('updated: 1.0.0 → 1.1.0; it runs and claims again');
    // npm and the children get no credential-shaped name.
    expect(f.npmEnvs).toHaveLength(3);
    for (const env of [...f.npmEnvs, ...f.childEnvs]) {
      expect(Object.keys(env).filter(isCredentialEnvName)).toEqual([]);
      expect(env.PATH).toBe('/usr/bin:/bin');
    }
  });

  it('says already on X for the same version and refuses a lower one', async () => {
    const f = fixture({ from: '1.1.0' });
    expect(await f.run([])).toBe(0);
    expect(f.output()).toBe('already on 1.1.0');
    await expect(f.run(['1.0.0'])).rejects.toThrow(
      'Refused: 1.0.0 is older than 1.1.0, which runs now'
    );
    await expect(f.run(['9.9.9'])).rejects.toThrow('npm E404; nothing changed');
    expect(f.calls).toEqual([]);
    expectClean(f, '1.1.0');
  });

  it('refuses without a service file, beside a second updater, and on a changed command set', async () => {
    const none = fixture({ serviceFile: false });
    await expect(none.run([])).rejects.toThrow('run mama service install first');

    const f = fixture({ releases: { '1.1.0': { bin: ['mama'] } } });
    const held = acquireInstallLock(f.paths.lock, 'update');
    try {
      await expect(f.run([])).rejects.toThrow(/^Already updating since .+ \(pid \d+\)$/);
    } finally {
      held.release();
    }
    await expect(f.run([])).rejects.toThrow(
      "1.1.0's commands (mama) are not 1.0.0's (mama, mama-os)"
    );
    expect(f.calls).toEqual(['doctor', 'status', 'npm install']);
    expectClean(f, '1.0.0');
    await expect(f.run(['--continue'])).rejects.toThrow('runs only under mama update');
  });

  it('changes nothing when staging fails', async () => {
    const f = fixture();
    f.state.stagingFails = true;
    await expect(f.run([])).rejects.toThrow(
      'Staging 1.1.0 failed: npm EACCES; nothing else changed'
    );
    expect(f.calls).toEqual(['doctor', 'status', 'npm install']);
    expectClean(f, '1.0.0');
    expect(f.state.running).toBe('1.0.0');
  });

  it('removes the journal and the staging when the stop fails', async () => {
    const f = fixture();
    f.state.stopFails = true;
    expect(await f.run([])).toBe(1);
    expect(f.output()).toContain(
      'not updated: the stop did not finish (above); 1.0.0 stays installed'
    );
    expectClean(f, '1.0.0');
  });

  it('starts the old version again when the snapshot fails', async () => {
    const f = fixture();
    f.state.backupFails = true;
    expect(await f.run([])).toBe(1);
    expect(f.output()).toContain('not updated: Backup failed and nothing was kept: disk full');
    expect(f.output()).toContain('1.0.0 started again');
    expectClean(f, '1.0.0');
    expect(f.state.running).toBe('1.0.0');
  });

  it.each([
    ['10', { installFails: true }, 'codex is not on this PATH'],
    [
      '11',
      { doctorFails: 'backend' },
      'mama doctor --offline fails where it did not before: backend (backend)',
    ],
    ['12', { toolsFail: true }, 'Document toolkit install failed'],
    ['14', { crash: true }, 'MAMA did not finish starting (last stage: not started)'],
  ] as const)(
    'rolls back when step %s fails and ends on the old version',
    async (at, release, said) => {
      const f = fixture({ releases: { '1.1.0': release }, toolkit: 'a'.repeat(64) });
      const before = f.inputs();
      expect(await f.run([])).toBe(1);
      expect(f.output()).toContain(`update step ${at} failed: ${said}`);
      expect(f.output()).toContain(
        `rolled back: 1.0.0 runs again; step ${at} of the update to 1.1.0 failed`
      );
      expect(f.output()).toContain('the database was kept: 1.1.0 did not migrate it');
      expectClean(f, '1.0.0');
      expect(f.state.running).toBe('1.0.0');
      // The saved start.sh, not the new version's.
      expect(readFileSync(f.startPath, 'utf8')).toBe(f.launch);
      // Only the old version's own start added an input; none was lost.
      expect(f.inputs()).toBe(before + 1);
      // Once step 12 ran the new version's toolkit install, the rollback ran the old one's.
      expect(f.calls.includes('tools install 1.1.0')).toBe(Number(at) >= 12);
      expect(f.calls.includes('tools install 1.0.0')).toBe(Number(at) >= 12);
    }
  );

  it('a doctor failure seen before the update is not held against it', async () => {
    const f = fixture({ releases: { '1.1.0': { doctorFails: 'backend' } } });
    f.state.checks = [
      { name: 'backend', status: 'fail', detail: 'claude 2.1 is older', code: 'backend' },
      { name: 'update', status: 'fail', detail: 'unfinished', code: 'update.open' },
    ];
    expect(await f.run([])).toBe(0);
    expectClean(f, '1.1.0');
  });

  it.each([
    ['stop#1', 6],
    ['backup#1', 7],
    ['service install#1', 10],
    ['doctor#2', 11],
    ['start#1', 13],
    ['status#2', 14],
  ])(
    'resolves the journal a parent killed at %s leaves, with --rollback',
    async (at, journalStep) => {
      const f = fixture();
      const before = f.inputs();
      await killedAt(f, at);
      const journal = f.journal()!;
      expect(journal.step).toBe(journalStep);
      expect(statSync(f.paths.journal).mode & 0o777).toBe(0o600);
      // The command doctor prints names the previous CLI where it is now, by absolute paths.
      const previous =
        journalStep >= 8 ? join(f.scope, '.mama-os-1.0.0', 'dist', 'cli', 'index.js') : f.cliPath;
      expect(rollbackCommand(journal)).toBe(`'${f.nodePath}' '${previous}' update --rollback`);
      expect(await f.runAt(dirname(dirname(dirname(previous))), ['--rollback'])).toBe(0);
      expect(f.output()).toContain('rolled back: 1.0.0 runs again');
      expectClean(f, '1.0.0');
      expect(f.state.running).toBe('1.0.0');
      // A candidate killed at its wait had accepted a message while held; it is kept.
      expect(f.inputs()).toBe(before + (journalStep === 14 ? 2 : 1));
    }
  );

  it('finishes, never rolls back, a journal a parent killed after the commit leaves', async () => {
    const f = fixture();
    await killedAt(f, 'release#1');
    expect(f.journal()!.phase).toBe('committed');
    expect(f.state.held).toBe(true);
    expect(await f.run(['--rollback'])).toBe(0);
    expect(f.output()).toContain('updated: 1.0.0 → 1.1.0; it runs and claims again');
    expect(f.state.held).toBe(false);
    expectClean(f, '1.1.0');
  });

  it('restores the snapshot when the candidate migrated, and counts the inputs it drops', async () => {
    const f = fixture({ releases: { '1.1.0': { migrates: true } } });
    const before = f.inputs();
    await killedAt(f, 'status#2');
    expect(f.inputs()).toBe(before + 1);
    expect(await f.run(['--rollback'])).toBe(0);
    expect(f.calls).toContain('restore');
    expect(f.output()).toContain(
      '1.1.0 migrated the database, so the snapshot was restored: 1 input(s) accepted after it were dropped'
    );
    expectClean(f, '1.0.0');
    // The snapshot's inputs, then the old version's own start.
    expect(f.inputs()).toBe(before + 1);
  });

  it('removes the staging a parent killed before its journal left, under update.lock', async () => {
    const f = fixture();
    await killedAt(f, 'npm install#1');
    expect(f.journal()).toBeNull();
    expect(f.scopeEntries()).toEqual(['.mama-update-1.1.0', 'mama-os']);
    expect(await f.run(['--dry-run'])).toBe(0);
    expect(f.output()).toContain(`would remove ${join(f.scope, '.mama-update-1.1.0')}`);
    expect(f.scopeEntries()).toEqual(['.mama-update-1.1.0', 'mama-os']);
    expect(await f.run([])).toBe(0);
    expect(f.output()).toContain(`removing ${join(f.scope, '.mama-update-1.1.0')}`);
    expectClean(f, '1.1.0');
  });

  it('stops on the hold file when the rollback fails, keeping what it needs to run again', async () => {
    const f = fixture({ releases: { '1.1.0': { crash: true } } });
    f.state.rollbackStartFails = true;
    expect(await f.run([])).toBe(1);
    const command = `'${f.nodePath}' '${f.cliPath}' update --rollback`;
    expect(f.output()).toContain(
      `rollback stopped: the fixture service did not start. The install stays stopped on its hold file; the journal, the snapshot and both package folders are kept. Run again: ${command}`
    );
    expect(existsSync(f.paths.hold)).toBe(true);
    expect(f.journal()!.phase).toBe('rollback');
    expect(f.backups()).toHaveLength(1);
    expect(f.packageVersion()).toBe('1.0.0');
    expect(
      f.packageVersion(
        join(f.scope, '.mama-update-1.1.0', 'lib', 'node_modules', '@jungjaehoon', 'mama-os')
      )
    ).toBe('1.1.0');
    // An update refuses while it is open.
    await expect(f.run([])).rejects.toThrow(`resolve it first: ${command}`);

    f.state.rollbackStartFails = false;
    expect(await f.run(['--rollback'])).toBe(0);
    expectClean(f, '1.0.0');
    expect(f.state.running).toBe('1.0.0');
  });
});
