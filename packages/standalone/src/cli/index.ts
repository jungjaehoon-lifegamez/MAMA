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
  if (command === 'logs') {
    const { runLogs } = await import('./commands/logs.js');
    const controller = new AbortController();
    process.once('SIGINT', () => controller.abort());
    await runLogs(process.argv.slice(3), { signal: controller.signal });
    return;
  }
  if (command === 'daemon') {
    const { runDaemon } = await import('./commands/daemon.js');
    const { InstallBusyError, RestorePendingError } = await import('./runtime/daemon-control.js');
    try {
      const { DAEMON_LOG_LIMITS, openRotatingLog, takeOverOutput } =
        await import('../runtime/rotating-log.js');
      await runDaemon({
        captureOutput: (logFile) => takeOverOutput(openRotatingLog(logFile, DAEMON_LOG_LIMITS)),
      });
    } catch (error) {
      // Another process already holds this install, or a restore is unfinished: a clean exit,
      // which the service files leave stopped (they restart only after a failure).
      // A newer schema stays newer too; restarting into the refusal would only repeat it.
      if (
        !(error instanceof InstallBusyError) &&
        !(error instanceof RestorePendingError) &&
        !isNewerSchema(error)
      ) {
        // The log line above names the error; this names the stage and the next step.
        const stage = (error as { bootStage?: unknown }).bootStage;
        if (typeof stage === 'string') {
          console.error(
            `mama daemon failed at boot stage ${stage}; mama doctor checks the install`
          );
        }
        throw error;
      }
      console.error((error as Error).message);
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
  if (command === 'restore') {
    const { runRestore } = await import('./commands/restore.js');
    await runRestore(process.argv.slice(3));
    return;
  }
  if (command === 'backup') {
    const { runBackup } = await import('./commands/backup.js');
    await runBackup(process.argv.slice(3));
    return;
  }
  if (command === 'doctor') {
    const { runDoctor } = await import('./commands/doctor.js');
    process.exitCode = await runDoctor(process.argv.slice(3));
    // A source probe that timed out may still hold a socket; once the output has drained, leave.
    setTimeout(() => process.exit(), 1_000).unref();
    return;
  }
  if (command === 'uninstall') {
    const { runUninstall } = await import('./commands/uninstall.js');
    process.exitCode = await runUninstall(process.argv.slice(3));
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
    'Usage: mama init | tools install | secret set <NAME> | secret list | register-owner <telegram id> | daemon | replay | backfill <file> | status [--json] | stop | service install|start|stop|restart|status|uninstall | uninstall [--dry-run] [--data [--toolkit]] | doctor [--json] [--offline] [--report] | logs [-n <lines>] [--follow] | backup [--include-secrets] [--logs] | restore <archive> | restore --rollback'
  );
}

/** Core's refusal of a database a newer version migrated; its message is core's own text. */
function isNewerSchema(error: unknown): error is Error {
  return error instanceof Error && (error as { code?: unknown }).code === 'MAMA_SCHEMA_NEWER';
}

void main().catch((error: unknown) => {
  if (error instanceof CliInputError || error instanceof ConfigError || isNewerSchema(error)) {
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
