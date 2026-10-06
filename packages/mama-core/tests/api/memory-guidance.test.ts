import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { getAdapter } from '../../src/db-manager.js';
import { createKnowledge } from '../../src/knowledge/index.js';
import { createCatalog, coreActionRegistrations } from '../../src/api/catalog.js';
import { createDispatcher } from '../../src/api/dispatch.js';
import { cleanupTestDB, initTestDB } from '../helpers/test-utils.js';
import type { MemoryScopeRef } from '../../src/memory/types.js';

const OWNER_SCOPE: MemoryScopeRef = { kind: 'project', id: 'guidance-project' };
const OTHER_SCOPE: MemoryScopeRef = { kind: 'project', id: 'other-project' };
const ACCESS = {
  principalId: 'guidance-owner',
  agentId: 'guidance-agent',
  scopes: [OWNER_SCOPE],
  actions: ['memory.save', 'memory.read:record', 'memory.read:listing', 'memory.retire'],
};

describe('scoped guidance memory actions', () => {
  let dbPath = '';
  let dispatch: ReturnType<typeof createDispatcher>;

  beforeAll(async () => {
    dbPath = await initTestDB('memory-guidance');
    const knowledge = createKnowledge({ adapter: getAdapter(), embedder: null });
    dispatch = createDispatcher(createCatalog(coreActionRegistrations(knowledge, getAdapter())));
  });

  beforeEach(() => {
    const db = getAdapter();
    db.prepare('DELETE FROM twin_edges').run();
    db.prepare('DELETE FROM judgment_commands').run();
    db.prepare('DELETE FROM command_bindings').run();
    db.prepare('DELETE FROM memory_events').run();
    db.prepare('DELETE FROM memory_scope_bindings').run();
    db.prepare('DELETE FROM memory_scopes').run();
    db.prepare('DELETE FROM embeddings').run();
    db.prepare('DELETE FROM decisions').run();
  });

  afterAll(async () => cleanupTestDB(dbPath));

  const call = (action: string, operationId: string, input: unknown, access = ACCESS) =>
    dispatch({ action, operationId, input }, { access });

  const saveWorkflow = (
    operationId: string,
    replaces?: string,
    scope: MemoryScopeRef = OWNER_SCOPE,
    access = ACCESS
  ) =>
    call(
      'memory.save',
      operationId,
      {
        topic: 'release procedure',
        kind: 'workflow',
        summary: 'Check the release before sending it',
        details: 'The approved release procedure.',
        appliesWhen: 'When preparing a release for review',
        steps: ['Read the release checklist', 'Confirm the build result', 'Send the summary'],
        evidenceChecks: ['Read the current checklist'],
        scopes: [scope],
        source: { package: 'consumer', source_type: 'test' },
        ...(replaces === undefined
          ? {}
          : { replaces: [{ id: replaces, reason: 'Owner approved a revision' }] }),
      },
      access
    );

  it('requires an applies-when line for workflows', async () => {
    const result = await call('memory.save', 'workflow-without-scope', {
      topic: 'release procedure',
      kind: 'workflow',
      summary: 'Check the release before sending it',
      details: 'The approved release procedure.',
      steps: ['Read the release checklist'],
      scopes: [OWNER_SCOPE],
      source: { package: 'consumer', source_type: 'test' },
    });

    expect(result).toMatchObject({
      status: 'failed',
      error: { code: 'INVALID_INPUT', message: expect.stringMatching(/applies.?when/i) },
    });
  });

  it('reads the complete structured workflow only under an admitted scope', async () => {
    const saved = await saveWorkflow('workflow-first');
    expect(saved.status).toBe('completed');
    const id = String((saved as { data: { id: string } }).data.id);

    const visible = await call('memory.read:record', 'workflow-read-visible', { memory_id: id });
    expect(visible).toMatchObject({
      status: 'completed',
      data: {
        record: {
          id,
          kind: 'workflow',
          topic: 'release procedure',
          appliesWhen: 'When preparing a release for review',
          steps: ['Read the release checklist', 'Confirm the build result', 'Send the summary'],
          evidenceChecks: ['Read the current checklist'],
        },
      },
    });
    expect(
      (visible as { data: { record: Record<string, unknown> } }).data.record
    ).not.toHaveProperty('provenance');

    const hidden = await call(
      'memory.read:record',
      'workflow-read-hidden',
      { memory_id: id },
      {
        ...ACCESS,
        scopes: [OTHER_SCOPE],
      }
    );
    expect(hidden).toMatchObject({ status: 'completed', data: { record: null } });
  });

  it('does not let a read-only scope authorize workflow retirement', async () => {
    const writer = { ...ACCESS, scopes: [OTHER_SCOPE] };
    const saved = await saveWorkflow('workflow-read-only-target', undefined, OTHER_SCOPE, writer);
    const id = String((saved as { data: { id: string } }).data.id);
    const readOnly = { ...ACCESS, readScopes: [OTHER_SCOPE] };

    const retired = await call(
      'memory.retire',
      'workflow-read-only-retire',
      { memory_id: id, status: 'stale', reason: 'A read grant cannot retire guidance.' },
      readOnly
    );
    const readable = await call(
      'memory.read:record',
      'workflow-read-only-check',
      { memory_id: id },
      readOnly
    );

    expect(retired.status).toBe('failed');
    expect(readable).toMatchObject({ data: { record: { id, status: 'active' } } });
  });

  it('revises a workflow through replaces while retaining the earlier record', async () => {
    const first = await saveWorkflow('workflow-revision-first');
    const firstId = String((first as { data: { id: string } }).data.id);
    const second = await saveWorkflow('workflow-revision-second', firstId);
    const secondId = String((second as { data: { id: string } }).data.id);

    const prior = await call('memory.read:record', 'workflow-read-prior', { memory_id: firstId });
    const current = await call('memory.read:record', 'workflow-read-current', {
      memory_id: secondId,
    });
    expect(prior).toMatchObject({ data: { record: { id: firstId, status: 'superseded' } } });
    expect(current).toMatchObject({
      data: {
        record: {
          id: secondId,
          status: 'active',
          steps: ['Read the release checklist', 'Confirm the build result', 'Send the summary'],
        },
      },
    });
  });

  it('retires with a reason and receipt, hides the active entry, and keeps the record', async () => {
    const saved = await saveWorkflow('workflow-retire-target');
    const id = String((saved as { data: { id: string } }).data.id);
    const kept = await saveWorkflow('workflow-still-active');
    const keptId = String((kept as { data: { id: string } }).data.id);
    const retired = await call('memory.retire', 'workflow-retire-command', {
      memory_id: id,
      status: 'stale',
      reason: 'The owner withdrew this procedure after the release process changed.',
    });

    expect(retired).toMatchObject({
      status: 'completed',
      data: {
        id,
        status: 'stale',
        reason: expect.stringMatching(/owner withdrew/),
        receiptId: expect.any(String),
      },
    });
    const active = await call('memory.read:listing', 'workflow-active-list', { status: 'active' });
    const listed = (active as { data: { decisions: Array<{ id: string }> } }).data.decisions;
    // The listing shows the other active rule, so the retired one's absence is the retirement.
    expect(listed).toEqual(expect.arrayContaining([expect.objectContaining({ id: keptId })]));
    expect(listed).not.toEqual(expect.arrayContaining([expect.objectContaining({ id })]));
    const retained = await call('memory.read:record', 'workflow-read-retired', { memory_id: id });
    expect(retained).toMatchObject({ data: { record: { id, status: 'stale' } } });

    const receipt = getAdapter()
      .prepare('SELECT command_id, record_id FROM judgment_commands WHERE command_id = ?')
      .get('workflow-retire-command');
    expect(receipt).toBeDefined();
    const amendment = getAdapter()
      .prepare('SELECT payload_json FROM decisions WHERE id = ?')
      .get((retired as { data: { receiptId: string } }).data.receiptId) as {
      payload_json: string;
    };
    expect(JSON.parse(amendment.payload_json)).toMatchObject({
      amended: id,
      status: 'stale',
      reason: 'The owner withdrew this procedure after the release process changed.',
    });
  });
});
