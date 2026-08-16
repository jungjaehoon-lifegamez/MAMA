import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as yaml from 'js-yaml';

const originalHome = process.env.HOME;
const testHome = join(
  tmpdir(),
  `mama-graph-api-config-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
);

let createGraphHandler: typeof import('../../src/api/graph-api.js').createGraphHandler;

beforeAll(async () => {
  process.env.HOME = testHome;
  vi.resetModules();
  ({ createGraphHandler } = await import('../../src/api/graph-api.js'));
});

afterAll(async () => {
  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }
  await rm(testHome, { recursive: true, force: true });
});

describe('PUT /api/config backend model rescoping', () => {
  const configPath = join(testHome, '.mama', 'config.yaml');

  beforeEach(async () => {
    await mkdir(join(testHome, '.mama'), { recursive: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('rescopes agent and role models before persisting a backend change', async () => {
    await writeConfig({
      version: 1,
      agent: {
        backend: 'codex',
        model: 'gpt-5.4',
        max_turns: 10,
        timeout: 300_000,
      },
      roles: {
        definitions: {
          reviewer: { model: 'gpt-5.4', allowedTools: ['*'] },
          operator: { model: 'gpt-5.6-sol', allowedTools: ['*'] },
        },
        sourceMapping: {},
      },
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const handler = createGraphHandler();
    const response = createMockResponse();

    const handled = await handler(
      createPutRequest('/api/config', { agent: { backend: 'claude' } }),
      response as unknown as ServerResponse
    );

    expect(handled).toBe(true);
    expect(response.status).toBe(200);
    const persisted = yaml.load(await readFile(configPath, 'utf8')) as {
      agent: { backend: string; model: string };
      roles: { definitions: Record<string, { model: string }> };
    };
    expect(persisted.agent).toMatchObject({
      backend: 'claude',
      model: 'claude-sonnet-4-6',
    });
    expect(
      Object.values(persisted.roles.definitions).map((definition) => definition.model)
    ).toEqual(['claude-sonnet-4-6', 'claude-sonnet-4-6']);
    expect(warn).toHaveBeenCalledTimes(3);
    expect(warn).toHaveBeenCalledWith(
      '[MAMA CONFIG WARNING] Rescoped agent.model from "gpt-5.4" to "claude-sonnet-4-6".'
    );
    expect(warn).toHaveBeenCalledWith(
      '[MAMA CONFIG WARNING] Rescoped roles.definitions.reviewer.model from "gpt-5.4" to "claude-sonnet-4-6".'
    );
    expect(warn).toHaveBeenCalledWith(
      '[MAMA CONFIG WARNING] Rescoped roles.definitions.operator.model from "gpt-5.6-sol" to "claude-sonnet-4-6".'
    );
  });

  it('preserves a same-backend role override untouched', async () => {
    await writeConfig({
      version: 1,
      agent: {
        backend: 'claude',
        model: 'claude-sonnet-4-6',
        max_turns: 10,
        timeout: 300_000,
      },
      roles: {
        definitions: {
          reviewer: { model: 'claude-opus-4-6', allowedTools: ['*'] },
        },
        sourceMapping: {},
      },
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const handler = createGraphHandler();
    const response = createMockResponse();

    await handler(
      createPutRequest('/api/config', { agent: { backend: 'claude', max_turns: 12 } }),
      response as unknown as ServerResponse
    );

    expect(response.status).toBe(200);
    const persisted = yaml.load(await readFile(configPath, 'utf8')) as {
      roles: { definitions: Record<string, { model: string }> };
    };
    expect(persisted.roles.definitions.reviewer.model).toBe('claude-opus-4-6');
    expect(warn).not.toHaveBeenCalled();
  });

  it('rescopes inherited managed agents on a backend switch and preserves explicit peers', async () => {
    await writeConfig({
      version: 1,
      agent: {
        backend: 'claude',
        model: 'claude-sonnet-4-6',
        max_turns: 10,
        timeout: 300_000,
      },
      multi_agent: {
        enabled: true,
        agents: {
          inherited: { model: 'claude-sonnet-5', tier: 1, enabled: true },
          explicit: { backend: 'codex', model: 'gpt-5.6-sol', tier: 1, enabled: true },
        },
      },
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const handler = createGraphHandler();
    const response = createMockResponse();

    await handler(
      createPutRequest('/api/config', { agent: { backend: 'codex' } }),
      response as unknown as ServerResponse
    );

    expect(response.status).toBe(200);
    const persisted = yaml.load(await readFile(configPath, 'utf8')) as {
      multi_agent: { agents: Record<string, { backend?: string; model: string }> };
    };
    expect(persisted.multi_agent.agents.inherited.model).toBe('gpt-5.4');
    expect(persisted.multi_agent.agents.inherited.backend).toBeUndefined();
    expect(persisted.multi_agent.agents.explicit).toMatchObject({
      backend: 'codex',
      model: 'gpt-5.6-sol',
    });
    expect(warn).toHaveBeenCalledWith(
      '[MAMA CONFIG WARNING] Rescoped multi_agent.agents.inherited.model from "claude-sonnet-5" to "gpt-5.4".'
    );
  });

  it('passes through an unknown future model with a loud family warning', async () => {
    await writeConfig({
      version: 1,
      agent: {
        backend: 'codex',
        model: 'gpt-5.4',
        max_turns: 10,
        timeout: 300_000,
      },
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const handler = createGraphHandler();
    const response = createMockResponse();

    await handler(
      createPutRequest('/api/config', { agent: { model: 'sonnet-future-graph' } }),
      response as unknown as ServerResponse
    );

    expect(response.status).toBe(200);
    const persisted = yaml.load(await readFile(configPath, 'utf8')) as {
      agent: { backend: string; model: string };
    };
    expect(persisted.agent).toMatchObject({ backend: 'codex', model: 'sonnet-future-graph' });
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining(
        'model "sonnet-future-graph" not recognized as a codex-family model; passing through'
      )
    );
  });

  async function writeConfig(config: Record<string, unknown>): Promise<void> {
    await writeFile(configPath, yaml.dump(config), 'utf8');
  }
});

function createPutRequest(url: string, body: Record<string, unknown>): IncomingMessage {
  const listeners = new Map<string, Array<(value?: unknown) => void>>();
  const request = {
    method: 'PUT',
    url,
    headers: { host: 'localhost', 'content-type': 'application/json' },
    socket: { remoteAddress: '127.0.0.1' },
    on(event: string, handler: (value?: unknown) => void) {
      const handlers = listeners.get(event) ?? [];
      handlers.push(handler);
      listeners.set(event, handlers);
      return this;
    },
    destroy() {
      return this;
    },
  } as IncomingMessage;

  queueMicrotask(() => {
    for (const handler of listeners.get('data') ?? []) {
      handler(Buffer.from(JSON.stringify(body)));
    }
    for (const handler of listeners.get('end') ?? []) {
      handler();
    }
  });

  return request;
}

function createMockResponse(): {
  status: number;
  body: string;
  headers: Record<string, string>;
  setHeader(name: string, value: string): void;
  writeHead(status: number, headers?: Record<string, string>): void;
  end(body?: string): void;
} {
  return {
    status: 0,
    body: '',
    headers: {},
    setHeader(name, value) {
      this.headers[name] = value;
    },
    writeHead(status, headers) {
      this.status = status;
      this.headers = { ...this.headers, ...(headers ?? {}) };
    },
    end(body = '') {
      this.body = body;
    },
  };
}
