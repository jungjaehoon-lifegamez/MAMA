/**
 * Tests for Story M3.3: Plugin Manifests (plugin.json, .mcp.json)
 *
 * AC1: plugin.json lists all commands, skills, hooks with accurate descriptions
 * AC2: hooks.json registers hooks (integrated into plugin.json per official spec)
 * AC3: .mcp.json includes stdio configuration
 * AC4: README references manifest files
 * AC5: Validation script passes
 */

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PLUGIN_ROOT = path.resolve(__dirname, '../..');
const PLUGIN_JSON_PATH = path.join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json');
const MCP_JSON_PATH = path.join(PLUGIN_ROOT, '.mcp.json');
const README_PATH = path.join(PLUGIN_ROOT, 'README.md');
const VALIDATION_SCRIPT = path.join(PLUGIN_ROOT, 'scripts', 'validate-manifests.js');

describe('M3.3: Plugin Manifests', () => {
  describe('AC1: plugin.json lists all components', () => {
    it('should have valid plugin.json file', () => {
      expect(fs.existsSync(PLUGIN_JSON_PATH)).toBe(true);

      const content = fs.readFileSync(PLUGIN_JSON_PATH, 'utf8');
      const pluginConfig = JSON.parse(content);

      expect(pluginConfig).toBeDefined();
      expect(pluginConfig.name).toBe('mama');
      expect(pluginConfig.version).toBeDefined();
      expect(pluginConfig.description).toBeDefined();
    });

    it('should list all commands with correct paths', () => {
      const pluginConfig = JSON.parse(fs.readFileSync(PLUGIN_JSON_PATH, 'utf8'));

      expect(pluginConfig.commands).toBeDefined();
      expect(Array.isArray(pluginConfig.commands)).toBe(true);
      expect(pluginConfig.commands.length).toBeGreaterThan(0);

      // Verify each command file exists
      pluginConfig.commands.forEach(cmd => {
        const cmdPath = path.join(PLUGIN_ROOT, '.claude-plugin', cmd);
        expect(fs.existsSync(cmdPath)).toBe(true);
      });

      // Expected commands (M3.1)
      const expectedCommands = [
        'mama-recall',
        'mama-suggest',
        'mama-list',
        'mama-save',
        'mama-configure'
      ];

      expectedCommands.forEach(cmdName => {
        const found = pluginConfig.commands.some(cmd => cmd.includes(cmdName));
        expect(found).toBe(true);
      });
    });

    it('should list mama-context skill with description', () => {
      const pluginConfig = JSON.parse(fs.readFileSync(PLUGIN_JSON_PATH, 'utf8'));

      expect(pluginConfig.skills).toBeDefined();
      expect(Array.isArray(pluginConfig.skills)).toBe(true);

      const mamaSkill = pluginConfig.skills.find(s => s.name === 'mama-context');
      expect(mamaSkill).toBeDefined();
      expect(mamaSkill.path).toBeDefined();
      expect(mamaSkill.description).toBeDefined();

      // Verify skill SKILL.md exists
      const skillPath = path.join(PLUGIN_ROOT, '.claude-plugin', mamaSkill.path, 'SKILL.md');
      expect(fs.existsSync(skillPath)).toBe(true);
    });

    it('should list all hooks with entry points', () => {
      const pluginConfig = JSON.parse(fs.readFileSync(PLUGIN_JSON_PATH, 'utf8'));

      expect(pluginConfig.hooks).toBeDefined();

      // Expected hooks (M2.1, M2.2, M2.3)
      const expectedHooks = ['UserPromptSubmit', 'PreToolUse', 'PostToolUse'];

      expectedHooks.forEach(hookType => {
        expect(pluginConfig.hooks[hookType]).toBeDefined();
        expect(Array.isArray(pluginConfig.hooks[hookType])).toBe(true);
      });

      // Verify hook scripts exist and are executable
      const hookScripts = [
        'scripts/userpromptsubmit-hook.js',
        'scripts/pretooluse-hook.js',
        'scripts/posttooluse-hook.js'
      ];

      hookScripts.forEach(script => {
        const scriptPath = path.join(PLUGIN_ROOT, script);
        expect(fs.existsSync(scriptPath)).toBe(true);

        const stat = fs.statSync(scriptPath);
        expect(stat.mode & 0o111).toBeGreaterThan(0); // Has execute bit
      });
    });

    it('should use portable paths with ${CLAUDE_PLUGIN_ROOT}', () => {
      const pluginConfig = JSON.parse(fs.readFileSync(PLUGIN_JSON_PATH, 'utf8'));

      const allHooks = [];
      Object.values(pluginConfig.hooks).forEach(hookConfigs => {
        hookConfigs.forEach(config => {
          config.hooks.forEach(hook => {
            allHooks.push(hook.command);
          });
        });
      });

      allHooks.forEach(command => {
        expect(command).toContain('${CLAUDE_PLUGIN_ROOT}');
      });
    });
  });

  describe('AC2: Hooks registered in plugin.json (unified manifest)', () => {
    it('should have hooks integrated in plugin.json (not separate hooks.json)', () => {
      // According to architecture decision mama_architecture_plugin_structure:
      // hooks.json is deprecated, hooks should be in plugin.json

      const hookJsonPath = path.join(PLUGIN_ROOT, 'hooks', 'hooks.json');
      expect(fs.existsSync(hookJsonPath)).toBe(false);

      const pluginConfig = JSON.parse(fs.readFileSync(PLUGIN_JSON_PATH, 'utf8'));
      expect(pluginConfig.hooks).toBeDefined();
    });

    it('should register UserPromptSubmit hook correctly', () => {
      const pluginConfig = JSON.parse(fs.readFileSync(PLUGIN_JSON_PATH, 'utf8'));

      const userPromptHooks = pluginConfig.hooks.UserPromptSubmit;
      expect(userPromptHooks).toBeDefined();
      expect(userPromptHooks.length).toBeGreaterThan(0);

      const hook = userPromptHooks[0];
      expect(hook.matcher).toBe('*');
      expect(hook.hooks).toBeDefined();
      expect(hook.hooks[0].command).toContain('userpromptsubmit-hook.js');
    });

    it('should register PreToolUse hook correctly', () => {
      const pluginConfig = JSON.parse(fs.readFileSync(PLUGIN_JSON_PATH, 'utf8'));

      const preToolHooks = pluginConfig.hooks.PreToolUse;
      expect(preToolHooks).toBeDefined();

      const hook = preToolHooks[0];
      expect(hook.matcher).toMatch(/Read|Edit|Grep/);
      expect(hook.hooks[0].command).toContain('pretooluse-hook.js');
    });

    it('should register PostToolUse hook correctly', () => {
      const pluginConfig = JSON.parse(fs.readFileSync(PLUGIN_JSON_PATH, 'utf8'));

      const postToolHooks = pluginConfig.hooks.PostToolUse;
      expect(postToolHooks).toBeDefined();

      const hook = postToolHooks[0];
      expect(hook.matcher).toMatch(/Write|Edit/);
      expect(hook.hooks[0].command).toContain('posttooluse-hook.js');
    });
  });

  describe('AC3: .mcp.json includes stdio configuration', () => {
    it('should have valid .mcp.json file', () => {
      expect(fs.existsSync(MCP_JSON_PATH)).toBe(true);

      const content = fs.readFileSync(MCP_JSON_PATH, 'utf8');
      const mcpConfig = JSON.parse(content);

      expect(mcpConfig).toBeDefined();
      expect(mcpConfig.mcpServers).toBeDefined();
    });

    it('should configure MAMA server with stdio transport', () => {
      const mcpConfig = JSON.parse(fs.readFileSync(MCP_JSON_PATH, 'utf8'));

      expect(mcpConfig.mcpServers.mama).toBeDefined();

      const mamaServer = mcpConfig.mcpServers.mama;
      expect(mamaServer.command).toBe('node');
      expect(mamaServer.args).toBeDefined();
      expect(Array.isArray(mamaServer.args)).toBe(true);
      expect(mamaServer.args.length).toBeGreaterThan(0);
    });

    it('should include required environment variables', () => {
      const mcpConfig = JSON.parse(fs.readFileSync(MCP_JSON_PATH, 'utf8'));

      const mamaServer = mcpConfig.mcpServers.mama;
      expect(mamaServer.env).toBeDefined();

      const requiredEnvVars = [
        'MAMA_DATABASE_PATH',
        'MAMA_EMBEDDING_MODEL',
        'MCP_TRANSPORT'
      ];

      requiredEnvVars.forEach(envVar => {
        expect(mamaServer.env[envVar]).toBeDefined();
      });

      // Verify MCP_TRANSPORT is stdio
      expect(mamaServer.env.MCP_TRANSPORT).toBe('stdio');
    });

    it('should use portable paths in .mcp.json', () => {
      const mcpConfig = JSON.parse(fs.readFileSync(MCP_JSON_PATH, 'utf8'));

      const mamaServer = mcpConfig.mcpServers.mama;

      // Check for ${CLAUDE_PLUGIN_ROOT} or ${HOME}
      const argsStr = JSON.stringify(mamaServer.args);
      expect(argsStr).toMatch(/\$\{.*\}/);

      if (mamaServer.env.MAMA_DATABASE_PATH) {
        expect(mamaServer.env.MAMA_DATABASE_PATH).toMatch(/\$\{.*\}/);
      }
    });

    it('should include description for MAMA server', () => {
      const mcpConfig = JSON.parse(fs.readFileSync(MCP_JSON_PATH, 'utf8'));

      const mamaServer = mcpConfig.mcpServers.mama;
      expect(mamaServer.description).toBeDefined();
      expect(mamaServer.description).toContain('MAMA');
    });
  });

  describe('AC4: README references manifest files', () => {
    it('should have README.md file', () => {
      expect(fs.existsSync(README_PATH)).toBe(true);
    });

    it('should reference plugin.json in README', () => {
      const readme = fs.readFileSync(README_PATH, 'utf8');

      expect(readme).toContain('plugin.json');
      expect(readme).toContain('.claude-plugin');
    });

    it('should reference .mcp.json in README', () => {
      const readme = fs.readFileSync(README_PATH, 'utf8');

      expect(readme).toContain('.mcp.json');
      expect(readme).toContain('MCP');
    });

    it('should provide installation instructions', () => {
      const readme = fs.readFileSync(README_PATH, 'utf8');

      expect(readme).toContain('Installation');
      expect(readme).toContain('Quick Install');
      expect(readme).toMatch(/npm install|npm i/);
    });

    it('should show copy-paste steps', () => {
      const readme = fs.readFileSync(README_PATH, 'utf8');

      // Should have code blocks with actual commands
      expect(readme).toMatch(/```bash|```sh/);
      expect(readme).toContain('cp ');
      expect(readme).toContain('cd ');
    });

    it('should explain manifest files', () => {
      const readme = fs.readFileSync(README_PATH, 'utf8');

      expect(readme).toContain('Manifest Files');
      expect(readme).toContain('Unified Manifest');
      expect(readme).toContain('stdio');
    });
  });

  describe('AC5: Validation script passes', () => {
    it('should have validation script', () => {
      expect(fs.existsSync(VALIDATION_SCRIPT)).toBe(true);

      const stat = fs.statSync(VALIDATION_SCRIPT);
      expect(stat.mode & 0o111).toBeGreaterThan(0); // Executable
    });

    it('should pass validation when run', () => {
      const output = execSync(`node ${VALIDATION_SCRIPT}`, {
        encoding: 'utf8',
        stdio: 'pipe'
      });

      expect(output).toContain('ALL VALIDATIONS PASSED');
      expect(output).toContain('❌ Errors: 0'); // Should have zero errors
      expect(output).not.toContain('VALIDATION FAILED');
    });

    it('should validate plugin.json structure', () => {
      const output = execSync(`node ${VALIDATION_SCRIPT}`, {
        encoding: 'utf8',
        stdio: 'pipe'
      });

      expect(output).toContain('plugin.json: Valid JSON');
      expect(output).toContain('plugin.json has name');
      expect(output).toContain('plugin.json has version');
    });

    it('should validate .mcp.json structure', () => {
      const output = execSync(`node ${VALIDATION_SCRIPT}`, {
        encoding: 'utf8',
        stdio: 'pipe'
      });

      expect(output).toContain('.mcp.json: Valid JSON');
      expect(output).toContain('.mcp.json has 1 servers');
    });

    it('should verify all commands exist', () => {
      const output = execSync(`node ${VALIDATION_SCRIPT}`, {
        encoding: 'utf8',
        stdio: 'pipe'
      });

      expect(output).toContain('Command exists:');
      expect(output).toContain('mama-recall');
      expect(output).toContain('mama-suggest');
      expect(output).toContain('mama-list');
      expect(output).toContain('mama-save');
      expect(output).toContain('mama-configure');
    });

    it('should verify all hook scripts are executable', () => {
      const output = execSync(`node ${VALIDATION_SCRIPT}`, {
        encoding: 'utf8',
        stdio: 'pipe'
      });

      expect(output).toContain('Hook script executable:');
      expect(output).toContain('userpromptsubmit-hook.js');
      expect(output).toContain('pretooluse-hook.js');
      expect(output).toContain('posttooluse-hook.js');
    });

    it('should show summary with pass count', () => {
      const output = execSync(`node ${VALIDATION_SCRIPT}`, {
        encoding: 'utf8',
        stdio: 'pipe'
      });

      expect(output).toContain('Validation Summary');
      expect(output).toMatch(/✅ Passed: \d+/);
      expect(output).toMatch(/❌ Errors: 0/);
    });
  });

  describe('Integration: All manifests work together', () => {
    it('should have consistent naming across manifests', () => {
      const pluginConfig = JSON.parse(fs.readFileSync(PLUGIN_JSON_PATH, 'utf8'));
      const mcpConfig = JSON.parse(fs.readFileSync(MCP_JSON_PATH, 'utf8'));

      expect(pluginConfig.name).toBe('mama');
      expect(mcpConfig.mcpServers.mama).toBeDefined();
    });

    it('should have matching versions', () => {
      const pluginConfig = JSON.parse(fs.readFileSync(PLUGIN_JSON_PATH, 'utf8'));
      const packageJson = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, 'package.json'), 'utf8'));

      expect(pluginConfig.version).toBe(packageJson.version);
    });

    it('should reference same embedding model in .mcp.json and docs', () => {
      const mcpConfig = JSON.parse(fs.readFileSync(MCP_JSON_PATH, 'utf8'));
      const readme = fs.readFileSync(README_PATH, 'utf8');

      const model = mcpConfig.mcpServers.mama.env.MAMA_EMBEDDING_MODEL;
      expect(model).toBeDefined();
      expect(readme).toContain(model);
    });
  });
});
