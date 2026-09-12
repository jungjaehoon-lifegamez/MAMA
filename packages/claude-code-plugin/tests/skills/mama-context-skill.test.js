/**
 * Tests for Story M3.2: hook-driven MAMA context skill.
 *
 * The plugin manifest is the authority for active hooks, matchers, commands,
 * and timeouts. The skill must describe that executable contract without
 * promising an unwired lifecycle hook or retired embedding server.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import { execFileSync, spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PLUGIN_ROOT = path.resolve(__dirname, '../..');
const PLUGIN_JSON_PATH = path.join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json');
const SKILL_PATH = path.join(PLUGIN_ROOT, 'skills', 'mama-context', 'SKILL.md');
const PRE_TOOL_HOOK = path.join(PLUGIN_ROOT, 'scripts', 'pretooluse-hook.js');

function readManifest() {
  return JSON.parse(fs.readFileSync(PLUGIN_JSON_PATH, 'utf8'));
}

function readSkill() {
  return fs.readFileSync(SKILL_PATH, 'utf8');
}

function hookScriptPath(command) {
  return command.replace('node ${CLAUDE_PLUGIN_ROOT}', PLUGIN_ROOT);
}

describe('M3.2: MAMA context skill wrapper', () => {
  describe('AC1: Skill declared in plugin manifest', () => {
    it('has a mama-context skill declaration', () => {
      expect(fs.existsSync(PLUGIN_JSON_PATH)).toBe(true);
      const pluginConfig = readManifest();

      expect(Array.isArray(pluginConfig.skills)).toBe(true);
      const mamaContextSkill = pluginConfig.skills.find(
        (skill) =>
          (typeof skill === 'string' && skill.includes('mama-context')) ||
          (typeof skill === 'object' && skill.name === 'mama-context')
      );
      expect(mamaContextSkill).toBeDefined();
      const skillPath =
        typeof mamaContextSkill === 'string' ? mamaContextSkill : mamaContextSkill.path;
      expect(skillPath).toContain('mama-context');
    });

    it('has a coherent hook-driven purpose', () => {
      expect(fs.existsSync(SKILL_PATH)).toBe(true);
      const skill = readSkill();

      expect(skill).toContain('name: mama-context');
      expect(skill).toContain('Hook-driven MAMA context');
      expect(skill).toMatch(/plugin manifest\s+is the authority/i);
    });

    it('references every hook script registered by the manifest', () => {
      const pluginConfig = readManifest();
      const skill = readSkill();

      for (const matcherGroups of Object.values(pluginConfig.hooks)) {
        for (const matcherGroup of matcherGroups) {
          for (const handler of matcherGroup.hooks) {
            expect(skill).toContain(path.basename(handler.command));
          }
        }
      }
    });
  });

  describe('AC2: Manifest hook contract', () => {
    it('documents exactly the four active hook names', () => {
      const pluginConfig = readManifest();
      const skill = readSkill();
      const hookNames = Object.keys(pluginConfig.hooks);

      expect(hookNames).toEqual(['SessionStart', 'PreToolUse', 'PreCompact', 'PostToolUse']);
      for (const hookName of hookNames) {
        expect(skill).toContain(`**${hookName} Hook**`);
      }
      expect(skill).not.toContain('UserPromptSubmit');
    });

    it('documents the active matchers and manifest timeouts', () => {
      const pluginConfig = readManifest();
      const skill = readSkill();

      expect(pluginConfig.hooks.PreToolUse.map((group) => group.matcher)).toEqual(['Read']);
      expect(pluginConfig.hooks.PostToolUse.map((group) => group.matcher)).toEqual([
        'Write',
        'Edit',
      ]);
      expect(skill).toContain('Active matcher: `Read`');
      expect(skill).toContain('Active matchers: `Write`, `Edit`');
      expect(skill).toContain('Manifest timeout: 15 seconds');
      expect(skill.match(/Manifest timeout: 5 seconds/g)).toHaveLength(2);
      expect(skill).toContain('Manifest timeout: 10 seconds');
    });

    it('uses local in-process embeddings without retired hook or server claims', () => {
      const skill = readSkill();

      expect(skill).toContain('Embedding generation is local and in process');
      expect(skill).toContain('There is no embedding HTTP listener');
      expect(skill).not.toContain('UserPromptSubmit');
      expect(skill).not.toMatch(/embedding server|HTTP embedding server/i);
      expect(skill).not.toMatch(/PreToolUse[^\n]*disabled|PostToolUse[^\n]*disabled/);
    });
  });

  describe('AC3: Configuration and explicit lookup', () => {
    it('names the actual hook configuration authorities', () => {
      const skill = readSkill();

      expect(skill).toContain('.claude-plugin/plugin.json');
      expect(skill).toContain('src/core/hook-features.js');
      expect(skill).toMatch(/disable the plugin in\s+Claude Code/i);
      expect(skill).not.toContain('MAMA_DISABLE_HOOKS');
      expect(skill).not.toContain('disable_hooks');
    });

    it('keeps explicit full-memory lookup available', () => {
      const skill = readSkill();

      expect(skill).toContain('/mama:search <topic>');
      expect(skill).toContain('full decision');
      expect(skill).toContain('evolution chain');
    });
  });

  describe('AC4: Hook purposes remain coherent', () => {
    it('describes SessionStart local initialization', () => {
      const skill = readSkill();

      expect(skill).toContain('Initializes the local memory database');
      expect(skill).toContain('warms the in-process embedding model');
    });

    it('describes bounded first-read context injection', () => {
      const skill = readSkill();

      expect(skill).toContain('first eligible code-file read');
      expect(skill).toContain('bounded context');
      expect(skill).toContain('Repeated reads');
    });

    it('describes write reminders and pre-compaction ingest', () => {
      const skill = readSkill();

      expect(skill).toContain('first eligible code-file change');
      expect(skill).toContain('record decisions');
      expect(skill).toContain('before context compaction');
      expect(skill).toContain('MAMA_HTTP_PORT');
      expect(skill).toContain('port 3847');
    });
  });

  describe('AC5: Registered hook scripts execute', () => {
    let originalEnv;

    beforeEach(() => {
      originalEnv = { ...process.env };
    });

    afterEach(() => {
      process.env = originalEnv;
    });

    it('has executable scripts for every manifest hook', () => {
      const pluginConfig = readManifest();
      const commands = Object.values(pluginConfig.hooks).flatMap((matcherGroups) =>
        matcherGroups.flatMap((matcherGroup) =>
          matcherGroup.hooks.map((handler) => handler.command)
        )
      );

      for (const command of commands) {
        const scriptPath = hookScriptPath(command);
        expect(fs.existsSync(scriptPath)).toBe(true);
        expect(fs.readFileSync(scriptPath, 'utf8').startsWith('#!/usr/bin/env node')).toBe(true);
        if (process.platform !== 'win32') {
          expect(fs.statSync(scriptPath).mode & 0o111).toBeGreaterThan(0);
        }
      }
    });

    it('runs the registered PreToolUse script for a Read operation', () => {
      process.env.TOOL_NAME = 'Read';
      process.env.FILE_PATH = 'src/auth.ts';

      const result = spawnSync(process.execPath, [PRE_TOOL_HOOK], {
        encoding: 'utf8',
        timeout: 2000,
        stdio: 'pipe',
      });

      expect([0, 2]).toContain(result.status);
      expect(result.stdout).toBe('');
      expect(result.stderr.length).toBeGreaterThan(0);
      if (result.status === 0) {
        expect(JSON.parse(result.stderr)).toEqual({ decision: 'allow', reason: '' });
      } else {
        expect(result.stderr).toContain('Related Decisions');
      }
    });

    it('completes a non-matching PreToolUse operation within its bound', () => {
      process.env.TOOL_NAME = 'Grep';
      const startedAt = Date.now();

      try {
        execFileSync(process.execPath, [PRE_TOOL_HOOK], {
          encoding: 'utf8',
          timeout: 3000,
          stdio: 'pipe',
        });
      } catch (error) {
        if (error.killed && error.signal === 'SIGTERM') {
          throw new Error('Hook exceeded timeout requirement');
        }
      }

      expect(Date.now() - startedAt).toBeLessThan(3000);
    });
  });

  describe('Integration: Skill, hooks, and developer checks', () => {
    it('keeps manifest commands and skill hook names aligned', () => {
      const pluginConfig = readManifest();
      const skill = readSkill();

      for (const [hookName, matcherGroups] of Object.entries(pluginConfig.hooks)) {
        expect(skill).toContain(`**${hookName} Hook**`);
        for (const matcherGroup of matcherGroups) {
          for (const handler of matcherGroup.hooks) {
            expect(skill).toContain(path.basename(handler.command));
          }
        }
      }
    });

    it('documents focused checks for all four hook scripts', () => {
      const skill = readSkill();

      for (const filename of [
        'sessionstart-hook.test.js',
        'pretooluse-hook.test.js',
        'posttooluse-hook.test.js',
        'precompact-hook.test.js',
      ]) {
        expect(skill).toContain(filename);
      }
    });

    it('shows each registered boundary in the runtime flow', () => {
      const skill = readSkill();

      expect(skill).toContain('Session starts ── SessionStart');
      expect(skill).toContain('Read tool      ── PreToolUse');
      expect(skill).toContain('Write/Edit     ── PostToolUse');
      expect(skill).toContain('Pre-compact    ── PreCompact');
    });
  });

  describe('Plugin manifest validity', () => {
    it('has the required JSON structure', () => {
      const pluginConfig = readManifest();

      expect(pluginConfig.name).toBe('mama');
      expect(pluginConfig.version).toBeDefined();
      expect(pluginConfig.description).toBeDefined();
      expect(pluginConfig.commands).toBeDefined();
      expect(pluginConfig.skills).toBeDefined();
      expect(pluginConfig.hooks).toBeDefined();
    });

    it('has exactly the four required hook configurations', () => {
      const pluginConfig = readManifest();

      expect(Object.keys(pluginConfig.hooks)).toEqual([
        'SessionStart',
        'PreToolUse',
        'PreCompact',
        'PostToolUse',
      ]);
      expect(pluginConfig.hooks.PreToolUse[0].matcher).toBe('Read');
      expect(pluginConfig.hooks.PostToolUse.map((group) => group.matcher)).toEqual([
        'Write',
        'Edit',
      ]);
    });

    it('uses ${CLAUDE_PLUGIN_ROOT} for portable paths', () => {
      const pluginConfig = readManifest();
      const commands = Object.values(pluginConfig.hooks).flatMap((matcherGroups) =>
        matcherGroups.flatMap((matcherGroup) =>
          matcherGroup.hooks.map((handler) => handler.command)
        )
      );

      for (const command of commands) {
        expect(command).toContain('${CLAUDE_PLUGIN_ROOT}');
      }
    });
  });
});
