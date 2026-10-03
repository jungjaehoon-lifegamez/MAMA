#!/usr/bin/env node

import { ConfigError } from '../runtime/config.js';
import { CliInputError } from './prompt.js';

/**
 * replay and backfill open the daemon's database and rewrite its workspace settings, the shell
 * sandbox's proxy ports among them, so they run only while the daemon is stopped.
 */
async function requireDaemonStopped(command: string): Promise<void> {
  const { daemonStatus } = await import('./commands/daemon.js');
  if (daemonStatus() === 'running') {
    throw new CliInputError(`Stop the daemon before mama ${command}: run mama stop`);
  }
}

async function main(): Promise<void> {
  const command = process.argv[2];
  if (command === 'init') {
    if (process.argv.length !== 3) throw new CliInputError('Usage: mama init');
    const { runInit } = await import('./commands/init.js');
    await runInit();
    return;
  }
  if (command === 'secret') {
    const { runSecret } = await import('./commands/secret.js');
    await runSecret(process.argv.slice(3));
    return;
  }
  if (command === 'daemon') {
    const { runDaemon } = await import('./commands/daemon.js');
    await runDaemon();
    return;
  }
  if (command === 'replay') {
    await requireDaemonStopped('replay');
    const { runReplay } = await import('./commands/replay.js');
    await runReplay();
    return;
  }
  if (command === 'backfill') {
    await requireDaemonStopped('backfill');
    const { runBackfill } = await import('./commands/backfill.js');
    await runBackfill(process.argv.slice(3));
    return;
  }
  if (command === 'status') {
    const { daemonStatus } = await import('./commands/daemon.js');
    console.log(daemonStatus());
    return;
  }
  if (command === 'stop') {
    const { requestDaemonStop } = await import('./commands/daemon.js');
    requestDaemonStop();
    return;
  }
  console.log(
    'Usage: mama init | secret set <NAME> | secret list | daemon | replay | backfill <file> | status | stop'
  );
}

void main().catch((error: unknown) => {
  if (error instanceof CliInputError || error instanceof ConfigError) {
    console.error(error.message);
  } else {
    // Unexpected error metadata can contain credentials; print only bounded diagnostic identifiers.
    const name =
      error instanceof Error && /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(error.name)
        ? error.name
        : 'Error';
    const rawCode =
      error !== null && typeof error === 'object' && 'code' in error ? error.code : undefined;
    const code =
      typeof rawCode === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(rawCode)
        ? rawCode
        : 'UNEXPECTED';
    console.error(`mama command failed (${name}, ${code})`);
  }
  process.exitCode = 1;
});
