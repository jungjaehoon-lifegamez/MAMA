import { afterEach, describe, expect, it, vi } from 'vitest';

const execFileSyncMock = vi.fn();

vi.mock('node:child_process', () => ({
  execFileSync: execFileSyncMock,
}));

describe('Claude Code auth detection', () => {
  const originalHome = process.env.HOME;

  afterEach(() => {
    vi.resetModules();
    execFileSyncMock.mockReset();
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
  });

  it('prefers claude auth status when the CLI reports a logged-in session', async () => {
    execFileSyncMock.mockReturnValue(
      JSON.stringify({
        loggedIn: true,
        authMethod: 'claude.ai',
        apiProvider: 'firstParty',
        email: 'test@example.com',
        subscriptionType: 'max',
      })
    );

    const { getClaudeCodeAuthStatus } = await import('../../src/auth/claude-code-auth.js');
    const status = getClaudeCodeAuthStatus();

    expect(status).toMatchObject({
      cliInstalled: true,
      loggedIn: true,
      source: 'cli_status',
      authMethod: 'claude.ai',
      subscriptionType: 'max',
      email: 'test@example.com',
    });
  });

  it('falls back to the legacy credentials file when claude is not installed', async () => {
    const { mkdir, writeFile, rm } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const testHome = join(tmpdir(), `mama-claude-auth-${Date.now()}`);
    const claudeDir = join(testHome, '.claude');

    await mkdir(claudeDir, { recursive: true });
    await writeFile(join(claudeDir, '.credentials.json'), '{}');
    process.env.HOME = testHome;

    const error = Object.assign(new Error('not found'), { code: 'ENOENT' });
    execFileSyncMock.mockImplementation(() => {
      throw error;
    });

    const { getClaudeCodeAuthStatus } = await import('../../src/auth/claude-code-auth.js');
    const status = getClaudeCodeAuthStatus();

    expect(status).toMatchObject({
      cliInstalled: false,
      loggedIn: true,
      source: 'legacy_credentials',
      authMethod: 'legacy_credentials',
    });

    await rm(testHome, { recursive: true, force: true });
  });

  it('reports logged out when neither CLI auth nor legacy credentials are present', async () => {
    execFileSyncMock.mockReturnValue(
      JSON.stringify({
        loggedIn: false,
        authMethod: 'none',
        apiProvider: 'firstParty',
      })
    );

    const { getClaudeCodeAuthStatus } = await import('../../src/auth/claude-code-auth.js');
    const status = getClaudeCodeAuthStatus();

    expect(status).toMatchObject({
      cliInstalled: true,
      loggedIn: false,
      source: 'none',
      authMethod: 'none',
    });
  });
});
