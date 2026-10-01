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

      // SessionStart is the only hook: the agent pulls everything else (MCP tools, commands).
      const expectedHooks = ['SessionStart'];
      expect(Object.keys(pluginConfig.hooks)).toEqual(expectedHooks);

      expectedHooks.forEach((hookType) => {
        expect(pluginConfig.hooks[hookType]).toBeDefined();
        expect(Array.isArray(pluginConfig.hooks[hookType])).toBe(true);
        // Each matcher group should have a hooks array (3-level nesting per Claude Code spec)
        expect(pluginConfig.hooks[hookType][0].hooks).toBeDefined();
        expect(Array.isArray(pluginConfig.hooks[hookType][0].hooks)).toBe(true);
      });

      // Verify hook scripts exist and are executable
      const hookScripts = ['scripts/sessionstart-hook.js'];

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

    it('loads dependencies from CLAUDE_PLUGIN_DATA, which SessionStart has time to fill', () => {
      // Claude Code never runs npm install for a plugin, and replaces its folder on update.
      const pluginConfig = JSON.parse(fs.readFileSync(PLUGIN_JSON_PATH, 'utf8'));
      for (const matcherGroups of Object.values(pluginConfig.hooks)) {
        for (const matcherGroup of matcherGroups) {
          for (const handler of matcherGroup.hooks) {
            expect(handler.command).toMatch(
              /^NODE_PATH="\$\{CLAUDE_PLUGIN_DATA\}\/node_modules" node "\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/[a-z-]+\.js"$/
            );
          }
        }
      }
      // A cold install was 13 s and 416 MB on 2026-09-30; slower links need more.
      expect(pluginConfig.hooks.SessionStart[0].hooks[0].timeout).toBeGreaterThanOrEqual(180);
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
    });

    it('registers no tool or compaction hooks', () => {
      // PreToolUse blocked the first read of each code file (exit 2) to push loosely related
      // decisions, PostToolUse pushed the same reminder after each first edit, and PreCompact's
      // output is shown to the user only, never used by compaction (removed 2026-10-01).
      const pluginConfig = JSON.parse(fs.readFileSync(PLUGIN_JSON_PATH, 'utf8'));
      for (const event of ['PreToolUse', 'PostToolUse', 'PreCompact']) {
        expect(pluginConfig.hooks[event]).toBeUndefined();
        expect(
          fs.existsSync(path.join(PLUGIN_ROOT, 'scripts', `${event.toLowerCase()}-hook.js`))
        ).toBe(false);
      }
    });
  });

  // AC3: .mcp.json was intentionally removed (Feb 2025).
  // MCP server configuration is now handled externally via Claude Desktop settings.
  // Tests for .mcp.json have been removed as the file no longer exists.

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

    it('should run validation with zero errors', () => {
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
      expect(output).toContain('sessionstart-hook.js');
    });

    it('should show summary with pass count', () => {
      let output = '';
      try {
        output = execSync(`node ${VALIDATION_SCRIPT}`, {
          encoding: 'utf8',
          stdio: 'pipe',
        });
      } catch (err) {
        output = err.stdout || '';
      }

      expect(output).toContain('Validation Summary');
      expect(output).toMatch(/✅ Passed: \d+/);
      expect(output).toContain('❌ Errors: 0');
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

    it('advertises no setting the code does not read', () => {
      const configure = fs.readFileSync(path.join(PLUGIN_ROOT, 'commands', 'configure.md'), 'utf8');
      expect(configure).not.toMatch(/config\.json|--model|--tier-check|--db-path/);
      for (const file of ['.mcp.json', '.claude-plugin/.mcp.json', '.claude-plugin/plugin.json']) {
        expect(fs.readFileSync(path.join(PLUGIN_ROOT, file), 'utf8')).not.toContain(
          'MAMA_EMBEDDING_MODEL'
        );
      }
    });

    it('does not advertise retired HTTP or WebSocket runtime switches', () => {
      const configure = fs.readFileSync(path.join(PLUGIN_ROOT, 'commands', 'configure.md'), 'utf8');

      expect(configure).not.toMatch(/--disable-http|--disable-websocket|--enable-all/);
      expect(configure).not.toMatch(/MAMA_DISABLE_HTTP_SERVER|MAMA_DISABLE_WEBSOCKET/);
      expect(configure).not.toMatch(/--set-auth-token|--generate-token/);
      expect(configure).not.toMatch(/MAMA_AUTH_TOKEN|mcpServers\.mama\.env/);
    });

    it('describes exactly the active hook manifest in the shipped context skill', () => {
      const pluginConfig = JSON.parse(fs.readFileSync(PLUGIN_JSON_PATH, 'utf8'));
      const skill = fs.readFileSync(
        path.join(PLUGIN_ROOT, 'skills', 'mama-context', 'SKILL.md'),
        'utf8'
      );

      expect(Object.keys(pluginConfig.hooks)).toEqual(['SessionStart']);
      expect(skill).toContain('**SessionStart Hook**');
      for (const retired of ['PreToolUse', 'PostToolUse', 'PreCompact', 'UserPromptSubmit']) {
        expect(skill).not.toContain(`**${retired} Hook**`);
      }
    });

    it('keeps package and marketplace plugin versions synchronized', () => {
      const packageVersion = JSON.parse(
        fs.readFileSync(path.join(PLUGIN_ROOT, 'package.json'), 'utf8')
      ).version;
      const marketplacePaths = [
        path.join(PLUGIN_ROOT, '.claude-plugin', 'marketplace.json'),
        path.resolve(PLUGIN_ROOT, '../..', '.claude-plugin', 'marketplace.json'),
      ];

      for (const marketplacePath of marketplacePaths) {
        const marketplace = JSON.parse(fs.readFileSync(marketplacePath, 'utf8'));
        const plugin = marketplace.plugins.find((entry) => entry.name === 'mama');
        expect(plugin?.version).toBe(packageVersion);
      }
    });
  });
});
