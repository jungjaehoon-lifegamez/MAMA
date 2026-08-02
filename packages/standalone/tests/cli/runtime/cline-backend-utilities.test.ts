import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  hasClineBackendConfigured,
  resolveClineCommandForStartup,
} from '../../../src/cli/runtime/utilities.js';
import type { MAMAConfig } from '../../../src/cli/config/types.js';

const originalCommand = process.env.MAMA_CLINE_COMMAND;
const originalLegacyCommand = process.env.CLINE_COMMAND;
const originalPath = process.env.PATH;

afterEach(() => {
  if (originalCommand === undefined) {
    delete process.env.MAMA_CLINE_COMMAND;
  } else {
    process.env.MAMA_CLINE_COMMAND = originalCommand;
  }
  if (originalLegacyCommand === undefined) delete process.env.CLINE_COMMAND;
  else process.env.CLINE_COMMAND = originalLegacyCommand;
  process.env.PATH = originalPath;
});

describe('Cline backend startup utilities', () => {
  it('resolves an explicit executable Cline command', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mama-cline-command-'));
    const command = join(dir, 'cline');
    writeFileSync(command, '#!/bin/sh\nexit 0\n', 'utf8');
    chmodSync(command, 0o700);
    process.env.MAMA_CLINE_COMMAND = command;

    expect(resolveClineCommandForStartup()).toBe(command);
    rmSync(dir, { recursive: true, force: true });
  });

  it('uses configured, MAMA_CLINE_COMMAND, CLINE_COMMAND, then PATH precedence', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mama-cline-precedence-'));
    const configured = join(dir, 'configured-cline');
    const mamaEnv = join(dir, 'mama-env-cline');
    const legacyEnv = join(dir, 'legacy-env-cline');
    const pathCommand = join(dir, 'cline');
    for (const command of [configured, mamaEnv, legacyEnv, pathCommand]) {
      writeFileSync(command, '#!/bin/sh\nexit 0\n', 'utf8');
      chmodSync(command, 0o700);
    }
    process.env.MAMA_CLINE_COMMAND = mamaEnv;
    process.env.CLINE_COMMAND = legacyEnv;
    process.env.PATH = dir;

    expect(resolveClineCommandForStartup(configured)).toBe(configured);
    expect(resolveClineCommandForStartup()).toBe(mamaEnv);
    delete process.env.MAMA_CLINE_COMMAND;
    expect(resolveClineCommandForStartup()).toBe(legacyEnv);
    delete process.env.CLINE_COMMAND;
    expect(resolveClineCommandForStartup()).toBe(pathCommand);
    rmSync(dir, { recursive: true, force: true });
  });

  it('fails explicitly when configured candidates are non-executable and PATH has no Cline', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mama-cline-nonexec-'));
    const command = join(dir, 'cline');
    writeFileSync(command, '#!/bin/sh\nexit 0\n', 'utf8');
    chmodSync(command, 0o600);
    delete process.env.MAMA_CLINE_COMMAND;
    delete process.env.CLINE_COMMAND;
    process.env.PATH = dir;

    expect(() => resolveClineCommandForStartup(command)).toThrow('Cline command not found');
    rmSync(dir, { recursive: true, force: true });
  });

  it('detects Cline on the main or managed-agent backend', () => {
    const config = {
      agent: { backend: 'claude' },
      multi_agent: { agents: { reviewer: { backend: 'cline' } } },
    } as unknown as MAMAConfig;

    expect(hasClineBackendConfigured(config)).toBe(true);
    expect(
      hasClineBackendConfigured({
        ...config,
        multi_agent: { agents: { reviewer: { backend: 'codex' } } },
      } as unknown as MAMAConfig)
    ).toBe(false);
  });
});
