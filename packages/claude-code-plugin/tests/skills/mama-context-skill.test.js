/**
 * The mama-context skill describes the plugin's hook manifest: SessionStart only.
 *
 * The plugin manifest is the authority for active hooks. The skill must describe that contract
 * without promising a hook that is not registered.
 */

import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(__dirname, '../..');
const PLUGIN_JSON_PATH = path.join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json');
const SKILL_PATH = path.join(PLUGIN_ROOT, 'skills', 'mama-context', 'SKILL.md');

const readManifest = () => JSON.parse(fs.readFileSync(PLUGIN_JSON_PATH, 'utf8'));
const readSkill = () => fs.readFileSync(SKILL_PATH, 'utf8');

// A command is `NODE_PATH="…" node "${CLAUDE_PLUGIN_ROOT}/scripts/<hook>.js"`.
function hookScriptPath(command) {
  const [, script] = command.match(/"\$\{CLAUDE_PLUGIN_ROOT\}\/([^"]+)"/);
  return path.join(PLUGIN_ROOT, script);
}

describe('mama-context skill', () => {
  it('is declared in the plugin manifest', () => {
    const skills = readManifest().skills;
    expect(Array.isArray(skills)).toBe(true);
    expect(
      skills.some((skill) =>
        typeof skill === 'string' ? skill.includes('mama-context') : skill.name === 'mama-context'
      )
    ).toBe(true);
    expect(readSkill()).toContain('name: mama-context');
  });

  it('describes exactly the registered hooks and their scripts', () => {
    const pluginConfig = readManifest();
    const skill = readSkill();
    expect(Object.keys(pluginConfig.hooks)).toEqual(['SessionStart']);
    expect(skill).toContain('**SessionStart Hook**');
    for (const matcherGroup of pluginConfig.hooks.SessionStart) {
      for (const handler of matcherGroup.hooks) {
        const script = hookScriptPath(handler.command);
        expect(skill).toContain(path.basename(script));
        expect(fs.readFileSync(script, 'utf8').startsWith('#!/usr/bin/env node')).toBe(true);
        if (process.platform !== 'win32') {
          expect(fs.statSync(script).mode & 0o111).toBeGreaterThan(0);
        }
      }
    }
    for (const retired of ['PreToolUse', 'PostToolUse', 'PreCompact', 'UserPromptSubmit']) {
      expect(skill).not.toContain(`**${retired} Hook**`);
    }
  });

  it('says the agent pulls everything else', () => {
    const skill = readSkill();
    expect(skill).toContain('/mama:search <topic>');
    expect(skill).toContain('Loads no embedding model');
    expect(skill).toContain('.claude-plugin/plugin.json');
    expect(skill).toContain('src/core/hook-features.js');
    expect(skill).not.toContain('MAMA_DISABLE_HOOKS');
  });
});
