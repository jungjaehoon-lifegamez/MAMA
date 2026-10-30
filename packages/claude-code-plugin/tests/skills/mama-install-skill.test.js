import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const pluginRoot = path.resolve(__dirname, '../..');
const skillPath = path.join(pluginRoot, 'skills', 'mama-install', 'SKILL.md');
const manifestPath = path.join(pluginRoot, '.claude-plugin', 'plugin.json');
/** The skill's text with its line breaks folded, so a sentence reads as one line. */
const skill = () => fs.readFileSync(skillPath, 'utf8').replace(/\s+/g, ' ');

describe('Story ONB-8: thin MAMA OS installation skill', () => {
  it('ships and registers the mama-install skill', () => {
    expect(fs.existsSync(skillPath)).toBe(true);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    expect(manifest.skills).toContain('./skills/mama-install');
  });

  it('runs the install command in the background and points at the setup guide', () => {
    const content = skill();

    // The install command, not npm: Homebrew's npm cannot write its prefix from a Standard
    // account, and `mama` on PATH may be another program.
    expect(content).toContain(
      'curl -fsSL https://github.com/jungjaehoon-lifegamez/MAMA/releases/latest/download/install.sh |'
    );
    expect(content).toContain('--non-interactive');
    expect(content).toContain('in the background');
    expect(content).not.toContain('npm i -g');
    expect(content).not.toContain('mama --help');
    expect(content).toContain('docs/start/owner-setup.md');
    // mama status --json went away with the rebuilt CLI; setup ends when MAMA answers the owner.
    expect(content).not.toContain('status --json');
    expect(content).toContain('MAMA answers');
    expect(content).not.toMatch(/BotFather|allowed_chats|detect-owner|personality|wizard/i);
  });

  it('keeps secrets and the pairing code on the setup page, out of the chat', () => {
    const content = skill();

    expect(content).toContain(
      'The person enters secrets and the pairing code only in the setup page MAMA opens in their browser, never in this chat'
    );
    expect(content).toContain('Never read `open.html` and never POST to the setup page.');
    expect(content).not.toMatch(/own terminal/i);
    // No token, key, password or code is asked for in the conversation.
    expect(content).not.toMatch(/\b(ask|type|paste)\b[^.]*\b(token|key|password|pairing code)\b/i);
  });

  it('lets the owner choose Jev, turned on later', () => {
    const content = skill();

    expect(content).toContain('Jev');
    expect(content).toContain('goes to the Jev service');
    expect(content).toContain('MAMA works the same without it');
    expect(content).toContain('mama init --section jev');
  });
});
