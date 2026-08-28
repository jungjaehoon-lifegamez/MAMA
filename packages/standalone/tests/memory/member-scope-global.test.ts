import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  closeDB,
  createTrustedProvenanceCapability,
  initDB,
  mama,
  saveMemoryWithTrustedProvenance,
} from '@jungjaehoon/mama-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resolveMemberEffectiveScope } from '../../src/gateways/member-effective-scope.js';
import { deriveMemoryScopes } from '../../src/memory/scope-context.js';

describe('Task 11: member project grants do not inherit implicit global memory', () => {
  let testDir: string;
  let originalDbPath: string | undefined;
  let originalForceTier3: string | undefined;

  beforeEach(async () => {
    originalDbPath = process.env.MAMA_DB_PATH;
    originalForceTier3 = process.env.MAMA_FORCE_TIER_3;
    testDir = mkdtempSync(join(tmpdir(), 'mama-member-global-scope-'));
    await closeDB();
    process.env.MAMA_DB_PATH = join(testDir, 'memory.db');
    process.env.MAMA_FORCE_TIER_3 = 'true';
    await initDB();
  });

  afterEach(async () => {
    await closeDB();
    if (originalDbPath === undefined) delete process.env.MAMA_DB_PATH;
    else process.env.MAMA_DB_PATH = originalDbPath;
    if (originalForceTier3 === undefined) delete process.env.MAMA_FORCE_TIER_3;
    else process.env.MAMA_FORCE_TIER_3 = originalForceTier3;
    rmSync(testDir, { recursive: true, force: true });
  });

  it('returns the granted project but not another project sharing global:system', async () => {
    const principalId = 'principal-member-project-only';
    const grantedProject = 'project-granted';
    const hiddenProject = 'project-hidden';
    const sharedQuery = 'member global sentinel regression';
    const snapshot = resolveMemberEffectiveScope({
      principal: {
        class: 'member',
        lane: 'public',
        canonicalId: 'telegram:global:member-project-only',
        principalId,
        consoleEligible: false,
      },
      current: { connector: 'telegram', lane: 'public', channelId: 'member-chat' },
      configuredGrant: {},
      principalGrants: [
        {
          targetPrincipalId: principalId,
          scope: { kind: 'memory', scopeKind: 'project', scopeId: grantedProject },
          grantedByPrincipalId: 'principal-owner',
          createdAt: 1,
        },
      ],
    });

    const save = (topic: string, marker: string, projectId: string) =>
      saveMemoryWithTrustedProvenance(
        {
          topic,
          kind: 'decision',
          summary: `${sharedQuery} ${marker}`,
          details: marker,
          scopes: deriveMemoryScopes({ source: 'test', projectId }),
          source: { package: 'standalone', source_type: 'test', project_id: projectId },
        },
        {
          capability: createTrustedProvenanceCapability(),
          provenance: { actor: 'main_agent', source_refs: [] },
        }
      );

    await save('member_global_visible', 'VISIBLE_PROJECT_MEMORY', grantedProject);
    await save('member_global_hidden', 'HIDDEN_PROJECT_MEMORY', hiddenProject);

    expect(snapshot.memoryScopes).toEqual([
      { kind: 'project', id: grantedProject },
      { kind: 'user', id: principalId },
    ]);
    const recalled = await mama.recallMemory(sharedQuery, {
      scopes: snapshot.memoryScopes.map((scope) => ({ ...scope })),
    });
    const serialized = JSON.stringify(recalled);
    expect(serialized).toContain('VISIBLE_PROJECT_MEMORY');
    expect(serialized).not.toContain('HIDDEN_PROJECT_MEMORY');
  });
});
