import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { createKnowledge } from '../../src/knowledge/index.js';
import { appendJudgment, createJudgmentWriter } from '../../src/knowledge/judgments.js';
import { openDatabase, type DatabaseHandle } from '../../src/storage/database.js';

const ACCESS = {
  principalId: 'principal-test',
  agentId: 'agent-test',
  scopes: [{ kind: 'project' as const, id: 'scope-test' }],
};

describe('Story R1: knowledge instance isolation', () => {
  const dirs: string[] = [];
  const handles: DatabaseHandle[] = [];

  afterAll(async () => {
    for (const handle of handles) {
      await handle.close();
    }
    for (const dir of dirs) {
      await rm(dir, { recursive: true, force: true });
    }
  });

  async function openIsolated(name: string): Promise<DatabaseHandle> {
    const dir = await mkdtemp(path.join(tmpdir(), `mama-isolation-${name}-`));
    dirs.push(dir);
    const handle = await openDatabase({ path: path.join(dir, 'test.db') });
    handles.push(handle);
    return handle;
  }

  it('requires an explicit embedder choice and stores vectors only when supplied', async () => {
    const { adapter } = await openIsolated('embedder-choice');
    const vector = new Float32Array(1024).fill(0.25);
    for (const construct of [createKnowledge, createJudgmentWriter]) {
      for (const options of [{ adapter }, { adapter, embedder: undefined }]) {
        expect(() => Reflect.apply(construct, undefined, [options])).toThrow(
          /embedder.*null.*text-only/
        );
      }
      for (const embedder of [null, { embed: async () => vector }]) {
        const writer = construct({ adapter, embedder });
        const receipt = await writer.appendJudgment(
          {
            commandId: `${construct.name}-${embedder === null ? 'text' : 'vector'}`,
            topic: 'embedder-choice',
            summary: 'Store a record with the selected indexing mode',
            recordKind: 'judgment',
          },
          ACCESS
        );
        expect(
          adapter.prepare('SELECT id FROM decisions WHERE id = ?').get(receipt.recordId)
        ).toEqual({ id: receipt.recordId });
        const stored = adapter
          .prepare(
            'SELECT embedding FROM embeddings WHERE rowid = (SELECT rowid FROM decisions WHERE id = ?)'
          )
          .get(receipt.recordId) as { embedding: Buffer } | undefined;
        if (embedder === null) {
          expect(stored).toBeUndefined();
        } else {
          expect(stored?.embedding).toEqual(Buffer.from(vector.buffer));
        }
      }
    }
    // The public write path refuses the omission too; work writes go through it.
    await expect(
      Reflect.apply(appendJudgment, undefined, [
        {
          commandId: 'direct-without-embedder',
          topic: 'embedder-choice',
          summary: 'A direct write that names no embedder',
          recordKind: 'judgment',
        },
        ACCESS,
        { adapter },
      ])
    ).rejects.toThrow(/embedder.*null.*text-only/);
  });

  it('a judgment written on one instance is invisible on another', async () => {
    const first = await openIsolated('a');
    const second = await openIsolated('b');
    const knowledgeA = createKnowledge({ adapter: first.adapter, embedder: null });
    const knowledgeB = createKnowledge({ adapter: second.adapter, embedder: null });

    const receipt = await knowledgeA.appendJudgment(
      {
        commandId: 'cmd-isolation-1',
        topic: 'isolation-topic',
        summary: 'written on instance A',
        recordKind: 'judgment',
        scopes: ACCESS.scopes,
      },
      ACCESS
    );

    const pageA = knowledgeA.queryGraph(
      { seeds: [{ kind: 'memory', id: receipt.recordId }], view: 'detail' },
      ACCESS
    );
    expect(pageA.nodes.map((node) => node.ref.id)).toContain(receipt.recordId);

    expect(second.adapter.prepare('SELECT COUNT(*) AS n FROM decisions').get()).toEqual({
      n: 0,
    });
    expect(() =>
      knowledgeB.queryGraph(
        { seeds: [{ kind: 'memory', id: receipt.recordId }], view: 'detail' },
        ACCESS
      )
    ).toThrow();
  });
});
