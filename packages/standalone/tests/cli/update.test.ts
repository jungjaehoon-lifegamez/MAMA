/**
 * `mama update` as the owner runs it, on a temp install (tests/helpers/update-install.ts): each
 * refusal, each failing step, and each step an updater can be killed at.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { acquireInstallLock } from '../../src/cli/runtime/daemon-control.js';
import { isCredentialEnvName } from '../../src/runtime/backend-security.js';
import { rollbackCommand } from '../../src/cli/runtime/update-journal.js';
import { compareReleases } from '../../src/cli/runtime/release-check.js';
import { UPDATE_HOLD_LINE } from '../../src/cli/launch-files.js';
import { TOOLKIT_ASSETS } from '../../src/tools/toolkit-state.js';
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
      await expect(f.run([])).rejects.toThrow(/^Already updating since .+ \(update, pid \d+\)$/);
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

  it('leaves a toolkit alone when the new version locks the same requirements', async () => {
    const lock = createHash('sha256')
      .update(readFileSync(join(TOOLKIT_ASSETS, 'requirements.lock')))
      .digest('hex');
    const f = fixture({ toolkit: lock });
    expect(await f.run([])).toBe(0);
    expect(f.calls.some((call) => call.startsWith('tools install'))).toBe(false);
    expectClean(f, '1.1.0');
  });

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
      // From the stop on, start.sh finds the hold: nothing starts the install half-changed. A
      // killed child at step 13 or 14 had removed it to start the candidate.
      expect(existsSync(f.paths.hold)).toBe(journalStep >= 7 && journalStep < 13);
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

  it('orders releases by semver precedence, prereleases included', async () => {
    expect(compareReleases('0.79.0', '0.79.0-rc.1')).toBeGreaterThan(0);
    expect(compareReleases('0.79.0-rc.2', '0.79.0')).toBeLessThan(0);
    expect(compareReleases('0.79.0-rc.2', '0.79.0-beta.2')).toBeGreaterThan(0);
    expect(compareReleases('0.79.0-rc.10', '0.79.0-rc.2')).toBeGreaterThan(0);
    expect(compareReleases('0.79.0-rc.1', '0.79.0-rc.1.1')).toBeLessThan(0);
    expect(compareReleases('0.79.0-1', '0.79.0-rc')).toBeLessThan(0);
    expect(compareReleases('0.79.0+build.5', '0.79.0')).toBe(0);
    expect(compareReleases('0.80.0', '0.79.9')).toBeGreaterThan(0);
    expect(() => compareReleases('0.79', '0.79.0')).toThrow('0.79 is not a semver version');

    // The release from a candidate is an update; a candidate after its release is a downgrade.
    const rc = fixture({ from: '1.1.0-rc.1', releases: { '1.1.0-rc.1': {} } });
    expect(await rc.run(['1.1.0'])).toBe(0);
    expectClean(rc, '1.1.0');
    const release = fixture({ from: '1.1.0', releases: { '1.1.0-rc.2': {} } });
    await expect(release.run(['1.1.0-rc.2'])).rejects.toThrow(
      'Refused: 1.1.0-rc.2 is older than 1.1.0, which runs now'
    );
    const beta = fixture({
      from: '1.1.0-beta.2',
      releases: { '1.1.0-beta.2': {}, '1.1.0-rc.2': {} },
    });
    expect(await beta.run(['1.1.0-rc.2'])).toBe(0);
    expectClean(beta, '1.1.0-rc.2');
  });

  it('refuses a start.sh that would not stop a start during the update', async () => {
    const f = fixture();
    writeFileSync(
      f.startPath,
      f.launch
        .split('\n')
        .filter((line) => line !== UPDATE_HOLD_LINE)
        .join('\n')
    );
    await expect(f.run([])).rejects.toThrow(
      `${f.startPath} does not stop a start while an update holds the install; run mama service install, then mama update`
    );
    expect(f.calls).toEqual([]);
    expectClean(f, '1.0.0');
  });

  it('says whether the service still runs when the stop at step 6 fails', async () => {
    const running = fixture();
    running.state.stopFails = true;
    expect(await running.run([])).toBe(1);
    expect(running.output()).toContain('1.0.0 stays installed and still runs');
    // The service manager took the stop, then the stop reported a failure.
    const down = fixture();
    down.state.stopFails = true;
    down.state.running = null;
    expect(await down.run([])).toBe(1);
    expect(down.output()).toContain(
      'the service is not running; 1.0.0 stays installed, and mama service start starts it again'
    );
    expectClean(down, '1.0.0');
  });

  it('refuses a wait that is not a number of milliseconds', async () => {
    const f = fixture({ env: { MAMA_UPDATE_WAIT_MS: '5m' } });
    await expect(f.run(['--dry-run'])).rejects.toThrow(
      'MAMA_UPDATE_WAIT_MS must be a whole number of milliseconds above 0, not "5m"'
    );
  });

  it('removes what a snapshot cut off mid-backup left, credentials included', async () => {
    const f = fixture();
    await killedAt(f, 'backup#1');
    const journal = f.journal()!;
    expect(journal.schemaBefore).toBeNull();
    expect(f.backups().sort()).toEqual(
      [
        `${journal.snapshot!.split('/').pop()!}.partial`,
        journal.snapshotStaging!.split('/').pop()!,
      ].sort()
    );
    expect(await f.run(['--rollback'])).toBe(0);
    expect(f.calls).not.toContain('restore');
    expectClean(f, '1.0.0');
  });

  it('lets an orphaned child finish while --rollback waits for it', async () => {
    const f = fixture({ releases: { '1.1.0': { crash: true } } });
    f.state.orphanParent = true;
    // The child waits for the candidate at step 14 when the parent is killed.
    f.state.pauseAt = 'status#2';
    void f.run([]);
    await vi.waitFor(() => expect(f.state.resume).not.toBeNull());
    expect(f.journal()!.phase).toBe('candidate');
    // A second writer on the same journal is refused while the child lives.
    await expect(f.run(['--rollback'])).rejects.toThrow(
      /^The update's update --continue \(pid \d+\) still runs and writes the journal/
    );
    expect(f.journal()!.phase).toBe('candidate');
    f.state.resume!();
    expect(await f.state.child).toBe(1);
    expect(f.output()).toContain(
      `the updater that started this is gone, so roll back with: '${f.nodePath}' '${join(f.scope, '.mama-os-1.0.0', 'dist', 'cli', 'index.js')}' update --rollback`
    );
    expect(f.journal()!.failure?.step).toBe(14);
    expect(await f.run(['--rollback'])).toBe(0);
    expectClean(f, '1.0.0');
    expect(f.state.running).toBe('1.0.0');
  });

  it('an orphaned child that confirms its candidate finishes the update alone', async () => {
    const f = fixture();
    f.state.orphanParent = true;
    void f.run([]);
    await vi.waitFor(() => expect(f.state.child).not.toBeNull());
    expect(await f.state.child).toBe(0);
    expectClean(f, '1.1.0');
    expect(f.state.held).toBe(false);
  });

  it('drains, not --now, when a retried rollback finds the previous version running', async () => {
    const f = fixture({ releases: { '1.1.0': { crash: true } } });
    // The rollback is killed after it started 1.0.0 again: 1.0.0 runs real turns, unheld.
    f.state.killAt = 'npm ls#1';
    void f.run([]);
    await vi.waitFor(() => expect(f.state.killAt).toBeNull());
    expect(f.state.running).toBe('1.0.0');
    expect(f.journal()!.phase).toBe('rollback');
    f.calls.length = 0;
    expect(await f.run(['--rollback'])).toBe(0);
    expect(f.calls).toContain('stop');
    expect(f.calls).not.toContain('stop --now');
    expectClean(f, '1.0.0');
  });

  it("reads npm ls's tree when npm exits 1 for another package's problem", async () => {
    const f = fixture({ releases: { '1.1.0': { crash: true } } });
    f.state.lsProblems = true;
    expect(await f.run([])).toBe(1);
    expect(f.output()).toContain('rolled back: 1.0.0 runs again');
    expectClean(f, '1.0.0');
    expect(f.state.running).toBe('1.0.0');
  });

  it('names the failed step and the command when the rollback child dies on a signal', async () => {
    const f = fixture({ releases: { '1.1.0': { crash: true } } });
    f.state.rollbackChildKilled = true;
    expect(await f.run([])).toBe(1);
    expect(f.output()).toContain(
      `rollback did not finish: 1.0.0's update --rollback --continue ended on SIGKILL; the update had failed at step 14: MAMA did not finish starting`
    );
    expect(f.output()).toContain(
      `Resolve it with: '${f.nodePath}' '${f.cliPath}' update --rollback`
    );
    expect(existsSync(f.paths.hold)).toBe(true);
    expect(await f.run(['--rollback'])).toBe(0);
    expectClean(f, '1.0.0');
  });

  it('stops a candidate that answers before its boot read the journal with --now', async () => {
    const f = fixture();
    await killedAt(f, 'status#2');
    expect(f.state.held).toBe(true);
    // Restarted under KeepAlive, its control socket answers before boot reads the journal.
    f.state.unheldStatus = true;
    f.calls.length = 0;
    expect(await f.run(['--rollback'])).toBe(0);
    expect(f.calls).toContain('stop --now');
    expect(f.calls).not.toContain('stop');
    expectClean(f, '1.0.0');
  });

  it('says the daemon may still run when the failed rollback cannot stop it', async () => {
    const f = fixture({ releases: { '1.1.0': { crash: true } } });
    // The previous version starts, then npm ls disagrees, and the stop after it fails.
    f.state.lsWrong = true;
    f.state.stopFailsWhen = () => f.journal()?.phase === 'rollback' && f.state.running === '1.0.0';
    expect(await f.run([])).toBe(1);
    expect(f.output()).toContain(
      'rollback stopped: npm ls -g shows @jungjaehoon/mama-os 9.9.9, not 1.0.0. The hold file is in place, but the daemon did not stop (above) and may still run;'
    );
    expect(f.output()).not.toContain('The install stays stopped');
    expect(f.state.running).toBe('1.0.0');
    f.state.lsWrong = false;
    f.state.stopFailsWhen = null;
    expect(await f.run(['--rollback'])).toBe(0);
    expectClean(f, '1.0.0');
  });

  it('fails loud on a snapshot written under another name, and removes it', async () => {
    const f = fixture();
    f.state.backupElsewhere = true;
    expect(await f.run([])).toBe(1);
    expect(f.output()).toMatch(
      /not updated: the snapshot was written to \S+elsewhere\.tar\.gz, not \S+mama-update-1\.0\.0-\d{8}-\d{6}\.tar\.gz/
    );
    expectClean(f, '1.0.0');
    expect(f.state.running).toBe('1.0.0');
  });
});
