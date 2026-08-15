import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as yaml from 'js-yaml';

import { backendForModel, rescopeConfigModels } from '../../src/agent/backend-model-policy.js';
import { loadConfig } from '../../src/cli/config/config-manager.js';
import { DEFAULT_ROLES } from '../../src/cli/config/types.js';

type Backend = 'claude' | 'codex' | 'cline';
type MatrixMode = 'clean' | 'cross-backend-leftovers' | 'same-backend-override';

const SWITCH_SEQUENCE: readonly Backend[] = ['codex', 'claude', 'cline', 'codex'];
const PRIMARY_MODELS: Readonly<Record<Backend, string>> = {
  claude: 'claude-sonnet-4-6',
  codex: 'gpt-5.6-sol',
  cline: 'deepseek/deepseek-v4-flash',
};
const SAME_BACKEND_OVERRIDES: Readonly<Record<Backend, string>> = {
  claude: 'claude-opus-4-6',
  codex: 'gpt-5.4',
  cline: 'openrouter/qwen3-coder',
};
const LEFTOVER_BACKENDS: readonly Backend[] = ['claude', 'codex', 'claude', 'cline'];

let testHome: string;
let originalHome: string | undefined;

function roleModels(model: string, override?: string): Record<string, string> {
  return Object.fromEntries(
    Object.keys(DEFAULT_ROLES.definitions).map((name) => [
      name,
      name === 'chat_bot' && override ? override : model,
    ])
  );
}

async function writeRawConfig(input: {
  backend: Backend;
  agentModel: string;
  configuredRoleModels: Record<string, string>;
}): Promise<void> {
  const mamaDir = join(testHome, '.mama');
  await mkdir(mamaDir, { recursive: true });
  const definitions = Object.fromEntries(
    Object.entries(DEFAULT_ROLES.definitions).map(([name, role]) => [
      name,
      { ...role, model: input.configuredRoleModels[name] },
    ])
  );
  await writeFile(
    join(mamaDir, 'config.yaml'),
    yaml.dump({
      version: 1,
      agent: { backend: input.backend, model: input.agentModel },
      database: { path: ':memory:' },
      roles: { definitions, sourceMapping: DEFAULT_ROLES.sourceMapping },
    })
  );
}

beforeEach(async () => {
  testHome = await mkdtemp(join(tmpdir(), 'mama-backend-switch-matrix-'));
  originalHome = process.env.HOME;
  process.env.HOME = testHome;
});

afterEach(async () => {
  vi.restoreAllMocks();
  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }
  await rm(testHome, { recursive: true, force: true });
});

describe('backend switch model matrix', () => {
  it.each<MatrixMode>(['clean', 'cross-backend-leftovers', 'same-backend-override'])(
    'loads codex -> claude -> cline -> codex with %s models in the active family',
    async (mode) => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

      for (const [index, backend] of SWITCH_SEQUENCE.entries()) {
        const staleBackend = LEFTOVER_BACKENDS[index];
        if (!staleBackend) {
          throw new Error(`Missing leftover backend for matrix step ${index}`);
        }
        const configuredAgentModel =
          mode === 'cross-backend-leftovers'
            ? PRIMARY_MODELS[staleBackend]
            : PRIMARY_MODELS[backend];
        const configuredRoleModels =
          mode === 'cross-backend-leftovers'
            ? roleModels(PRIMARY_MODELS[staleBackend])
            : roleModels(
                PRIMARY_MODELS[backend],
                mode === 'same-backend-override' ? SAME_BACKEND_OVERRIDES[backend] : undefined
              );
        const expectedRescope = rescopeConfigModels({
          backend,
          agentModel: configuredAgentModel,
          roleModels: configuredRoleModels,
        });

        await writeRawConfig({ backend, agentModel: configuredAgentModel, configuredRoleModels });
        warn.mockClear();
        const loaded = await loadConfig();

        expect(backendForModel(loaded.agent.model), `${mode} ${backend} agent.model`).toBe(backend);
        for (const [roleName, role] of Object.entries(loaded.roles?.definitions ?? {})) {
          expect(backendForModel(role.model), `${mode} ${backend} ${roleName}`).toBe(backend);
        }
        expect(warn).toHaveBeenCalledTimes(expectedRescope.changes.length);
        for (const [line] of warn.mock.calls) {
          expect(String(line)).toContain('[MAMA CONFIG WARNING] Rescoped');
        }

        if (mode === 'same-backend-override') {
          expect(loaded.roles?.definitions.chat_bot?.model).toBe(SAME_BACKEND_OVERRIDES[backend]);
        }
      }
    }
  );
});
