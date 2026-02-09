/**
 * Config Loader Test
 * Story M1.4: Configurable embedding model selection
 *
 * AC #1: Config parser loads ~/.mama/config.json and exposes modelName, embeddingDim, cacheDir
 * AC #3: Changing model via config triggers informative log + resets caches
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

describe('Story M1.4: Config Loader', () => {
  const CONFIG_DIR = path.join(os.homedir(), '.mama');
  const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');
  const BACKUP_PATH = CONFIG_PATH + '.test-backup';

  // Backup existing config before tests
  beforeEach(() => {
    if (fs.existsSync(CONFIG_PATH)) {
      fs.copyFileSync(CONFIG_PATH, BACKUP_PATH);
    }
  });

  // Restore config after tests
  afterEach(() => {
    if (fs.existsSync(BACKUP_PATH)) {
      fs.copyFileSync(BACKUP_PATH, CONFIG_PATH);
      fs.unlinkSync(BACKUP_PATH);
    }
  });

  describe('Default configuration', () => {
    it('should export required functions', async () => {
      const configLoader = await import('@jungjaehoon/mama-core/config-loader');

      expect(configLoader.loadConfig).toBeDefined();
      expect(configLoader.getModelName).toBeDefined();
      expect(configLoader.getEmbeddingDim).toBeDefined();
      expect(configLoader.getCacheDir).toBeDefined();
      expect(configLoader.updateConfig).toBeDefined();
      expect(configLoader.getConfigPath).toBeDefined();
      expect(configLoader.DEFAULT_CONFIG).toBeDefined();
    });

    it('should have correct default config values', async () => {
      const { DEFAULT_CONFIG } = await import('@jungjaehoon/mama-core/config-loader');

      expect(DEFAULT_CONFIG.modelName).toBe('Xenova/multilingual-e5-small');
      expect(DEFAULT_CONFIG.embeddingDim).toBe(384);
      expect(DEFAULT_CONFIG.cacheDir).toContain('huggingface');
    });
  });

  describe('Config loading (AC #1)', () => {
    it('should load default config when file does not exist', async () => {
      // Remove config file if it exists
      if (fs.existsSync(CONFIG_PATH)) {
        fs.unlinkSync(CONFIG_PATH);
      }

      const { loadConfig, DEFAULT_CONFIG } = await import('@jungjaehoon/mama-core/config-loader');
      const config = loadConfig(true); // Force reload

      expect(config.modelName).toBe(DEFAULT_CONFIG.modelName);
      expect(config.embeddingDim).toBe(DEFAULT_CONFIG.embeddingDim);
      expect(config.cacheDir).toBe(DEFAULT_CONFIG.cacheDir);
    });

    it('should create config file on first load', async () => {
      // Remove config file
      if (fs.existsSync(CONFIG_PATH)) {
        fs.unlinkSync(CONFIG_PATH);
      }

      const { loadConfig } = await import('@jungjaehoon/mama-core/config-loader');
      loadConfig(true);

      expect(fs.existsSync(CONFIG_PATH)).toBe(true);

      const configData = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
      expect(configData.modelName).toBe('Xenova/multilingual-e5-small');
      expect(configData.embeddingDim).toBe(384);
    });

    it('should load custom config from file', async () => {
      // Write custom config
      const customConfig = {
        modelName: 'Xenova/gte-large',
        embeddingDim: 1024,
        cacheDir: '/tmp/custom-cache',
      };
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(customConfig, null, 2));

      const { loadConfig } = await import('@jungjaehoon/mama-core/config-loader');
      const config = loadConfig(true);

      expect(config.modelName).toBe('Xenova/gte-large');
      expect(config.embeddingDim).toBe(1024);
      expect(config.cacheDir).toBe('/tmp/custom-cache');
    });

    it('should use cached config on subsequent calls', async () => {
      const { loadConfig } = await import('@jungjaehoon/mama-core/config-loader');

      const config1 = loadConfig(true); // First load (forces reload)
      const config2 = loadConfig(false); // Second load (uses cache)

      expect(config1).toBe(config2); // Should be same object reference
    });
  });

  describe('Config getters (AC #1)', () => {
    it('should expose modelName via getModelName', async () => {
      const { getModelName } = await import('@jungjaehoon/mama-core/config-loader');
      const modelName = getModelName();

      expect(typeof modelName).toBe('string');
      expect(modelName.length).toBeGreaterThan(0);
    });

    it('should expose embeddingDim via getEmbeddingDim', async () => {
      const { getEmbeddingDim } = await import('@jungjaehoon/mama-core/config-loader');
      const dim = getEmbeddingDim();

      expect(typeof dim).toBe('number');
      expect(dim).toBeGreaterThan(0);
    });

    it('should expose cacheDir via getCacheDir', async () => {
      const { getCacheDir } = await import('@jungjaehoon/mama-core/config-loader');
      const cacheDir = getCacheDir();

      expect(typeof cacheDir).toBe('string');
      expect(cacheDir.length).toBeGreaterThan(0);
    });
  });

  describe('Config updates (AC #3)', () => {
    it('should update config file successfully', async () => {
      const { updateConfig, loadConfig } = await import('@jungjaehoon/mama-core/config-loader');

      const success = updateConfig({
        modelName: 'Xenova/test-model',
        embeddingDim: 512,
      });

      expect(success).toBe(true);

      const config = loadConfig(true);
      expect(config.modelName).toBe('Xenova/test-model');
      expect(config.embeddingDim).toBe(512);
    });

    it('should persist updates to disk', async () => {
      const { updateConfig } = await import('@jungjaehoon/mama-core/config-loader');

      updateConfig({
        modelName: 'Xenova/persisted-model',
      });

      // Read directly from file
      const configData = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
      expect(configData.modelName).toBe('Xenova/persisted-model');
    });

    it('should handle partial updates', async () => {
      const { updateConfig, loadConfig } = await import('@jungjaehoon/mama-core/config-loader');

      // Set initial config
      updateConfig({
        modelName: 'Xenova/initial-model',
        embeddingDim: 384,
      });

      // Update only model name
      updateConfig({
        modelName: 'Xenova/updated-model',
      });

      const config = loadConfig(true);
      expect(config.modelName).toBe('Xenova/updated-model');
      expect(config.embeddingDim).toBe(384); // Should remain unchanged
    });
  });

  describe('Config validation', () => {
    it('should handle invalid modelName gracefully', async () => {
      // Write config with invalid modelName
      const invalidConfig = {
        modelName: 123, // Invalid type
        embeddingDim: 384,
      };
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(invalidConfig, null, 2));

      const { loadConfig, DEFAULT_CONFIG } = await import('@jungjaehoon/mama-core/config-loader');
      const config = loadConfig(true);

      expect(config.modelName).toBe(DEFAULT_CONFIG.modelName); // Should fallback to default
    });

    it('should handle invalid embeddingDim gracefully', async () => {
      // Write config with invalid embeddingDim
      const invalidConfig = {
        modelName: 'Xenova/test-model',
        embeddingDim: 'invalid', // Invalid type
      };
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(invalidConfig, null, 2));

      const { loadConfig, DEFAULT_CONFIG } = await import('@jungjaehoon/mama-core/config-loader');
      const config = loadConfig(true);

      expect(config.embeddingDim).toBe(DEFAULT_CONFIG.embeddingDim); // Should fallback to default
    });

    it('should handle corrupted config file', async () => {
      // Write corrupted JSON
      fs.writeFileSync(CONFIG_PATH, '{ invalid json }');

      const { loadConfig, DEFAULT_CONFIG } = await import('@jungjaehoon/mama-core/config-loader');
      const config = loadConfig(true);

      // Should use defaults when parsing fails
      expect(config.modelName).toBe(DEFAULT_CONFIG.modelName);
      expect(config.embeddingDim).toBe(DEFAULT_CONFIG.embeddingDim);
    });
  });

  describe('Config path', () => {
    it('should return correct config path', async () => {
      const { getConfigPath } = await import('@jungjaehoon/mama-core/config-loader');
      const configPath = getConfigPath();

      expect(configPath).toContain('.mama');
      expect(configPath).toContain('config.json');
      expect(path.basename(configPath)).toBe('config.json');
    });
  });
});
