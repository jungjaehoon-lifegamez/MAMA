import { mkdirSync, mkdtempSync, rmSync, symlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import Database from 'better-sqlite3';
import { describe, it, expect } from 'vitest';

async function connect(home, explicitDb = true) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve('src/server.js')],
    env: {
      HOME: home,
      NODE_ENV: 'production',
      ...(explicitDb ? { MAMA_DB_PATH: join(home, 'memory.db') } : {}),
    },
    stderr: 'pipe',
  });
  let stderr = '';
  transport.stderr.on('data', (chunk) => {
    stderr = (stderr + chunk).slice(-4000);
  });
  const client = new Client({ name: 'mcp-smoke', version: '1.0.0' });
  try {
    await client.connect(transport);
  } catch (error) {
    await transport.close();
    throw new Error(`${error.message}\n${stderr}`);
  }
  return client;
}

async function call(client, name, args) {
  const response = await client.callTool({ name, arguments: args });
  expect(response.isError, JSON.stringify(response)).not.toBe(true);
  return JSON.parse(response.content[0].text);
}

describe('public MCP stdio', () => {
  it('initializes, lists tools, saves, searches, updates, ingests and resumes after restart', async () => {
    const home = mkdtempSync(join(tmpdir(), 'mama-stdio-'));
    // Reuse the already downloaded model while all process state stays in temp HOME.
    mkdirSync(join(home, '.cache', 'huggingface'), { recursive: true });
    symlinkSync(
      process.env.MAMA_TEST_MODEL_CACHE,
      join(home, '.cache', 'huggingface', 'transformers')
    );
    let client;
    try {
      client = await connect(home);
      const { tools } = await client.listTools();
      expect(tools.map((tool) => tool.name)).toEqual(
        expect.arrayContaining([
          'save',
          'search',
          'update',
          'link',
          'get_decision',
          'search_decisions_and_contracts',
          'case_timeline_range',
        ])
      );
      const saved = await call(client, 'save', {
        type: 'decision',
        topic: 'stdio_storage',
        decision: 'Store development decisions in a local SQLite database.',
        reasoning: 'The public memory server owns its development database.',
        confidence: 0.9,
      });
      expect(saved.success).toBe(true);
      expect(typeof saved.id).toBe('string');
      const found = await call(client, 'search', {
        query: 'Store development decisions in a local SQLite database.',
        type: 'decision',
        threshold: 0.5,
        disableRecency: true,
        diagnostics: true,
      });
      expect(found.success).toBe(true);
      expect(
        found.results.find((row) => row.id === saved.id).retrieval_diagnostics.vector_similarity
      ).toBeGreaterThan(0.5);
      const updated = await call(client, 'update', { id: saved.id, outcome: 'success' });
      expect(updated.success).toBe(true);
      const checkpoint = await call(client, 'save', {
        type: 'checkpoint',
        summary: 'Continue the stdio storage review',
        open_files: ['src/server.js'],
        next_steps: 'Verify the saved decision',
      });
      expect(checkpoint.success).toBe(true);
      const ingested = await call(client, 'save', {
        type: 'ingest',
        messages: [{ role: 'user', content: 'Review the storage boundary.' }],
      });
      expect(ingested.success, JSON.stringify(ingested)).toBe(true);
      expect(typeof ingested.raw_id).toBe('string');
      const contractOptions = {
        query: 'local SQLite database',
        decisionLimit: 5,
        contractLimit: 0,
        similarityThreshold: 0.5,
      };
      const contractSchema = tools.find(
        (tool) => tool.name === 'search_decisions_and_contracts'
      ).inputSchema;
      for (const option of Object.keys(contractOptions)) {
        expect(contractSchema.properties, `Undocumented option: ${option}`).toHaveProperty(option);
      }
      const contracts = await call(client, 'search_decisions_and_contracts', contractOptions);
      expect(contracts.success).toBe(true);
      expect(contracts.decisionResults.some((row) => row.id === saved.id)).toBe(true);
      expect(contracts.contractResults).toEqual([]);
      const db = new Database(join(home, 'memory.db'), { readonly: true });
      try {
        expect(
          db
            .prepare('SELECT body FROM observation_versions WHERE observation_id = ?')
            .get(ingested.raw_id).body
        ).toContain('Review the storage boundary.');
        expect(db.prepare('SELECT outcome FROM decisions WHERE id = ?').get(saved.id).outcome).toBe(
          'SUCCESS'
        );
        expect(
          db.prepare('SELECT summary FROM checkpoints WHERE id = ?').get(checkpoint.id).summary
        ).toBe('Continue the stdio storage review');
      } finally {
        db.close();
      }
      await client.close();
      client = await connect(home);
      const resumed = await client.callTool({
        name: 'load_checkpoint',
        arguments: { include_narrative: false },
      });
      expect(resumed.isError).not.toBe(true);
      expect(resumed.content[0].text).toContain('Continue the stdio storage review');
      const listed = await call(client, 'search', { type: 'decision' });
      expect(listed.results.some((row) => row.id === saved.id)).toBe(true);
      expect(existsSync(join(home, '.claude', 'mama-memory.db'))).toBe(false);
    } finally {
      await client?.close();
      rmSync(home, { recursive: true, force: true });
    }
  }, 90000);

  it('uses the development-memory default in production before opening the database', async () => {
    const home = mkdtempSync(join(tmpdir(), 'mama-stdio-default-'));
    let client;
    try {
      client = await connect(home, false);
      const checkpoint = await call(client, 'save', {
        type: 'checkpoint',
        summary: 'Default path checkpoint',
      });
      expect(checkpoint.success).toBe(true);
      expect(existsSync(join(home, '.claude', 'mama-memory.db'))).toBe(true);
    } finally {
      await client?.close();
      rmSync(home, { recursive: true, force: true });
    }
  });
});
