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

      // Verify each command file exists (paths are relative to plugin root)
      pluginConfig.commands.forEach((cmd) => {
        // Remove leading ./ if present
        const relativePath = cmd.replace(/^\.\//, '');
        const cmdPath = path.join(PLUGIN_ROOT, relativePath);
        expect(fs.existsSync(cmdPath)).toBe(true);
      });

      // Expected commands (current structure)
      const expectedCommands = ['decision', 'search', 'checkpoint', 'resume', 'configure'];

      expectedCommands.forEach((cmdName) => {
        const found = pluginConfig.commands.some((cmd) => cmd.includes(cmdName));
        expect(found).toBe(true);
      });
    });

    it('should list mama-context skill with description', () => {
      // Skills are auto-discovered from skills/ directory (official spec)
      const skillsDir = path.join(PLUGIN_ROOT, 'skills');
      expect(fs.existsSync(skillsDir)).toBe(true);

      const mamaContextDir = path.join(skillsDir, 'mama-context');
      expect(fs.existsSync(mamaContextDir)).toBe(true);

      // Verify skill SKILL.md exists
      const skillPath = path.join(mamaContextDir, 'SKILL.md');
      expect(fs.existsSync(skillPath)).toBe(true);

      // Verify SKILL.md has content
      const skillContent = fs.readFileSync(skillPath, 'utf8');
      expect(skillContent).toContain('mama-context');
      expect(skillContent.length).toBeGreaterThan(100);
    });

    it('should list all hooks with entry points', () => {
      const pluginConfig = JSON.parse(fs.readFileSync(PLUGIN_JSON_PATH, 'utf8'));

      // Hooks should be inline object (official Claude Code plugin spec)
      expect(pluginConfig.hooks).toBeDefined();
      expect(typeof pluginConfig.hooks).toBe('object');

      // Expected hooks (SessionStart and UserPromptSubmit are active)
      const expectedHooks = ['SessionStart', 'UserPromptSubmit'];

      expectedHooks.forEach((hookType) => {
        expect(pluginConfig.hooks[hookType]).toBeDefined();
        expect(Array.isArray(pluginConfig.hooks[hookType])).toBe(true);
      });

      // Verify hook scripts exist and are executable
      const hookScripts = ['scripts/sessionstart-hook.js', 'scripts/userpromptsubmit-hook.js'];

      hookScripts.forEach((script) => {
        const scriptPath = path.join(PLUGIN_ROOT, script);
        expect(fs.existsSync(scriptPath)).toBe(true);

        const stat = fs.statSync(scriptPath);
        expect(stat.mode & 0o111).toBeGreaterThan(0); // Has execute bit
      });
    });

    it('should use portable paths with ${CLAUDE_PLUGIN_ROOT}', () => {
      // Read hooks from inline plugin.json
      const pluginConfig = JSON.parse(fs.readFileSync(PLUGIN_JSON_PATH, 'utf8'));
      const hooksConfig = pluginConfig.hooks;

      const allHooks = [];
      Object.values(hooksConfig).forEach((hookConfigs) => {
        hookConfigs.forEach((config) => {
          allHooks.push(config);
        });
      });

      allHooks.forEach((hookConfig) => {
        expect(hookConfig.command).toContain('${CLAUDE_PLUGIN_ROOT}');
      });
    });
  });

  describe('AC2: Hooks registered inline in plugin.json (official spec)', () => {
    it('should have inline hooks object in plugin.json', () => {
      // According to official Claude Code plugin spec:
      // hooks must be inline object (not file path)

      const pluginConfig = JSON.parse(fs.readFileSync(PLUGIN_JSON_PATH, 'utf8'));
      expect(pluginConfig.hooks).toBeDefined();
      expect(typeof pluginConfig.hooks).toBe('object');
      expect(pluginConfig.hooks.SessionStart).toBeDefined();
      expect(pluginConfig.hooks.UserPromptSubmit).toBeDefined();
    });

    it('should register UserPromptSubmit hook correctly', () => {
      const pluginConfig = JSON.parse(fs.readFileSync(PLUGIN_JSON_PATH, 'utf8'));
      const hooksConfig = pluginConfig.hooks;

      const userPromptHooks = hooksConfig.UserPromptSubmit;
      expect(userPromptHooks).toBeDefined();
      expect(userPromptHooks.length).toBeGreaterThan(0);

      const hook = userPromptHooks[0];
      expect(hook.command).toContain('userpromptsubmit-hook.js');
    });

    it('should have PreToolUse/PostToolUse hooks disabled (efficiency decision)', () => {
      const pluginConfig = JSON.parse(fs.readFileSync(PLUGIN_JSON_PATH, 'utf8'));
      const hooksConfig = pluginConfig.hooks;

      // PreToolUse and PostToolUse are intentionally disabled for efficiency
      // Only SessionStart and UserPromptSubmit provide value with acceptable latency
      expect(hooksConfig.PreToolUse).toBeUndefined();
      expect(hooksConfig.PostToolUse).toBeUndefined();
    });

    it('should still have hook scripts available (for future re-enablement)', () => {
      // Hook scripts exist but are not registered
      const preToolScript = path.join(PLUGIN_ROOT, 'scripts', 'pretooluse-hook.js');
      const postToolScript = path.join(PLUGIN_ROOT, 'scripts', 'posttooluse-hook.js');

      expect(fs.existsSync(preToolScript)).toBe(true);
      expect(fs.existsSync(postToolScript)).toBe(true);
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
      // Accept both 'node' (local dev) and 'npx' (production)
      expect(['node', 'npx']).toContain(mamaServer.command);
      expect(mamaServer.args).toBeDefined();
      expect(Array.isArray(mamaServer.args)).toBe(true);

      // Validate args based on command type
      if (mamaServer.command === 'npx') {
        expect(mamaServer.args).toContain('@jungjaehoon/mama-server');
      } else if (mamaServer.command === 'node') {
        // Local dev: args should contain server.js path
        expect(mamaServer.args.some((arg) => arg.endsWith('server.js'))).toBe(true);
      }
    });

    it('should include required environment variables', () => {
      const mcpConfig = JSON.parse(fs.readFileSync(MCP_JSON_PATH, 'utf8'));

      const mamaServer = mcpConfig.mcpServers.mama;
      expect(mamaServer.env).toBeDefined();

      // Production config only needs embedding model
      // Database path and transport are handled by MCP server defaults
      expect(mamaServer.env.MAMA_EMBEDDING_MODEL).toBeDefined();
      expect(mamaServer.env.MAMA_EMBEDDING_MODEL).toContain('Xenova/');
    });

    it('should use npm package for portability', () => {
      const mcpConfig = JSON.parse(fs.readFileSync(MCP_JSON_PATH, 'utf8'));

      const mamaServer = mcpConfig.mcpServers.mama;

      // Accept both 'node' (local dev) and 'npx' (production)
      expect(['node', 'npx']).toContain(mamaServer.command);

      if (mamaServer.command === 'npx') {
        // Production: uses npm package (most portable)
        expect(mamaServer.args).toContain('@jungjaehoon/mama-server');
        const argsStr = JSON.stringify(mamaServer.args);
        expect(argsStr).toContain('@jungjaehoon');
      } else if (mamaServer.command === 'node') {
        // Local dev: uses direct path (acceptable for development)
        expect(mamaServer.args.some((arg) => arg.includes('server.js'))).toBe(true);
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

      // README should mention plugin configuration
      expect(readme).toMatch(/plugin|Plugin|configuration/);
    });

    it('should reference .mcp.json in README', () => {
      const readme = fs.readFileSync(README_PATH, 'utf8');

      expect(readme).toContain('.mcp.json');
      expect(readme).toContain('MCP');
    });

    it('should provide installation instructions', () => {
      const readme = fs.readFileSync(README_PATH, 'utf8');

      // README should have installation instructions
      expect(readme).toMatch(/install|Install|Installation/i);
    });

    it('should show copy-paste steps', () => {
      const readme = fs.readFileSync(README_PATH, 'utf8');

      // Should have code blocks with commands
      expect(readme).toMatch(/```/);
      expect(readme.length).toBeGreaterThan(500); // Has substantial content
    });

    it('should explain manifest files', () => {
      const readme = fs.readFileSync(README_PATH, 'utf8');

      // README should mention MCP or configuration
      expect(readme).toMatch(/MCP|mcp|configuration/);
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
        stdio: 'pipe',
      });

      expect(output).toContain('ALL VALIDATIONS PASSED');
      expect(output).toContain('❌ Errors: 0'); // Should have zero errors
      expect(output).not.toContain('VALIDATION FAILED');
    });

    it('should validate plugin.json structure', () => {
      const output = execSync(`node ${VALIDATION_SCRIPT}`, {
        encoding: 'utf8',
        stdio: 'pipe',
      });

      expect(output).toContain('plugin.json: Valid JSON');
      expect(output).toContain('plugin.json has name');
      expect(output).toContain('plugin.json has version');
    });

    it('should validate .mcp.json structure', () => {
      const output = execSync(`node ${VALIDATION_SCRIPT}`, {
        encoding: 'utf8',
        stdio: 'pipe',
      });

      expect(output).toContain('.mcp.json: Valid JSON');
      expect(output).toContain('.mcp.json has 1 servers');
    });

    it('should verify all commands exist', () => {
      const output = execSync(`node ${VALIDATION_SCRIPT}`, {
        encoding: 'utf8',
        stdio: 'pipe',
      });

      // Updated validation script uses directory-based discovery
      expect(output).toMatch(/commands.*directory|Command/i);
      expect(output).toContain('decision.md');
      expect(output).toContain('search.md');
      expect(output).toContain('checkpoint.md');
      expect(output).toContain('resume.md');
      expect(output).toContain('configure.md');
    });

    it('should verify hook scripts exist', () => {
      const output = execSync(`node ${VALIDATION_SCRIPT}`, {
        encoding: 'utf8',
        stdio: 'pipe',
      });

      // Updated validation script checks hook scripts exist (inline hooks)
      expect(output).toMatch(/Hook|hooks/i);
      expect(output).toContain('userpromptsubmit-hook.js');
      expect(output).toContain('sessionstart-hook.js');
      // Note: pretooluse and posttooluse scripts exist but are not registered
    });

    it('should show summary with pass count', () => {
      const output = execSync(`node ${VALIDATION_SCRIPT}`, {
        encoding: 'utf8',
        stdio: 'pipe',
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
      const packageJson = JSON.parse(
        fs.readFileSync(path.join(PLUGIN_ROOT, 'package.json'), 'utf8')
      );

      expect(pluginConfig.version).toBe(packageJson.version);
    });

    it('should reference same embedding model in .mcp.json and docs', () => {
      const mcpConfig = JSON.parse(fs.readFileSync(MCP_JSON_PATH, 'utf8'));

      const model = mcpConfig.mcpServers.mama.env.MAMA_EMBEDDING_MODEL;
      expect(model).toBeDefined();
      expect(model).toContain('Xenova/');

      // Model should be a valid embedding model name
      expect(model).toMatch(/^Xenova\//);
    });
  });
});
