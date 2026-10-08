/**
 * The owner agent's action MCP door: tools/list is catalog.describe over the
 * runtime socket, tools/call is one client.call. Carried from the archive's
 * handleRequest unit surface (tests/mcp/action-server.test.ts).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createCatalog, createDispatcher, startRuntime } from '@jungjaehoon/mama-core';
import { createClient } from '@jungjaehoon/mama-core/client/client';
import type { ActionContract, ActionResult } from '@jungjaehoon/mama-core';
import { resolveActionServerPath } from '../../src/cli/runtime/action-mcp-config.js';
import { CODE_ACT_CONTRACT } from '../../src/api/code-act-actions.js';
import { handleRequest } from '../../src/runtime/action-mcp-server.js';
import { actionMcpSession } from '../helpers/action-mcp-session.js';
import { readSessionCredential } from '../../src/runtime/session-credential.js';

afterEach(() => vi.unstubAllEnvs());
const parentCaller = { session_id: 'native-session', tool_use_id: 'parent-call' };

describe('mama action MCP server — credential rotation', () => {
  it('reads the runtime credential afresh and never uses the legacy root file', () => {
    const home = mkdtempSync(join(tmpdir(), 'mcp-reader-'));
    const credentialPath = join(home, 'runtime', 'session-credential');
    try {
      mkdirSync(join(home, 'runtime'));
      writeFileSync(join(home, 'session-credential'), 'fixture-legacy');
      expect(readSessionCredential(home)).toBeUndefined();
      writeFileSync(credentialPath, 'fixture-first\n');
      expect(readSessionCredential(home)).toBe('fixture-first');
      writeFileSync(credentialPath, 'fixture-rotated\n');
      expect(readSessionCredential(home)).toBe('fixture-rotated');
      writeFileSync(credentialPath, ' \n');
      expect(readSessionCredential(home)).toBeUndefined();
      rmSync(credentialPath);
      expect(readSessionCredential(home)).toBeUndefined();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('re-reads the credential on every stdio request and rejects the revoked token', async () => {
    const home = mkdtempSync(join(tmpdir(), 'mcp-rotation-'));
    vi.stubEnv('HOME', home);
    vi.stubEnv('MAMA_HOME', home);
    const credentialPath = join(home, 'runtime', 'session-credential');
    const socketPath = join(home, 'runtime.sock');
    const catalog = createCatalog([
      {
        contract: {
          name: 'fixture.echo',
          summary: 'Echo fixture input',
          inputSchema: { type: 'object' },
        },
        exec: (input, context) => ({ input, principalId: context.access.principalId }),
      },
      { contract: CODE_ACT_CONTRACT, exec: () => ({ success: true, value: null, logs: [] }) },
    ]);
    const principal = {
      access: {
        principalId: 'owner',
        agentId: 'agent',
        scopes: [],
        actions: ['fixture.echo', 'code_act'],
      },
      credentialPath,
    };
    let runtime: Awaited<ReturnType<typeof startRuntime>> | undefined;
    let mcp: ReturnType<typeof actionMcpSession> | undefined;
    try {
      runtime = await startRuntime({
        paths: { socketPath },
        catalog,
        dispatch: createDispatcher(catalog),
        principals: [principal],
      });
      const first = readFileSync(credentialPath, 'utf8').trim();
      const staleClient = createClient({
        socketPath,
        credential: first,
        journalPath: join(home, 'stale.jsonl'),
      });
      // A legacy file must never be consulted, including after rotation/removal.
      writeFileSync(join(home, 'session-credential'), first);
      mcp = actionMcpSession();
      const listed = {
        result: {
          tools: [
            expect.objectContaining({
              name: 'code_act',
              description: expect.stringContaining('fixture.echo — Echo fixture input'),
            }),
          ],
        },
      };
      expect(await mcp.request('tools/list')).toMatchObject(listed);
      runtime.unservePrincipal('owner');
      const missing = await mcp.request('tools/list');
      expect(missing.error?.message).toContain('unresolved session credential');
      runtime.servePrincipal(principal);
      const second = readFileSync(credentialPath, 'utf8').trim();
      expect(second === first).toBe(false);
      await expect(staleClient.describe()).rejects.toThrow('unresolved session credential');
      expect(await mcp.request('tools/list')).toMatchObject(listed);
      // Rotate again before tools/call, so a refresh only on tools/list cannot pass.
      runtime.unservePrincipal('owner');
      runtime.servePrincipal(principal);
      const called = await mcp.request('tools/call', {
        name: 'fixture.echo',
        arguments: { value: 'fixture', __mama_caller: parentCaller },
      });
      expect(called.error).toBeUndefined();
      const payload = JSON.parse(
        (called.result as { content: Array<{ text: string }> }).content[0]!.text
      );
      expect(payload).toEqual({
        success: true,
        data: { input: { value: 'fixture' }, principalId: 'owner' },
      });
      expect(JSON.stringify(called).includes(readFileSync(credentialPath, 'utf8').trim())).toBe(
        false
      );
    } finally {
      mcp?.close();
      await runtime?.stop();
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('mama action MCP server — handleRequest unit surface', () => {
  const contracts: ActionContract[] = [
    {
      name: 'work.create',
      summary: 'Create a work item',
      inputSchema: { type: 'object', properties: { topic: { type: 'string' } } },
      examples: [{ title: 'one', input: { topic: 'x' } }],
    } as ActionContract,
    {
      name: 'graph.query',
      summary: 'Query the graph',
      inputSchema: { type: 'object' },
    } as ActionContract,
    CODE_ACT_CONTRACT,
  ];
  const calls: Array<{ action: string; input?: unknown }> = [];
  const client = {
    describe: async (): Promise<ActionContract[]> => contracts,
    call: async (call: { action: string; input?: unknown }): Promise<ActionResult> => {
      calls.push(call);
      if (call.action === 'work.create') {
        return { status: 'completed', operationId: 'op_1', data: { commitmentId: 'c1' } };
      }
      return {
        status: 'failed',
        operationId: 'op_2',
        error: { kind: 'unknown_action', code: 'UNKNOWN', message: 'no such action' },
      };
    },
  };

  it('tools/list gives Claude only code_act, whose description lists every other action', async () => {
    const response = await handleRequest(
      { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      { client: client as never }
    );
    const tools = (response?.result as { tools: Array<Record<string, unknown>> }).tools;
    expect(tools).toHaveLength(1);
    // No additionalProperties toward Claude: the caller hook adds __mama_caller to the input.
    expect(tools[0]).toEqual({
      name: 'code_act',
      description: expect.any(String),
      inputSchema: {
        type: 'object',
        required: ['code'],
        properties: (CODE_ACT_CONTRACT.inputSchema as { properties: unknown }).properties,
      },
    });
    const description = tools[0].description as string;
    expect(description.startsWith(CODE_ACT_CONTRACT.summary)).toBe(true);
    expect(description).toContain('\nActions:\nwork.create — Create a work item');
    expect(description).toContain('\ngraph.query — Query the graph');
    expect(description).not.toContain('code_act —');
    await expect(
      handleRequest(
        { jsonrpc: '2.0', id: 2, method: 'tools/list' },
        { client: { describe: async () => contracts.slice(0, 2) } as never }
      )
    ).rejects.toThrow('code_act is not granted');
  });

  it('marks a code_act script that threw as a failed call', async () => {
    const response = await handleRequest(
      {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'code_act', arguments: { code: 'x', __mama_caller: parentCaller } },
      },
      {
        client: {
          call: async () => ({
            status: 'completed',
            operationId: 'op_3',
            data: { success: false, error: { name: 'Error', message: 'boom' }, logs: [] },
          }),
        } as never,
      }
    );
    const result = response?.result as { isError?: boolean; content: Array<{ text: string }> };
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0]!.text).success).toBe(false);
  });

  it('tools/call is one client.call — the adapter executes nothing itself', async () => {
    const response = await handleRequest(
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'work.create', arguments: { topic: 't', __mama_caller: parentCaller } },
      },
      { client: client as never }
    );
    expect(calls).toEqual([
      { action: 'work.create', input: { topic: 't' }, session: { nativeCaller: parentCaller } },
    ]);
    const content = (response?.result as { content: Array<{ text: string }> }).content;
    expect(JSON.parse(content[0].text)).toEqual({
      success: true,
      data: { commitmentId: 'c1' },
    });
    expect((response?.result as { isError?: boolean }).isError).toBeUndefined();
  });

  it('a failed action result is success:false + isError — never a silent pass', async () => {
    const response = await handleRequest(
      {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'memory.delete', arguments: { __mama_caller: parentCaller } },
      },
      { client: client as never }
    );
    const result = response?.result as {
      isError?: boolean;
      content: Array<{ text: string }>;
    };
    expect(result.isError).toBe(true);
    const payload = JSON.parse(result.content[0].text) as Record<string, unknown>;
    expect(payload.success).toBe(false);
    expect(payload.status).toBe('failed');
    expect((payload.error as { code: string }).code).toBe('UNKNOWN');
  });

  it('a missing tool name fails closed; notifications get no reply', async () => {
    const response = await handleRequest(
      { jsonrpc: '2.0', id: 4, method: 'tools/call', params: {} },
      { client: client as never }
    );
    expect((response?.result as { isError?: boolean }).isError).toBe(true);
    const silent = await handleRequest(
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { client: client as never }
    );
    expect(silent).toBeNull();
  });
});

describe('mama action MCP server — location', () => {
  it('refuses an unattributed MCP call instead of writing an operation-only trace', async () => {
    const call = vi.fn();
    const result = await handleRequest(
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'work.create', arguments: { topic: 'fixture' } },
      },
      { client: { call } as never }
    );
    expect(result?.result).toMatchObject({ isError: true });
    expect(call).not.toHaveBeenCalled();
  });
  it('strips hook caller metadata and forwards it as per-call session facts', async () => {
    const call = vi.fn(async () => ({ status: 'completed', data: {} }));
    const caller = {
      session_id: 'native-session',
      tool_use_id: 'call-1',
      agent_id: 'child-1',
      agent_type: 'general-purpose',
    };
    await handleRequest(
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'work.create', arguments: { topic: 'fixture', __mama_caller: caller } },
      },
      { client: { call } as never }
    );
    expect(call).toHaveBeenCalledWith({
      action: 'work.create',
      input: { topic: 'fixture' },
      session: { nativeCaller: caller },
    });
  });

  it('is the standalone build output, not another package', () => {
    expect(resolveActionServerPath()).toMatch(/[/\\]runtime[/\\]action-mcp-server\.js$/);
  });
});

it('offers only member actions from the shared socket catalog', async () => {
  const contracts = [
    CODE_ACT_CONTRACT,
    { name: 'memory.search', summary: 'Personal search', inputSchema: { type: 'object' } },
    {
      name: 'manage.policy.read',
      summary: 'OWNER_POLICY_ACTION_SENTINEL',
      inputSchema: { type: 'object' },
    },
  ];
  const result = await handleRequest(
    { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    {
      client: { describe: async () => contracts } as never,
      allowedActions: ['code_act', 'memory.search'],
    }
  );
  expect(JSON.stringify(result)).toContain('Personal search');
  expect(JSON.stringify(result)).not.toContain('OWNER_POLICY_ACTION_SENTINEL');
});
