import { describe, expect, it } from 'vitest';

import {
  assertContextBoundaryAllowsInput,
  canonicalizeContextScopes,
  derivePrimaryContextScope,
  sanitizeContextPacketForVisibility,
} from '../../src/context-compile/visibility.js';

describe('Story V0.21: Context compile visibility - AC2', () => {
  it('AC: canonicalizes scope order and produces a stable scope hash', () => {
    const left = canonicalizeContextScopes([
      { kind: 'user', id: 'u-1' },
      { kind: 'project', id: 'beta' },
      { kind: 'project', id: 'alpha' },
      { kind: 'project', id: 'alpha' },
    ]);
    const right = canonicalizeContextScopes([
      { kind: 'project', id: 'alpha' },
      { kind: 'user', id: 'u-1' },
      { kind: 'project', id: 'beta' },
    ]);

    expect(left.scopes).toEqual([
      { kind: 'project', id: 'alpha' },
      { kind: 'project', id: 'beta' },
      { kind: 'user', id: 'u-1' },
    ]);
    expect(left.scopeHash).toBe(right.scopeHash);
    expect(left.scopeJson).toBe(right.scopeJson);
  });

  it('AC: chooses a canonical primary scope without losing the full scope set', () => {
    const canonical = canonicalizeContextScopes([
      { kind: 'channel', id: 'c-1' },
      { kind: 'project', id: 'zeta' },
      { kind: 'project', id: 'alpha' },
    ]);

    expect(derivePrimaryContextScope(canonical.scopes)).toEqual({
      kind: 'project',
      id: 'alpha',
    });
    expect(canonical.scopes).toHaveLength(3);
  });

  it('AC: rejects requested scopes and connectors outside the envelope boundary', () => {
    const boundary = {
      scopes: [{ kind: 'project' as const, id: 'alpha' }],
      connectors: ['slack'],
    };

    expect(() =>
      assertContextBoundaryAllowsInput({
        boundary,
        requestedScopes: [{ kind: 'project', id: 'beta' }],
      })
    ).toThrow(/scope/i);
    expect(() =>
      assertContextBoundaryAllowsInput({
        boundary,
        requestedConnectors: ['discord'],
      })
    ).toThrow(/connector/i);
  });

  it('AC: rejects requested project refs and tenant outside the envelope boundary', () => {
    const boundary = {
      scopes: [{ kind: 'project' as const, id: 'alpha' }],
      connectors: ['slack'],
      project_refs: [{ kind: 'project' as const, id: 'repo-a' }],
      tenant_id: 'tenant-a',
    };

    expect(() =>
      assertContextBoundaryAllowsInput({
        boundary,
        requestedProjectRefs: [{ kind: 'project', id: 'repo-b' }],
      })
    ).toThrow(/project/i);
    expect(() =>
      assertContextBoundaryAllowsInput({
        boundary,
        requestedTenantId: 'tenant-b',
      })
    ).toThrow(/tenant/i);
  });

  it('AC: rejects seed refs outside the envelope boundary', () => {
    expect(() =>
      assertContextBoundaryAllowsInput({
        boundary: {
          scopes: [{ kind: 'project', id: 'alpha' }],
          connectors: ['slack'],
        },
        seedRefs: [{ kind: 'raw', raw_id: 'event-1', connector: 'discord' }],
      })
    ).toThrow(/connector/i);
  });

  it('AC: removes hidden candidate identifiers from every public packet field shape', () => {
    const packet = {
      packet_id: 'packet-1',
      source_refs: [
        { kind: 'memory', id: 'visible-memory' },
        { kind: 'memory', id: 'hidden-memory', visible: false },
      ],
      selected_evidence: [
        { ref: { kind: 'memory', id: 'visible-memory' }, excerpt: 'visible' },
        { ref: { kind: 'memory', id: 'hidden-memory', visible: false }, excerpt: 'hidden' },
      ],
      evidence_clusters: [
        {
          label: 'cluster',
          source_refs: [
            { kind: 'raw', raw_id: 'raw-visible', connector: 'slack' },
            { kind: 'raw', raw_id: 'raw-hidden', connector: 'slack', visible: false },
          ],
        },
      ],
      related_decisions: [{ ref: { kind: 'memory', id: 'hidden-related', visible: false } }],
      rejected_refs: [{ kind: 'memory', id: 'hidden-rejected', visible: false }],
      rejected_summary: ['hidden-memory should not leak'],
      missing_context: ['need hidden-memory'],
      caveats: ['raw-hidden was unavailable'],
      expansion_trace: [{ ref: { kind: 'entity', id: 'hidden-entity', visible: false } }],
      retrieval_diagnostics: {
        hidden_ref: { kind: 'memory', id: 'hidden-memory', visible: false },
        hidden_count: 4,
      },
    };

    const sanitized = sanitizeContextPacketForVisibility(packet);
    const serialized = JSON.stringify(sanitized);

    expect(serialized).toContain('visible-memory');
    expect(serialized).toContain('hidden_count');
    expect(serialized).not.toContain('hidden-memory');
    expect(serialized).not.toContain('raw-hidden');
    expect(serialized).not.toContain('hidden-related');
    expect(serialized).not.toContain('hidden-rejected');
    expect(serialized).not.toContain('hidden-entity');
  });
});
