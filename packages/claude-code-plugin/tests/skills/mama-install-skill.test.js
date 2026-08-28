import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const pluginRoot = path.resolve(__dirname, '../..');
const skillPath = path.join(pluginRoot, 'skills', 'mama-install', 'SKILL.md');
const manifestPath = path.join(pluginRoot, '.claude-plugin', 'plugin.json');

describe('Story ONB-8: thin MAMA OS installation skill', () => {
  it('ships and registers the mama-install skill', () => {
    expect(fs.existsSync(skillPath)).toBe(true);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    expect(manifest.skills).toContain('./skills/mama-install');
  });

  it('points at the CLI contract without copying onboarding knowledge', () => {
    const content = fs.readFileSync(skillPath, 'utf8');

    expect(content).toContain('npm i -g @jungjaehoon/mama-os');
    expect(content).toContain('mama --help');
    expect(content).toContain('mama status --json');
    expect(content).toContain('complete');
    expect(content).not.toMatch(/BotFather|allowed_chats|detect-owner|personality|wizard/i);
  });
});
