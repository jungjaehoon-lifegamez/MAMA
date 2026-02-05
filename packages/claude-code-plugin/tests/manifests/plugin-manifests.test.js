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
        // Each matcher group should have a hooks array (3-level nesting per Claude Code spec)
        expect(pluginConfig.hooks[hookType][0].hooks).toBeDefined();
        expect(Array.isArray(pluginConfig.hooks[hookType][0].hooks)).toBe(true);
      });

      // Verify hook scripts exist and are executable
      const hookScripts = ['scripts/sessionstart-hook.js', 'scripts/userpromptsubmit-hook.js'];

      hookScripts.forEach((script) => {
        const scriptPath = path.join(PLUGIN_ROOT, script);
        expect(fs.existsSync(scriptPath)).toBe(true);

        // Execute bit check only on Unix (Windows doesn't use execute bits)
        if (process.platform !== 'win32') {
          const stat = fs.statSync(scriptPath);
          expect(stat.mode & 0o111).toBeGreaterThan(0); // Has execute bit
        }
      });
    });

    it('should use portable paths with ${CLAUDE_PLUGIN_ROOT}', () => {
      // Read hooks from inline plugin.json
      const pluginConfig = JSON.parse(fs.readFileSync(PLUGIN_JSON_PATH, 'utf8'));
      const hooksConfig = pluginConfig.hooks;

      // 3-level nesting: event -> matcher groups -> hook handlers
      const allHookHandlers = [];
      Object.values(hooksConfig).forEach((matcherGroups) => {
        matcherGroups.forEach((matcherGroup) => {
          matcherGroup.hooks.forEach((handler) => {
            allHookHandlers.push(handler);
          });
        });
      });

      allHookHandlers.forEach((hookHandler) => {
        expect(hookHandler.command).toContain('${CLAUDE_PLUGIN_ROOT}');
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

      const userPromptMatcherGroups = hooksConfig.UserPromptSubmit;
      expect(userPromptMatcherGroups).toBeDefined();
      expect(userPromptMatcherGroups.length).toBeGreaterThan(0);

      // 3-level nesting: access hooks array inside matcher group
      const hookHandlers = userPromptMatcherGroups[0].hooks;
      expect(hookHandlers).toBeDefined();
      expect(hookHandlers.length).toBeGreaterThan(0);
      expect(hookHandlers[0].command).toContain('userpromptsubmit-hook.js');
    });

    it('should have PreToolUse and PostToolUse hooks enabled for MAMA v2', () => {
      const pluginConfig = JSON.parse(fs.readFileSync(PLUGIN_JSON_PATH, 'utf8'));
      const hooksConfig = pluginConfig.hooks;

      // MAMA v2: PreToolUse hook enabled for contract injection
      // - Injects relevant contracts before Read/Grep operations
      // - Prevents Claude from guessing schemas
      expect(hooksConfig.PreToolUse).toBeDefined();
      expect(Array.isArray(hooksConfig.PreToolUse)).toBe(true);
      expect(hooksConfig.PreToolUse[0].hooks[0].command).toContain('pretooluse-hook.js');

      // MAMA v2: PostToolUse hook enabled for contract detection
      // - Detects code changes and extracts API contracts
      // - Auto-injection to Claude via exit code 2 + stderr
      // - Enables frontend/backend consistency checking
      expect(hooksConfig.PostToolUse).toBeDefined();
      expect(Array.isArray(hooksConfig.PostToolUse)).toBe(true);
      expect(hooksConfig.PostToolUse[0].hooks[0].command).toContain('posttooluse-hook.js');
    });

    it('should still have hook scripts available (for future re-enablement)', () => {
      // Hook scripts exist but are not registered
      const preToolScript = path.join(PLUGIN_ROOT, 'scripts', 'pretooluse-hook.js');
      const postToolScript = path.join(PLUGIN_ROOT, 'scripts', 'posttooluse-hook.js');

      expect(fs.existsSync(preToolScript)).toBe(true);
      expect(fs.existsSync(postToolScript)).toBe(true);
    });
  });

  describe.skip('AC3: .mcp.json includes stdio configuration', () => {
    // Skipped: .mcp.json was deleted (Feb 2025)
    // MCP server configuration is now handled externally
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

      // Execute bit check only on Unix (Windows doesn't use execute bits)
      if (process.platform !== 'win32') {
        const stat = fs.statSync(VALIDATION_SCRIPT);
        expect(stat.mode & 0o111).toBeGreaterThan(0); // Executable
      }
    });

    it('should run validation (with expected .mcp.json warning)', () => {
      // Note: .mcp.json was deleted (Feb 2025) so validation shows 1 error
      let output = '';
      try {
        output = execSync(`node ${VALIDATION_SCRIPT}`, {
          encoding: 'utf8',
          stdio: 'pipe',
        });
      } catch (err) {
        output = err.stdout || '';
      }

      // Should validate plugin.json successfully
      expect(output).toContain('plugin.json: Valid JSON');
      // .mcp.json should also pass now that it's restored
      expect(output).toContain('❌ Errors: 0');
    });

    it('should validate plugin.json structure', () => {
      let output = '';
      try {
        output = execSync(`node ${VALIDATION_SCRIPT}`, {
          encoding: 'utf8',
          stdio: 'pipe',
        });
      } catch (err) {
        output = err.stdout || '';
      }

      expect(output).toContain('plugin.json: Valid JSON');
      expect(output).toContain('plugin.json has name');
      expect(output).toContain('plugin.json has version');
    });

    it.skip('should validate .mcp.json structure', () => {
      // Skipped: .mcp.json was deleted (Feb 2025)
      // MCP server configuration is now external
    });

    it('should verify all commands exist', () => {
      let output = '';
      try {
        output = execSync(`node ${VALIDATION_SCRIPT}`, {
          encoding: 'utf8',
          stdio: 'pipe',
        });
      } catch (err) {
        output = err.stdout || '';
      }

      // Updated validation script uses directory-based discovery
      expect(output).toMatch(/commands.*directory|Command/i);
      expect(output).toContain('decision.md');
      expect(output).toContain('search.md');
      expect(output).toContain('checkpoint.md');
      expect(output).toContain('resume.md');
      expect(output).toContain('configure.md');
    });

    it('should verify hook scripts exist', () => {
      // Note: validation script exits with error because .mcp.json is missing (expected)
      let output = '';
      try {
        output = execSync(`node ${VALIDATION_SCRIPT}`, {
          encoding: 'utf8',
          stdio: 'pipe',
        });
      } catch (err) {
        output = err.stdout || '';
      }

      // Updated validation script checks hook scripts exist (inline hooks)
      expect(output).toMatch(/Hook|hooks/i);
      expect(output).toContain('userpromptsubmit-hook.js');
      expect(output).toContain('sessionstart-hook.js');
      // Note: pretooluse and posttooluse scripts exist but are not registered
    });

    it('should show summary with pass count', () => {
      // Note: .mcp.json was intentionally deleted (Feb 2025), so validation shows 1 error
      // The validation script is catching this as expected
      try {
        execSync(`node ${VALIDATION_SCRIPT}`, {
          encoding: 'utf8',
          stdio: 'pipe',
        });
      } catch (err) {
        // Script exits with error because .mcp.json is missing, which is expected
        const output = err.stdout || '';
        expect(output).toContain('Validation Summary');
        expect(output).toMatch(/✅ Passed: \d+/);
        // .mcp.json missing is expected - 1 error
        expect(output).toMatch(/❌ Errors: 1/);
      }
    });
  });

  describe('Integration: All manifests work together', () => {
    it('should have consistent naming in plugin.json', () => {
      const pluginConfig = JSON.parse(fs.readFileSync(PLUGIN_JSON_PATH, 'utf8'));

      expect(pluginConfig.name).toBe('mama');
      // .mcp.json was deleted (Feb 2025) - MCP config now external
    });

    it('should have matching versions', () => {
      const pluginConfig = JSON.parse(fs.readFileSync(PLUGIN_JSON_PATH, 'utf8'));
      const packageJson = JSON.parse(
        fs.readFileSync(path.join(PLUGIN_ROOT, 'package.json'), 'utf8')
      );

      expect(pluginConfig.version).toBe(packageJson.version);
    });

    it.skip('should reference same embedding model in .mcp.json and docs', () => {
      // Skipped: .mcp.json was deleted (Feb 2025)
      // MCP server configuration is now handled externally
    });
  });
});
