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

  it('sets a source up after the install through the non-interactive section, with MAMA stopped', () => {
    const content = skill();

    expect(content).toContain('do not offer them before MAMA answers');
    expect(content).toContain(
      'MAMA_INIT_CONNECTORS=\'{"gmail": {...}}\' ~/.mama/bin/mama init --section connectors --non-interactive'
    );
    expect(content).toContain('~/.mama/bin/mama stop');
    expect(content).toContain('~/.mama/bin/mama service start');
    // Only the sources' section runs without a terminal; the others still need one (W2.4.6).
    expect(content.match(/--section \S+/g)).toEqual(['--section connectors']);
    // Bare `mama` in the agent's shell may be another program; a named command is the wrapper's.
    expect(content).not.toMatch(/(^|[^/])\bmama (init|service|doctor|status|update|stop)\b/);
  });

  it('offers sources once MAMA has answered, from the connectors guide, and lets the person skip', () => {
    const content = skill();
    const answered = content.indexOf("Setup is done when MAMA answers the person's message");
    const offer = content.indexOf('ask the person which sources MAMA should watch');

    // The install itself offers none; the first reply comes first, then the offer.
    expect(answered).toBeGreaterThanOrEqual(0);
    expect(offer).toBeGreaterThan(answered);
    expect(content).toContain('do not offer them before MAMA answers');
    // The list is the guide's, not the model's memory.
    expect(content).toContain('Name each source in the table of the [connectors guide]');
    expect(content).toContain('read the list there, not from memory');
    expect(content).toContain('Leave out the Kagemusha bridge');
    // Each pick goes through the same enabling flow.
    expect(content).toContain('Set up each source the person picks, one at a time, as below');
    expect(content).toContain(
      'If they decline or say later, skip this, and tell them they can ask for a source at any time'
    );
  });

  it("orders a Google source's steps: the OAuth client, the tool, the login, then enabling", () => {
    const content = skill();
    const steps = [
      'Move that file to `~/.config/gws/client_secret.json` with mode 0600',
      'it saves nothing and prints the command that installs it; run that command',
      'the enabling command saves nothing and prints the login (`gws auth login --scopes <scopes>`), naming the scope of every Google source that is on',
      'once `gws` is installed and signed in, it saves the source',
    ].map((step) => content.indexOf(step));
    expect(steps.every((at) => at >= 0)).toBe(true);
    expect([...steps].sort((a, b) => a - b)).toEqual(steps);
    expect(content).toContain('OAuth client of type Desktop app');
    // A gmail.com client is published (no 7-day end) after one unverified-app click-through; a
    // Workspace account uses Internal (owner, 2026-10-31).
    expect(content).toContain('A gmail.com account: user type External');
    expect(content).toContain('then press "Publish app" so the app is In production');
    expect(content).toContain('they choose Advanced, then continue');
    expect(content).toContain('A Google Workspace account: user type Internal');
    expect(content).toContain(
      'If the client is left in Testing, Google ends the sign-in after 7 days'
    );
    expect(content).not.toContain('External in testing mode');
    expect(content).toContain('not a MAMA secret');
    // The consent is the person's; the agent only runs the login and passes on its address.
    expect(content).toContain('Never open or complete the Google consent yourself');
  });

  it('starts MAMA again after every run of the enabling command, which leaves it stopped', () => {
    const content = skill();

    expect(content).toContain('it leaves MAMA stopped however it ends');
    expect(content).toContain(
      'Start MAMA again with `~/.mama/bin/mama service start` as soon as each run ends, before you wait on the person for the next step'
    );
  });

  it('keeps Jev out of the conversation until it has a form without a terminal', () => {
    const content = skill();

    expect(content).toContain('Jev is not set up from the conversation yet');
    expect(content).toContain('Do not offer it.');
    // What Jev sends out stays explained, for when the person asks.
    expect(content).toContain('goes to the Jev service');
    expect(content).toContain('MAMA works the same without it');
  });
});
