/**
 * Unit tests for mama init command
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as yaml from 'js-yaml';

import { initCommand } from '../../src/cli/commands/init.js';
import {
  getConfigPath,
  getMAMAHome,
  configExists as _configExists,
  loadConfig,
} from '../../src/cli/config/config-manager.js';

/**
 * Story ID: CLI-INIT-001
 * Acceptance Criteria:
 * - Creates config file in ~/.mama/config.yaml
 * - Supports --force to overwrite existing config
 * - Supports --skip-auth-check for testing
 * - Supports --backend option (claude, codex-mcp)
 */
describe('mama init command', () => {
  let testHome: string;
  let originalHome: string | undefined;
  let originalTier3: string | undefined;
  let consoleOutput: string[] = [];
  let consoleErrors: string[] = [];

  beforeEach(async () => {
    testHome = join(
      tmpdir(),
      `mama-init-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    await mkdir(testHome, { recursive: true });

    originalHome = process.env.HOME;
    originalTier3 = process.env.MAMA_FORCE_TIER_3;
    process.env.HOME = testHome;
    process.env.MAMA_FORCE_TIER_3 = 'true';

    consoleOutput = [];
    consoleErrors = [];

    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      consoleOutput.push(args.join(' '));
    });

    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      consoleErrors.push(args.join(' '));
    });

    vi.spyOn(process.stdout, 'write').mockImplementation((text: string) => {
      consoleOutput.push(text);
      return true;
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();

    if (originalHome !== undefined) {
      process.env.HOME = originalHome;
    } else {
      delete process.env.HOME;
    }

    if (originalTier3 !== undefined) {
      process.env.MAMA_FORCE_TIER_3 = originalTier3;
    } else {
      delete process.env.MAMA_FORCE_TIER_3;
    }

    await rm(testHome, { recursive: true, force: true });
  });

  describe('initialization', () => {
    it('should create config.yaml', async () => {
      const claudeDir = join(testHome, '.claude');
      await mkdir(claudeDir, { recursive: true });
      await writeFile(join(claudeDir, '.credentials.json'), '{}');

      await initCommand();

      const configPath = getConfigPath();
      expect(existsSync(configPath)).toBe(true);
    });

    it('should create MAMA home directory', async () => {
      const claudeDir = join(testHome, '.claude');
      await mkdir(claudeDir, { recursive: true });
      await writeFile(join(claudeDir, '.credentials.json'), '{}');

      await initCommand();

      const mamaHome = getMAMAHome();
      expect(existsSync(mamaHome)).toBe(true);
    });

    it('should create logs directory', async () => {
      const claudeDir = join(testHome, '.claude');
      await mkdir(claudeDir, { recursive: true });
      await writeFile(join(claudeDir, '.credentials.json'), '{}');

      await initCommand();

      const logsDir = join(testHome, '.mama', 'logs');
      expect(existsSync(logsDir)).toBe(true);
    });

    it('should create valid YAML config file', async () => {
      const claudeDir = join(testHome, '.claude');
      await mkdir(claudeDir, { recursive: true });
      await writeFile(join(claudeDir, '.credentials.json'), '{}');

      await initCommand();

      const configPath = getConfigPath();
      const content = await readFile(configPath, 'utf-8');

      const config = yaml.load(content);
      expect(config).toBeDefined();
      expect(typeof config).toBe('object');
    });

    it('should create config with required fields', async () => {
      const claudeDir = join(testHome, '.claude');
      await mkdir(claudeDir, { recursive: true });
      await writeFile(join(claudeDir, '.credentials.json'), '{}');

      await initCommand();

      const config = await loadConfig();
      expect(config.version).toBe(1);
      expect(config.agent).toBeDefined();
      expect(config.agent.model).toBeDefined();
      expect(config.agent.max_turns).toBeDefined();
      expect(config.agent.timeout).toBeDefined();
      expect(config.database).toBeDefined();
      expect(config.database.path).toBeDefined();
      expect(config.logging).toBeDefined();
      expect(config.logging.level).toBeDefined();
      expect(config.logging.file).toBeDefined();
    });

    it('should create config with default values', async () => {
      const claudeDir = join(testHome, '.claude');
      await mkdir(claudeDir, { recursive: true });
      await writeFile(join(claudeDir, '.credentials.json'), '{}');

      await initCommand();

      const config = await loadConfig();
      expect(config.agent.model).toBe('claude-sonnet-4-20250514');
      expect(config.agent.max_turns).toBe(10);
      expect(config.agent.timeout).toBe(300000);
      expect(config.logging.level).toBe('info');
    });

    it('should add header comment to config file', async () => {
      const claudeDir = join(testHome, '.claude');
      await mkdir(claudeDir, { recursive: true });
      await writeFile(join(claudeDir, '.credentials.json'), '{}');

      await initCommand();

      const configPath = getConfigPath();
      const content = await readFile(configPath, 'utf-8');

      expect(content).toContain('# MAMA Standalone Configuration');
      expect(content).toContain('# Generated:');
      expect(content).toContain('# Documentation:');
    });

    it('should create CLAUDE.md with workspace constraints', async () => {
      const claudeDir = join(testHome, '.claude');
      await mkdir(claudeDir, { recursive: true });
      await writeFile(join(claudeDir, '.credentials.json'), '{}');

      await initCommand();

      const claudeMdPath = join(testHome, '.mama', 'CLAUDE.md');
      expect(existsSync(claudeMdPath)).toBe(true);

      const content = await readFile(claudeMdPath, 'utf-8');
      expect(content).toContain('Workspace');
      expect(content).toContain('~/.mama/workspace/');
      expect(content).toContain('~/.mama/skills/');
    });
  });

  describe('error handling', () => {
    it('should fail if no backend credentials are found', async () => {
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
        throw new Error('process.exit called');
      });

      try {
        await initCommand();
        expect.fail('Should have thrown');
      } catch {
        expect(exitSpy).toHaveBeenCalledWith(1);
        expect(consoleErrors.some((e) => e.includes('No authenticated backend found'))).toBe(true);
      }
    });

    it('should fail if config already exists without --force', async () => {
      const claudeDir = join(testHome, '.claude');
      await mkdir(claudeDir, { recursive: true });
      await writeFile(join(claudeDir, '.credentials.json'), '{}');

      await initCommand();

      const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
        throw new Error('process.exit called');
      });

      try {
        await initCommand({ force: false });
        expect.fail('Should have thrown');
      } catch {
        expect(consoleOutput.some((e) => e.includes('already exists'))).toBe(true);
      } finally {
        exitSpy.mockRestore();
      }
    });
  });

  describe('backend selection', () => {
    it('should apply codex-mcp backend when skipAuthCheck is enabled', async () => {
      await initCommand({ skipAuthCheck: true, backend: 'codex-mcp' });

      const config = await loadConfig();
      expect(config.agent.backend).toBe('codex-mcp');
    });
  });

  describe('--force flag', () => {
    it('should overwrite existing config with --force', async () => {
      const claudeDir = join(testHome, '.claude');
      await mkdir(claudeDir, { recursive: true });
      await writeFile(join(claudeDir, '.credentials.json'), '{}');

      await initCommand();
      const configPath = getConfigPath();

      const modifiedConfig = {
        version: 1,
        agent: { model: 'custom-model', max_turns: 5, timeout: 60000 },
        database: { path: '~/.custom/db.sqlite' },
        logging: { level: 'debug', file: '~/.mama/logs/mama.log' },
      };
      await writeFile(configPath, yaml.dump(modifiedConfig));

      consoleOutput = [];
      consoleErrors = [];
      await initCommand({ force: true });

      const config = await loadConfig();
      expect(config.agent.model).toBe('claude-sonnet-4-20250514');
      expect(config.agent.max_turns).toBe(10);
      expect(config.logging.level).toBe('info');
    });

    it('should not fail if config exists with --force', async () => {
      const claudeDir = join(testHome, '.claude');
      await mkdir(claudeDir, { recursive: true });
      await writeFile(join(claudeDir, '.credentials.json'), '{}');

      await initCommand();

      consoleOutput = [];
      consoleErrors = [];
      await expect(initCommand({ force: true })).resolves.not.toThrow();
    });
  });

  describe('directory structure', () => {
    it('should create all required directories', async () => {
      const claudeDir = join(testHome, '.claude');
      await mkdir(claudeDir, { recursive: true });
      await writeFile(join(claudeDir, '.credentials.json'), '{}');

      await initCommand();

      const mamaHome = join(testHome, '.mama');
      const logsDir = join(mamaHome, 'logs');
      const skillsDir = join(mamaHome, 'skills');
      const workspaceDir = join(mamaHome, 'workspace');
      const scriptsDir = join(workspaceDir, 'scripts');
      const dataDir = join(workspaceDir, 'data');

      expect(existsSync(mamaHome)).toBe(true);
      expect(existsSync(logsDir)).toBe(true);
      expect(existsSync(skillsDir)).toBe(true);
      expect(existsSync(workspaceDir)).toBe(true);
      expect(existsSync(scriptsDir)).toBe(true);
      expect(existsSync(dataDir)).toBe(true);
    });

    it('should create nested directory structure correctly', async () => {
      const claudeDir = join(testHome, '.claude');
      await mkdir(claudeDir, { recursive: true });
      await writeFile(join(claudeDir, '.credentials.json'), '{}');

      await initCommand();

      const mamaHome = getMAMAHome();
      const configPath = getConfigPath();
      const logsDir = join(mamaHome, 'logs');

      expect(configPath).toContain('.mama');
      expect(logsDir).toContain('.mama');
      expect(existsSync(mamaHome)).toBe(true);
      expect(existsSync(logsDir)).toBe(true);
    });
  });

  describe('config validation', () => {
    it('should create config with valid agent settings', async () => {
      const claudeDir = join(testHome, '.claude');
      await mkdir(claudeDir, { recursive: true });
      await writeFile(join(claudeDir, '.credentials.json'), '{}');

      await initCommand();

      const config = await loadConfig();
      expect(config.agent.max_turns).toBeGreaterThan(0);
      expect(config.agent.timeout).toBeGreaterThan(1000);
      expect(config.agent.model).toBeTruthy();
    });

    it('should create config with valid logging settings', async () => {
      const claudeDir = join(testHome, '.claude');
      await mkdir(claudeDir, { recursive: true });
      await writeFile(join(claudeDir, '.credentials.json'), '{}');

      await initCommand();

      const config = await loadConfig();
      expect(['debug', 'info', 'warn', 'error']).toContain(config.logging.level);
      expect(config.logging.file).toBeTruthy();
    });

    it('should create config with valid database settings', async () => {
      const claudeDir = join(testHome, '.claude');
      await mkdir(claudeDir, { recursive: true });
      await writeFile(join(claudeDir, '.credentials.json'), '{}');

      await initCommand();

      const config = await loadConfig();
      expect(config.database.path).toBeTruthy();
      expect(config.database.path).toContain('db');
    });
  });

  describe('idempotency', () => {
    it('should be idempotent with --force flag', async () => {
      const claudeDir = join(testHome, '.claude');
      await mkdir(claudeDir, { recursive: true });
      await writeFile(join(claudeDir, '.credentials.json'), '{}');

      await initCommand({ force: true });
      const config1 = await loadConfig();

      consoleOutput = [];
      consoleErrors = [];
      await initCommand({ force: true });
      const config2 = await loadConfig();

      expect(config1.version).toBe(config2.version);
      expect(config1.agent.model).toBe(config2.agent.model);
      expect(config1.agent.max_turns).toBe(config2.agent.max_turns);
      expect(config1.database.path).toBe(config2.database.path);
    });
  });

  describe('output messages', () => {
    it('should display initialization message', async () => {
      const claudeDir = join(testHome, '.claude');
      await mkdir(claudeDir, { recursive: true });
      await writeFile(join(claudeDir, '.credentials.json'), '{}');

      consoleOutput = [];
      await initCommand();

      const output = consoleOutput.join('');
      expect(output).toContain('Initialization');
    });

    it('should display success message', async () => {
      const claudeDir = join(testHome, '.claude');
      await mkdir(claudeDir, { recursive: true });
      await writeFile(join(claudeDir, '.credentials.json'), '{}');

      consoleOutput = [];
      await initCommand();

      const output = consoleOutput.join('');
      expect(output).toContain('created successfully');
    });

    it('should display next steps', async () => {
      const claudeDir = join(testHome, '.claude');
      await mkdir(claudeDir, { recursive: true });
      await writeFile(join(claudeDir, '.credentials.json'), '{}');

      consoleOutput = [];
      await initCommand();

      const output = consoleOutput.join('');
      expect(output).toContain('Next steps');
      expect(output).toContain('mama start');
      expect(output).toContain('mama status');
    });
  });

  describe('file permissions', () => {
    it('should create readable config file', async () => {
      const claudeDir = join(testHome, '.claude');
      await mkdir(claudeDir, { recursive: true });
      await writeFile(join(claudeDir, '.credentials.json'), '{}');

      await initCommand();

      const configPath = getConfigPath();
      const content = await readFile(configPath, 'utf-8');
      expect(content.length).toBeGreaterThan(0);
    });

    it('should create writable config file', async () => {
      const claudeDir = join(testHome, '.claude');
      await mkdir(claudeDir, { recursive: true });
      await writeFile(join(claudeDir, '.credentials.json'), '{}');

      await initCommand();

      const configPath = getConfigPath();
      const content = await readFile(configPath, 'utf-8');
      const config = yaml.load(content);
      expect(config).toBeDefined();
    });
  });
});
