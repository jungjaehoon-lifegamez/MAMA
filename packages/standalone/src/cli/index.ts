#!/usr/bin/env node

import { ConfigError } from '../runtime/config.js';
import { CliInputError } from './prompt.js';

async function main(): Promise<void> {
  const command = process.argv[2];
  if (command === 'tools') {
    const { runTools } = await import('./commands/tools.js');
    await runTools(process.argv.slice(3));
    return;
  }
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
  if (command === 'register-owner') {
    const { runRegisterOwner } = await import('./commands/register-owner.js');
    await runRegisterOwner(process.argv.slice(3));
    return;
  }
  if (command === 'daemon') {
    const { runDaemon } = await import('./commands/daemon.js');
    const { InstallBusyError } = await import('./runtime/daemon-control.js');
    try {
      await runDaemon();
    } catch (error) {
      // Another process already holds this install: a clean exit, which the service files leave
      // stopped (they restart the daemon only after a failure; any other error exits 1).
      if (!(error instanceof InstallBusyError)) throw error;
      console.error(error.message);
    }
    return;
  }
  if (command === 'replay') {
    const { runReplay } = await import('./commands/replay.js');
    await runReplay();
    return;
  }
  if (command === 'backfill') {
    const { runBackfill } = await import('./commands/backfill.js');
    await runBackfill(process.argv.slice(3));
    return;
  }
  if (command === 'service') {
    const { runService } = await import('./commands/service.js');
    process.exitCode = await runService(process.argv.slice(3));
    return;
  }
  if (command === 'status') {
    const { runStatus } = await import('./commands/control.js');
    process.exitCode = await runStatus(process.argv.slice(3));
    return;
  }
  if (command === 'stop') {
    const { runStop } = await import('./commands/control.js');
    process.exitCode = await runStop(process.argv.slice(3));
    return;
  }
  console.log(
    'Usage: mama init | tools install | secret set <NAME> | secret list | register-owner <telegram id> | daemon | replay | backfill <file> | status [--json] | stop | service install|start|stop|restart|status|uninstall'
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
