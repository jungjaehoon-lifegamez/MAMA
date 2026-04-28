import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Envelope } from '../../src/envelope/types.js';

const CODE_TASK_AGENTS = ['architect', 'developer', 'pm', 'reviewer'];
const TEST_DIR = dirname(fileURLToPath(import.meta.url));

type CodeTaskEnvelopeBuilder = (input: { to_agent_id: string; parent: Envelope }) => Envelope;

describe('code-task delegation envelope', () => {
  const p5WiringMarker = join(TEST_DIR, '..', '..', 'src', 'multi-agent', 'delegate-envelope.ts');
  const p5Wired = existsSync(p5WiringMarker);

  if (!p5Wired) {
    it.skip('P5 wiring not yet present; will run when delegate-envelope.ts exists', () => {});
  } else {
    it.each(CODE_TASK_AGENTS)(
      '%s receives envelope with empty memory scopes from real P5 builder',
      async (agentId) => {
        const modulePath = '../../src/multi-agent/delegate-envelope.js';
        const { buildCodeTaskEnvelope } = (await import(modulePath)) as {
          buildCodeTaskEnvelope: CodeTaskEnvelopeBuilder;
        };
        const parent: Envelope = {
          agent_id: 'parent',
          instance_id: 'parent-1',
          source: 'delegate',
          trigger_context: {},
          scope: {
            project_refs: [{ kind: 'project', id: '/A' }],
            raw_connectors: ['telegram'],
            memory_scopes: [{ kind: 'project', id: '/A' }],
            allowed_destinations: [{ kind: 'telegram', id: 'tg:1' }],
          },
          tier: 1,
          budget: { wall_seconds: 60 },
          expires_at: new Date(Date.now() + 60_000).toISOString(),
          envelope_hash: 'parent-hash',
        };

        const env = buildCodeTaskEnvelope({ to_agent_id: agentId, parent });
        expect(env.scope.memory_scopes).toEqual([]);
        expect(env.scope.allowed_destinations).toEqual([]);
      }
    );
  }
});
