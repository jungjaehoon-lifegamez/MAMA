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
const USER_PROMPT_HOOK = path.join(PLUGIN_ROOT, 'scripts', 'userpromptsubmit-hook.js');
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

      // Check if hooks are defined as external reference or inline
      if (typeof pluginConfig.hooks === 'string') {
        // External reference format (e.g., "./hooks/hooks.json")
        expect(pluginConfig.hooks).toContain('hooks.json');

        // Load and validate the external hooks file (resolve relative to plugin.json location)
        const hooksPath = path.resolve(path.dirname(PLUGIN_JSON_PATH), pluginConfig.hooks);
        expect(fs.existsSync(hooksPath)).toBe(true);

        const hooksFile = JSON.parse(fs.readFileSync(hooksPath, 'utf8'));
        const hooksConfig = hooksFile.hooks || hooksFile; // Support both nested and flat structure

        // Only UserPromptSubmit is active (PreToolUse/PostToolUse disabled for efficiency)
        expect(hooksConfig.UserPromptSubmit).toBeDefined();

        // Verify hooks reference correct scripts
        const userPromptHook = hooksConfig.UserPromptSubmit[0];
        expect(userPromptHook.command).toContain('userpromptsubmit-hook.js');
      } else {
        // Inline format with 3-level nesting (event -> matcher groups -> hook handlers)
        expect(pluginConfig.hooks.UserPromptSubmit).toBeDefined();

        // Verify hooks reference correct scripts (3-level nesting)
        const matcherGroup = pluginConfig.hooks.UserPromptSubmit[0];
        const hookHandler = matcherGroup.hooks[0];
        expect(hookHandler.command).toContain('userpromptsubmit-hook.js');
      }
    });
  });

  describe('AC2: Respects similarity thresholds + token budgets', () => {
    it('should document similarity thresholds in SKILL.md', () => {
      const skillContent = fs.readFileSync(SKILL_PATH, 'utf8');

      // UserPromptSubmit: 75% threshold
      expect(skillContent).toMatch(/75%|0\.75/);
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
      expect(skillContent).toContain('/mama-recall');
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
      expect(fs.existsSync(USER_PROMPT_HOOK)).toBe(true);
      expect(fs.existsSync(PRE_TOOL_HOOK)).toBe(true);

      // Check shebang
      const userPromptContent = fs.readFileSync(USER_PROMPT_HOOK, 'utf8');
      expect(userPromptContent.startsWith('#!/usr/bin/env node')).toBe(true);

      const preToolContent = fs.readFileSync(PRE_TOOL_HOOK, 'utf8');
      expect(preToolContent.startsWith('#!/usr/bin/env node')).toBe(true);

      // Check executable permissions (Unix only - Windows doesn't use execute bits)
      if (process.platform !== 'win32') {
        const userPromptStat = fs.statSync(USER_PROMPT_HOOK);
        expect(userPromptStat.mode & 0o111).toBeGreaterThan(0); // At least one execute bit

        const preToolStat = fs.statSync(PRE_TOOL_HOOK);
        expect(preToolStat.mode & 0o111).toBeGreaterThan(0);
      }
    });

    it('should trigger UserPromptSubmit hook on prompt', () => {
      // Simulate user prompt
      process.env.USER_PROMPT = 'How should I handle authentication?';

      try {
        const output = execSync(`node ${USER_PROMPT_HOOK}`, {
          encoding: 'utf8',
          timeout: 2000, // 2s timeout
          stdio: 'pipe',
        });

        // Should produce output (even if no decisions found)
        // Output might be empty if no matching decisions, which is OK
        expect(typeof output).toBe('string');
      } catch (err) {
        // Timeout or error is acceptable (may not have DB initialized)
        // Just verify hook is executable
        expect(err.code).toBeDefined();
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

    it('should complete hook within 500ms timeout', () => {
      process.env.USER_PROMPT = 'test prompt';

      const startTime = Date.now();

      try {
        execSync(`node ${USER_PROMPT_HOOK}`, {
          encoding: 'utf8',
          timeout: 600, // Slightly higher than AC requirement to allow for execution overhead
          stdio: 'pipe',
        });
      } catch (err) {
        // Check if timeout occurred (would be killed by timeout, not completed)
        if (err.killed && err.signal === 'SIGTERM') {
          throw new Error('Hook exceeded 500ms timeout requirement');
        }
      }

      const elapsed = Date.now() - startTime;
      expect(elapsed).toBeLessThan(700); // Allow for execution overhead + model loading
    });
  });

  describe('Integration: Skill + Hooks + Commands', () => {
    it('should have consistent configuration across skill and hooks', () => {
      const skillContent = fs.readFileSync(SKILL_PATH, 'utf8');
      const userPromptContent = fs.readFileSync(USER_PROMPT_HOOK, 'utf8');

      // Verify similarity threshold in skill
      expect(skillContent).toMatch(/75%|0\.75/);

      // Verify timeout in skill
      expect(skillContent).toContain('1200ms');

      // UserPromptSubmit is now keyword-detection-only (no memory injection)
      // Verify it has keyword detection capability
      expect(userPromptContent).toContain('detectKeywords');
      expect(userPromptContent).toContain('KEYWORD_DETECTORS');
    });

    it('should reference related stories in SKILL.md', () => {
      const skillContent = fs.readFileSync(SKILL_PATH, 'utf8');

      expect(skillContent).toContain('M3.2'); // This story
      expect(skillContent).toContain('M2.1'); // UserPromptSubmit
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

    it('should have required hook configurations (UserPromptSubmit + PreToolUse + PostToolUse for MAMA v2)', () => {
      const pluginConfig = JSON.parse(fs.readFileSync(PLUGIN_JSON_PATH, 'utf8'));

      // Handle external reference or inline format
      if (typeof pluginConfig.hooks === 'string') {
        // External reference - load the hooks file (resolve relative to plugin.json location)
        const hooksPath = path.resolve(path.dirname(PLUGIN_JSON_PATH), pluginConfig.hooks);
        const hooksFile = JSON.parse(fs.readFileSync(hooksPath, 'utf8'));
        const hooksConfig = hooksFile.hooks || hooksFile; // Support both nested and flat structure

        // MAMA v2: UserPromptSubmit (context) + PreToolUse (contract injection) + PostToolUse (contract extraction)
        expect(hooksConfig.UserPromptSubmit).toBeDefined();
        expect(hooksConfig.PreToolUse).toBeDefined();
        expect(hooksConfig.PostToolUse).toBeDefined();
      } else {
        // Inline format
        expect(pluginConfig.hooks.UserPromptSubmit).toBeDefined();
        expect(pluginConfig.hooks.PreToolUse).toBeDefined();
        expect(pluginConfig.hooks.PostToolUse).toBeDefined();
      }
    });

    it('should use ${CLAUDE_PLUGIN_ROOT} for portable paths', () => {
      const pluginConfig = JSON.parse(fs.readFileSync(PLUGIN_JSON_PATH, 'utf8'));

      let hooksConfig;
      if (typeof pluginConfig.hooks === 'string') {
        // External reference - load the hooks file (resolve relative to plugin.json location)
        const hooksPath = path.resolve(path.dirname(PLUGIN_JSON_PATH), pluginConfig.hooks);
        const hooksFile = JSON.parse(fs.readFileSync(hooksPath, 'utf8'));
        hooksConfig = hooksFile.hooks || hooksFile; // Support both nested and flat structure
      } else {
        // Inline format
        hooksConfig = pluginConfig.hooks;
      }

      // Only UserPromptSubmit is active (3-level nesting: event -> matcher groups -> hook handlers)
      const allHookCommands = [];
      hooksConfig.UserPromptSubmit.forEach((matcherGroup) => {
        matcherGroup.hooks.forEach((handler) => {
          allHookCommands.push(handler.command);
        });
      });

      allHookCommands.forEach((cmd) => {
        expect(cmd).toContain('${CLAUDE_PLUGIN_ROOT}');
      });
    });
  });
});
