/**
 * Unit tests for ConfigManager
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import * as yaml from 'js-yaml';

import {
  expandPath,
  loadConfig,
  saveConfig,
  createDefaultConfig,
  validateConfig,
} from '../../src/cli/config/config-manager.js';
import { DEFAULT_CONFIG } from '../../src/cli/config/types.js';
import type { MAMAConfig } from '../../src/cli/config/types.js';

describe('ConfigManager', () => {
  let testDir: string;
  let originalHome: string | undefined;

  beforeEach(async () => {
    // Create temp directory with random suffix to avoid collisions
    testDir = join(tmpdir(), `mama-cfg-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(testDir, { recursive: true });

    // Save and override HOME
    originalHome = process.env.HOME;
    process.env.HOME = testDir;
  });

  afterEach(async () => {
    // Restore HOME
    if (originalHome !== undefined) {
      process.env.HOME = originalHome;
    } else {
      delete process.env.HOME;
    }

    // Clean up
    await rm(testDir, { recursive: true, force: true });
  });

  describe('expandPath()', () => {
    it('should expand ~ to home directory', () => {
      const expanded = expandPath('~/.mama/config.yaml');
      expect(expanded).toBe(join(testDir, '.mama/config.yaml'));
    });

    it('should not modify paths without ~', () => {
      const path = '/absolute/path/to/file';
      expect(expandPath(path)).toBe(path);
    });

    it('should handle ~ in the middle of path', () => {
      // Only leading ~ should be expanded
      const path = '/path/to/~file';
      expect(expandPath(path)).toBe(path);
    });
  });

  describe('saveConfig() and loadConfig()', () => {
    it('should save and load config', async () => {
      const config: MAMAConfig = {
        version: 1,
        agent: {
          model: 'test-model',
          max_turns: 5,
          timeout: 60000,
        },
        database: {
          path: '~/.test/db.sqlite',
        },
        logging: {
          level: 'debug',
          file: '~/.test/logs/test.log',
        },
      };

      await saveConfig(config);
      const loaded = await loadConfig();

      expect(loaded.version).toBe(1);
      expect(loaded.agent.model).toBe('test-model');
      expect(loaded.agent.max_turns).toBe(5);
      expect(loaded.database.path).toBe('~/.test/db.sqlite');
      expect(loaded.logging.level).toBe('debug');
    });

    it('should throw error when config file not found', async () => {
      await expect(loadConfig()).rejects.toThrow(/not found/);
    });

    it('should merge with defaults for missing fields', async () => {
      // Create minimal config
      const mamaDir = join(testDir, '.mama');
      await mkdir(mamaDir, { recursive: true });
      const configPath = join(mamaDir, 'config.yaml');

      const minimalConfig = {
        version: 1,
        agent: { model: 'custom-model' },
        database: { path: '~/.test/db.sqlite' },
      };

      await writeFile(configPath, yaml.dump(minimalConfig));

      const loaded = await loadConfig();

      // Custom values
      expect(loaded.agent.model).toBe('custom-model');
      // Default values filled in
      expect(loaded.agent.max_turns).toBe(DEFAULT_CONFIG.agent.max_turns);
      expect(loaded.logging.level).toBe(DEFAULT_CONFIG.logging.level);
    });
  });

  describe('createDefaultConfig()', () => {
    it('should create default config file', async () => {
      const configPath = await createDefaultConfig();

      expect(existsSync(configPath)).toBe(true);

      const loaded = await loadConfig();
      expect(loaded.version).toBe(1);
      expect(loaded.agent.model).toBe(DEFAULT_CONFIG.agent.model);
    });

    it('should throw error if config exists and force is false', async () => {
      await createDefaultConfig();

      await expect(createDefaultConfig(false)).rejects.toThrow(/already exists/);
    });

    it('should overwrite config if force is true', async () => {
      await createDefaultConfig();
      await createDefaultConfig(true);

      const loaded = await loadConfig();
      expect(loaded.version).toBe(1);
    });

    it('should create logs directory', async () => {
      await createDefaultConfig();

      const logsDir = join(testDir, '.mama', 'logs');
      expect(existsSync(logsDir)).toBe(true);
    });
  });

  describe('validateConfig()', () => {
    it('should return empty array for valid config', () => {
      const errors = validateConfig(DEFAULT_CONFIG);
      expect(errors).toHaveLength(0);
    });

    it('should detect invalid version', () => {
      const config = { ...DEFAULT_CONFIG, version: 2 };
      const errors = validateConfig(config);
      expect(errors).toContain('Unsupported config version: 2');
    });

    it('should detect invalid max_turns', () => {
      const config = {
        ...DEFAULT_CONFIG,
        agent: { ...DEFAULT_CONFIG.agent, max_turns: 0 },
      };
      const errors = validateConfig(config);
      expect(errors.some((e) => e.includes('max_turns'))).toBe(true);
    });

    it('should detect invalid timeout', () => {
      const config = {
        ...DEFAULT_CONFIG,
        agent: { ...DEFAULT_CONFIG.agent, timeout: 100 },
      };
      const errors = validateConfig(config);
      expect(errors.some((e) => e.includes('timeout'))).toBe(true);
    });

    it('should detect invalid log level', () => {
      const config = {
        ...DEFAULT_CONFIG,
        logging: { ...DEFAULT_CONFIG.logging, level: 'invalid' as 'info' },
      };
      const errors = validateConfig(config);
      expect(errors.some((e) => e.includes('logging.level'))).toBe(true);
    });
  });
});
