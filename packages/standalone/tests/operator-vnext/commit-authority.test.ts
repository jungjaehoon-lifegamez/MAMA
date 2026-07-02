import { describe, expect, it } from 'vitest';

import { resolveCommitAuthority } from '../../src/operator-vnext/commit-authority.js';

describe('Story PR5.3: vNext Commit Authority', () => {
  describe('AC #1: only the primary operator can perform allowed durable writes', () => {
    it('allows legacy mode to preserve existing behavior', () => {
      expect(
        resolveCommitAuthority({
          runtimeMode: 'legacy',
          toolName: 'report_publish',
          actor: { kind: 'worker', agentId: 'dashboard-agent' },
        })
      ).toMatchObject({ allowed: true, effect: 'legacy' });
    });

    it('denies report_publish as canonical state in vNext mode', () => {
      expect(
        resolveCommitAuthority({
          runtimeMode: 'vnext',
          toolName: 'report_publish',
          actor: { kind: 'primary_operator', agentId: 'operator:primary' },
        })
      ).toMatchObject({
        allowed: false,
        code: 'vnext_report_projection_only',
      });
    });

    it('lets the primary operator publish source-linked wiki artifacts', () => {
      expect(
        resolveCommitAuthority({
          runtimeMode: 'vnext',
          toolName: 'wiki_publish',
          actor: { kind: 'primary_operator', agentId: 'operator:primary' },
        })
      ).toMatchObject({ allowed: true, effect: 'commit' });
    });

    it('restricts workers to proposals for durable write tools', () => {
      expect(
        resolveCommitAuthority({
          runtimeMode: 'vnext',
          toolName: 'wiki_publish',
          actor: { kind: 'worker', agentId: 'wiki-agent' },
        })
      ).toMatchObject({
        allowed: false,
        effect: 'proposal_required',
        code: 'vnext_worker_proposal_required',
      });
    });

    it('treats memory updates as durable writes in vNext mode', () => {
      expect(
        resolveCommitAuthority({
          runtimeMode: 'vnext',
          toolName: 'mama_update',
          actor: { kind: 'worker', agentId: 'memory-agent' },
        })
      ).toMatchObject({
        allowed: false,
        effect: 'proposal_required',
        code: 'vnext_worker_proposal_required',
      });
    });

    it('lets viewer admins manually save source-linked memory through the allowed path', () => {
      expect(
        resolveCommitAuthority({
          runtimeMode: 'vnext',
          toolName: 'mama_save',
          actor: { kind: 'viewer_admin', agentId: 'viewer-session' },
        })
      ).toMatchObject({ allowed: true, effect: 'manual' });
    });

    it('denies direct Obsidian mutation because vNext wiki state must be source-linked', () => {
      expect(
        resolveCommitAuthority({
          runtimeMode: 'vnext',
          toolName: 'obsidian',
          actor: { kind: 'worker', agentId: 'wiki-agent' },
        })
      ).toMatchObject({
        allowed: false,
        effect: 'denied',
        code: 'vnext_obsidian_disabled',
      });
    });

    it('keeps raw filesystem writes on viewer policy instead of worker authority', () => {
      expect(
        resolveCommitAuthority({
          runtimeMode: 'vnext',
          toolName: 'Write',
          actor: { kind: 'worker', agentId: 'dashboard-agent' },
        })
      ).toMatchObject({
        allowed: false,
        effect: 'denied',
        code: 'vnext_filesystem_write_denied',
      });

      expect(
        resolveCommitAuthority({
          runtimeMode: 'vnext',
          toolName: 'Write',
          actor: { kind: 'viewer_admin', agentId: 'viewer-session' },
        })
      ).toMatchObject({ allowed: true, effect: 'manual' });
    });

    it('denies Bash for workers because shell commands can mutate files', () => {
      expect(
        resolveCommitAuthority({
          runtimeMode: 'vnext',
          toolName: 'Bash',
          actor: { kind: 'worker', agentId: 'developer-agent' },
        })
      ).toMatchObject({
        allowed: false,
        effect: 'denied',
        code: 'vnext_filesystem_write_denied',
      });

      expect(
        resolveCommitAuthority({
          runtimeMode: 'vnext',
          toolName: 'Bash',
          actor: { kind: 'viewer_admin', agentId: 'viewer-session' },
        })
      ).toMatchObject({ allowed: true, effect: 'manual' });
    });
  });
});
