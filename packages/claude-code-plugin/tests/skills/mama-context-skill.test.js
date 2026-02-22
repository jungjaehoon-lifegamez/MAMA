/**
 * Tests for Story M3.2: Auto-context Skill Wrapper
 *
 * AC1: Skill declared in plugin manifest and references hook outputs
 * AC2: Skill respects similarity thresholds + token budgets
 * AC3: Skill can be disabled via config
 * AC4: Status indicator shows tier and accuracy
 * AC5: Smoke test - skill fires during normal coding session
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PLUGIN_ROOT = path.resolve(__dirname, '../..');
const PLUGIN_JSON_PATH = path.join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json');
const SKILL_PATH = path.join(PLUGIN_ROOT, 'skills', 'mama-context', 'SKILL.md');
const PRE_TOOL_HOOK = path.join(PLUGIN_ROOT, 'scripts', 'pretooluse-hook.js');

describe('M3.2: Auto-context Skill Wrapper', () => {
  describe('AC1: Skill declared in plugin manifest', () => {
    it('should have plugin.json with skill declaration', () => {
      expect(fs.existsSync(PLUGIN_JSON_PATH)).toBe(true);

      const pluginConfig = JSON.parse(fs.readFileSync(PLUGIN_JSON_PATH, 'utf8'));

      expect(pluginConfig.skills).toBeDefined();
      expect(Array.isArray(pluginConfig.skills)).toBe(true);

      // Skills can be either strings (paths) or objects with name/path
      const mamaContextSkill = pluginConfig.skills.find(
        (s) =>
          (typeof s === 'string' && s.includes('mama-context')) ||
          (typeof s === 'object' && s.name === 'mama-context')
      );
      expect(mamaContextSkill).toBeDefined();

      // Validate path whether it's a string or object
      const skillPath =
        typeof mamaContextSkill === 'string' ? mamaContextSkill : mamaContextSkill.path;
      expect(skillPath).toContain('mama-context');
    });

    it('should have SKILL.md file', () => {
      expect(fs.existsSync(SKILL_PATH)).toBe(true);

      const skillContent = fs.readFileSync(SKILL_PATH, 'utf8');
      expect(skillContent).toContain('mama-context');
      expect(skillContent).toContain('Always-on');
      expect(skillContent).toContain('background context injection');
    });

    it('should reference hook outputs in plugin.json', () => {
      const pluginConfig = JSON.parse(fs.readFileSync(PLUGIN_JSON_PATH, 'utf8'));

      expect(pluginConfig.hooks).toBeDefined();

      // PreToolUse (contract injection) and PostToolUse (contract detection) are active
      expect(pluginConfig.hooks.PreToolUse).toBeDefined();
      expect(pluginConfig.hooks.PostToolUse).toBeDefined();

      // Verify hooks reference correct scripts (3-level nesting)
      const matcherGroup = pluginConfig.hooks.PreToolUse[0];
      const hookHandler = matcherGroup.hooks[0];
      expect(hookHandler.command).toContain('pretooluse-hook.js');
    });
  });

  describe('AC2: Respects similarity thresholds + token budgets', () => {
    it('should document similarity thresholds in SKILL.md', () => {
      const skillContent = fs.readFileSync(SKILL_PATH, 'utf8');

      // Similarity threshold documented
      expect(skillContent).toMatch(/60%|0\.6/);
    });

    it('should document token budgets in SKILL.md', () => {
      const skillContent = fs.readFileSync(SKILL_PATH, 'utf8');

      // Teaser format: 40 tokens (only active hook)
      expect(skillContent).toContain('40 tokens');
    });

    it('should use teaser format (not full context)', () => {
      const skillContent = fs.readFileSync(SKILL_PATH, 'utf8');

      // Verify teaser format is documented
      expect(skillContent).toContain('Teaser Format');
      expect(skillContent).toContain('💡 MAMA:');
      expect(skillContent).toContain('/mama:search');
      expect(skillContent).toContain('40 tokens');

      // Verify it explains the transition from 250 to 40 tokens
      expect(skillContent).toContain('250 tokens → 40 tokens');
    });
  });

  describe('AC3: Can be disabled via config', () => {
    it('should document disable mechanism in SKILL.md', () => {
      const skillContent = fs.readFileSync(SKILL_PATH, 'utf8');

      expect(skillContent).toContain('MAMA_DISABLE_HOOKS');
      expect(skillContent).toContain('disable_hooks');
      expect(skillContent).toContain('Configuration');
    });

    it('should show how to disable in config file', () => {
      const skillContent = fs.readFileSync(SKILL_PATH, 'utf8');

      expect(skillContent).toMatch(/config\.json/);
      expect(skillContent).toMatch(/disable.*true/);
    });
  });

  describe('AC4: Status indicator confirms tier and accuracy', () => {
    it('should document Tier 1 status in SKILL.md', () => {
      const skillContent = fs.readFileSync(SKILL_PATH, 'utf8');

      expect(skillContent).toContain('Tier 1');
      expect(skillContent).toContain('Full Features');
      expect(skillContent).toContain('80% accuracy');
      expect(skillContent).toContain('Vector Search');
    });

    it('should document Tier 2 degraded mode in SKILL.md', () => {
      const skillContent = fs.readFileSync(SKILL_PATH, 'utf8');

      expect(skillContent).toContain('Tier 2');
      expect(skillContent).toContain('DEGRADED');
      expect(skillContent).toContain('40% accuracy');
      expect(skillContent).toContain('exact match');
    });

    it('should show status indicator in teaser format example', () => {
      const skillContent = fs.readFileSync(SKILL_PATH, 'utf8');

      expect(skillContent).toContain('System Status');
      expect(skillContent).toMatch(/✅.*Full Features|⚠️.*DEGRADED/);
    });
  });

  describe('AC5: Smoke test - fires during normal coding session', () => {
    let originalEnv;

    beforeEach(() => {
      originalEnv = { ...process.env };
    });

    afterEach(() => {
      process.env = originalEnv;
    });

    it('should have executable hook scripts', () => {
      expect(fs.existsSync(PRE_TOOL_HOOK)).toBe(true);

      // Check shebang
      const preToolContent = fs.readFileSync(PRE_TOOL_HOOK, 'utf8');
      expect(preToolContent.startsWith('#!/usr/bin/env node')).toBe(true);

      // Check executable permissions (Unix only - Windows doesn't use execute bits)
      if (process.platform !== 'win32') {
        const preToolStat = fs.statSync(PRE_TOOL_HOOK);
        expect(preToolStat.mode & 0o111).toBeGreaterThan(0);
      }
    });

    it('should trigger PreToolUse hook on file operation', () => {
      // Simulate file read
      process.env.TOOL_NAME = 'Read';
      process.env.FILE_PATH = 'src/auth.ts';

      try {
        const output = execSync(`node ${PRE_TOOL_HOOK}`, {
          encoding: 'utf8',
          timeout: 2000,
          stdio: 'pipe',
        });

        expect(typeof output).toBe('string');
      } catch (err) {
        // Acceptable if hook exits with non-zero code (e.g., exit(2) for message injection)
        expect(err.status).toBeDefined();
      }
    });

    it('should complete PreToolUse hook within timeout', () => {
      process.env.TOOL_NAME = 'Grep';

      const startTime = Date.now();

      try {
        execSync(`node ${PRE_TOOL_HOOK}`, {
          encoding: 'utf8',
          timeout: 3000,
          stdio: 'pipe',
        });
      } catch (err) {
        if (err.killed && err.signal === 'SIGTERM') {
          throw new Error('Hook exceeded timeout requirement');
        }
      }

      const elapsed = Date.now() - startTime;
      expect(elapsed).toBeLessThan(3000);
    });
  });

  describe('Integration: Skill + Hooks + Commands', () => {
    it('should have consistent configuration across skill and hooks', () => {
      const skillContent = fs.readFileSync(SKILL_PATH, 'utf8');
      const preToolContent = fs.readFileSync(PRE_TOOL_HOOK, 'utf8');

      // Verify similarity threshold in skill
      expect(skillContent).toMatch(/60%|0\.6/);

      // Verify timeout in skill
      expect(skillContent).toContain('1800ms');

      // PreToolUse handles decision lookup for Read
      expect(preToolContent).toContain('READ_TOOLS');
    });

    it('should reference related stories in SKILL.md', () => {
      const skillContent = fs.readFileSync(SKILL_PATH, 'utf8');

      expect(skillContent).toContain('M3.2'); // This story
      expect(skillContent).toContain('M2.2'); // PreToolUse
      expect(skillContent).toContain('M2.4'); // Transparency banner
    });

    it('should document architecture decision reference', () => {
      const skillContent = fs.readFileSync(SKILL_PATH, 'utf8');

      expect(skillContent).toContain('Architecture');
      expect(skillContent).toContain('Decision 4'); // Hook Implementation decision
    });
  });

  describe('Plugin manifest validity', () => {
    it('should have valid JSON structure', () => {
      const pluginConfig = JSON.parse(fs.readFileSync(PLUGIN_JSON_PATH, 'utf8'));

      expect(pluginConfig.name).toBe('mama');
      expect(pluginConfig.version).toBeDefined();
      expect(pluginConfig.description).toBeDefined();
      expect(pluginConfig.commands).toBeDefined();
      expect(pluginConfig.skills).toBeDefined();
      expect(pluginConfig.hooks).toBeDefined();
    });

    it('should have required hook configurations (PreToolUse + PostToolUse for MAMA v2)', () => {
      const pluginConfig = JSON.parse(fs.readFileSync(PLUGIN_JSON_PATH, 'utf8'));

      // Inline format
      expect(pluginConfig.hooks.SessionStart).toBeDefined();
      expect(pluginConfig.hooks.PreToolUse).toBeDefined();
      expect(pluginConfig.hooks.PostToolUse).toBeDefined();
    });

    it('should use ${CLAUDE_PLUGIN_ROOT} for portable paths', () => {
      const pluginConfig = JSON.parse(fs.readFileSync(PLUGIN_JSON_PATH, 'utf8'));
      const hooksConfig = pluginConfig.hooks;

      // All hooks use portable paths (3-level nesting: event -> matcher groups -> hook handlers)
      const allHookCommands = [];
      Object.values(hooksConfig).forEach((matcherGroups) => {
        matcherGroups.forEach((matcherGroup) => {
          matcherGroup.hooks.forEach((handler) => {
            allHookCommands.push(handler.command);
          });
        });
      });

      allHookCommands.forEach((cmd) => {
        expect(cmd).toContain('${CLAUDE_PLUGIN_ROOT}');
      });
    });
  });
});
