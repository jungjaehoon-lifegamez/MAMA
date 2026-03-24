import { describe, it, expect, vi, beforeEach } from 'vitest';
import { existsSync, readFileSync } from 'fs';
import { execSync } from 'child_process';
import { HaikuClient } from '../../src/haiku-client.js';

// Valid credentials in claudeAiOauth format (matches standalone OAuthManager)
const VALID_CREDENTIALS = JSON.stringify({
  claudeAiOauth: {
    accessToken: 'test-token',
    refreshToken: 'test-refresh',
    expiresAt: Date.now() + 3600000,
  },
});

const EXPIRED_CREDENTIALS = JSON.stringify({
  claudeAiOauth: {
    accessToken: 'expired-token',
    refreshToken: 'test-refresh',
    expiresAt: Date.now() - 1000,
  },
});

// Mock @anthropic-ai/sdk
vi.mock('@anthropic-ai/sdk', () => ({
  default: vi.fn().mockImplementation(() => ({
    messages: {
      create: vi.fn().mockResolvedValue({
        content: [{ type: 'text', text: 'test response' }],
      }),
    },
  })),
}));

// Mock fs
vi.mock('fs', () => ({
  readFileSync: vi.fn(),
  existsSync: vi.fn(),
  writeFileSync: vi.fn(),
}));

// Mock child_process (Keychain access)
vi.mock('child_process', () => ({
  execSync: vi.fn(),
}));

// Mock debug-logger
vi.mock('../../src/debug-logger.js', () => ({
  warn: vi.fn(),
  info: vi.fn(),
}));

describe('HaikuClient', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: no file, no Keychain
    vi.mocked(existsSync).mockReturnValue(false);
    vi.mocked(execSync).mockImplementation(() => {
      throw new Error('not found');
    });
  });

  it('should report unavailable when no credentials anywhere', () => {
    const client = new HaikuClient();
    expect(client.available()).toBe(false);
  });

  it('should read from credentials file (claudeAiOauth format)', () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue(VALID_CREDENTIALS);
    const client = new HaikuClient();
    expect(client.available()).toBe(true);
  });

  it('should fallback to macOS Keychain when no file exists', () => {
    vi.mocked(existsSync).mockReturnValue(false);
    vi.mocked(execSync).mockReturnValue(VALID_CREDENTIALS);
    const client = new HaikuClient();
    expect(client.available()).toBe(true);
  });

  it('should report unavailable when token is expired', () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue(EXPIRED_CREDENTIALS);
    const client = new HaikuClient();
    expect(client.available()).toBe(false);
  });

  it('should report unavailable with wrong credentials format', () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue(
      JSON.stringify({
        'claude.ai': { accessToken: 'wrong-format' },
      })
    );
    const client = new HaikuClient();
    expect(client.available()).toBe(false);
  });

  it('should call Anthropic SDK and return text response', async () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue(VALID_CREDENTIALS);
    const client = new HaikuClient();
    const result = await client.complete('system prompt', 'user message');
    expect(result).toBe('test response');
  });

  it('should reuse SDK client when token unchanged', async () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue(VALID_CREDENTIALS);

    const Anthropic = (await import('@anthropic-ai/sdk')).default;

    const client = new HaikuClient();
    await client.complete('s', 'u');
    await client.complete('s', 'u');

    // Should only create one Anthropic instance (client reuse)
    expect(Anthropic).toHaveBeenCalledTimes(1);
  });

  it('should activate circuit breaker after 3 failures', async () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue(VALID_CREDENTIALS);

    const Anthropic = (await import('@anthropic-ai/sdk')).default;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.mocked(Anthropic).mockImplementation(
      () =>
        ({
          messages: {
            create: vi.fn().mockRejectedValue(new Error('API error')),
          },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        }) as any
    );

    const client = new HaikuClient();
    await expect(client.complete('s', 'u')).rejects.toThrow('API error');
    await expect(client.complete('s', 'u')).rejects.toThrow('API error');
    await expect(client.complete('s', 'u')).rejects.toThrow('API error');
    // 4th call should fail with circuit breaker
    await expect(client.complete('s', 'u')).rejects.toThrow('circuit breaker');
  });
});
