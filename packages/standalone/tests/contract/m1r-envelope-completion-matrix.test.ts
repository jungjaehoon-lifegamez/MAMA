import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

type Row = {
  id: string;
  milestone: 'M1R' | 'M7' | 'M8' | 'outside-memory-twin';
  status: 'done' | 'partial' | 'missing' | 'owned-by-later-milestone';
};

const ROWS: Row[] = [
  { id: 'envelope-table', milestone: 'M1R', status: 'done' },
  { id: 'enforcer-hook', milestone: 'M1R', status: 'partial' },
  { id: 'memory-scope-mismatch-logging', milestone: 'M1R', status: 'missing' },
  { id: 'reactive-runtime-issuance', milestone: 'M1R', status: 'missing' },
  { id: 'code-act-hostbridge-context', milestone: 'M1R', status: 'missing' },
  { id: 'agent-loop-client-envelope-options', milestone: 'M1R', status: 'missing' },
  { id: 'gateway-tool-call-envelope-hash-audit', milestone: 'M1R', status: 'missing' },
  { id: 'activity-trace-filter', milestone: 'M1R', status: 'missing' },
  { id: 'delegated-memory-worker-envelope', milestone: 'M7', status: 'owned-by-later-milestone' },
  { id: 'autonomous-standing-envelope', milestone: 'M8', status: 'owned-by-later-milestone' },
  {
    id: 'code-task-delegation',
    milestone: 'outside-memory-twin',
    status: 'owned-by-later-milestone',
  },
];

describe('Story M1R: Reactive envelope completion matrix', () => {
  describe('AC: M1R is not allowed to silently absorb M7/M8 work', () => {
    it('keeps later worker modes outside the M1R completion claim', () => {
      expect(ROWS.filter((row) => row.milestone === 'M7').map((row) => row.id)).toEqual([
        'delegated-memory-worker-envelope',
      ]);
      expect(ROWS.filter((row) => row.milestone === 'M8').map((row) => row.id)).toEqual([
        'autonomous-standing-envelope',
      ]);
    });

    it('lists the M1R rows this plan must close', () => {
      expect(
        ROWS.filter((row) => row.milestone === 'M1R' && row.status !== 'done').map((row) => row.id)
      ).toEqual([
        'enforcer-hook',
        'memory-scope-mismatch-logging',
        'reactive-runtime-issuance',
        'code-act-hostbridge-context',
        'agent-loop-client-envelope-options',
        'gateway-tool-call-envelope-hash-audit',
        'activity-trace-filter',
      ]);
    });

    it('classifies current Code-Act HostBridge executor calls as M1R work', () => {
      const hostBridge = readFileSync(
        join(process.cwd(), 'src/agent/code-act/host-bridge.ts'),
        'utf8'
      );
      expect(hostBridge).toContain('.execute(');
      expect(ROWS.find((row) => row.id === 'code-act-hostbridge-context')).toMatchObject({
        milestone: 'M1R',
        status: 'missing',
      });
    });
  });
});
