import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { IncomingMessage } from 'node:http';
import { isAuthenticated } from '../../src/api/auth-middleware.js';

function createRequest({
  remoteAddress,
  headers = {},
  url = '/api/test',
}: {
  remoteAddress: string;
  headers?: Record<string, string>;
  url?: string;
}): IncomingMessage {
  return {
    socket: { remoteAddress },
    headers,
    url,
  } as IncomingMessage;
}

describe('auth-middleware', () => {
  const originalToken = process.env.MAMA_AUTH_TOKEN;
  const originalServerToken = process.env.MAMA_SERVER_TOKEN;

  beforeEach(() => {
    process.env.MAMA_AUTH_TOKEN = 'top-secret-token';
    delete process.env.MAMA_SERVER_TOKEN;
  });

  afterEach(() => {
    if (originalToken === undefined) {
      delete process.env.MAMA_AUTH_TOKEN;
    } else {
      process.env.MAMA_AUTH_TOKEN = originalToken;
    }

    if (originalServerToken === undefined) {
      delete process.env.MAMA_SERVER_TOKEN;
    } else {
      process.env.MAMA_SERVER_TOKEN = originalServerToken;
    }
  });

  it('accepts bearer token authentication for remote requests', () => {
    const req = createRequest({
      remoteAddress: '203.0.113.10',
      headers: { authorization: 'Bearer top-secret-token' },
    });

    expect(isAuthenticated(req)).toBe(true);
  });

  it('rejects query token by default', () => {
    const req = createRequest({
      remoteAddress: '203.0.113.10',
      url: '/ws?token=top-secret-token',
    });

    expect(isAuthenticated(req)).toBe(false);
  });

  it('accepts query token when explicitly enabled', () => {
    const req = createRequest({
      remoteAddress: '203.0.113.10',
      url: '/ws?token=top-secret-token',
    });

    expect(isAuthenticated(req, { allowQueryToken: true })).toBe(true);
  });

  it('keeps tunneled localhost requests behind token auth', () => {
    const req = createRequest({
      remoteAddress: '127.0.0.1',
      headers: { 'cf-ray': 'test-ray' },
      url: '/ws?token=top-secret-token',
    });

    expect(isAuthenticated(req)).toBe(false);
    expect(isAuthenticated(req, { allowQueryToken: true })).toBe(true);
  });
});
