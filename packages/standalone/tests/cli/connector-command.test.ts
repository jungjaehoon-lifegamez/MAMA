import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createConnectorCommand } from '../../src/cli/commands/connector.js';

const tempDirectories: string[] = [];

function createTempDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'mama-connector-command-'));
  tempDirectories.push(directory);
  return directory;
}

async function runConnectorCommand(
  args: string[],
  configPath: string
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  process.exitCode = undefined;
  const command = createConnectorCommand({
    configPath,
    writeOut: (line) => stdout.push(line),
    writeError: (line) => stderr.push(line),
  });
  await command.parseAsync(args, { from: 'user' });
  const exitCode = process.exitCode ?? 0;
  process.exitCode = undefined;
  return { stdout: stdout.join('\n'), stderr: stderr.join('\n'), exitCode };
}

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('Story private connector isolation: connector command discovery boundary', () => {
  it('TG-01/TG-05/TG-06: does not advertise or add the private connector on a fresh install', async () => {
    const configPath = join(createTempDirectory(), 'fresh-connectors.json');

    const result = await runConnectorCommand(['list'], configPath);
    expect(result.stdout).toContain('✗ disabled  slack');
    expect(result.stdout).not.toContain('kagemusha');

    const add = await runConnectorCommand(['add', 'kagemusha'], configPath);
    expect(add.exitCode).toBe(1);
    expect(add.stderr).not.toContain('kagemusha,');
  });

  it('TG-01/TG-05/TG-06: shows and removes an already configured private connector', async () => {
    const configPath = join(createTempDirectory(), 'configured-connectors.json');
    writeFileSync(
      configPath,
      JSON.stringify({
        kagemusha: {
          enabled: true,
          pollIntervalMinutes: 60,
          channels: {},
          auth: { type: 'none' },
        },
      })
    );

    expect((await runConnectorCommand(['list'], configPath)).stdout).toContain('kagemusha');
    expect((await runConnectorCommand(['remove', 'kagemusha'], configPath)).exitCode).toBe(0);
  });
});
