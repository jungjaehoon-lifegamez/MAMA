import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolvePrivateWorkspaceFile } from '../../src/operator/owner-event-effects.js';
import {
  repairIdFor,
  resolveRepairRoot,
  writeRepairBundle,
} from '../../src/operator/repair-request.js';

let base: string;
let root: string;
let previousWorkspace: string | undefined;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'mama-repair-'));
  root = join(base, 'repairs');
  previousWorkspace = process.env.MAMA_WORKSPACE;
  process.env.MAMA_WORKSPACE = join(base, 'workspace');
  mkdirSync(join(base, 'workspace'), { recursive: true });
});
afterEach(() => {
  if (previousWorkspace === undefined) delete process.env.MAMA_WORKSPACE;
  else process.env.MAMA_WORKSPACE = previousWorkspace;
  rmSync(base, { recursive: true, force: true });
});

const ISSUE = 'iss_0123456789abcdef';
const NOW = Date.parse('2026-09-04T06:00:00.000Z');
const input = () => ({
  issue_id: ISSUE,
  title: 'context_compile refuses board scope',
  symptom: 'every board run fails with worker_envelope_scope_denied',
  impact: 'no board judgment for two weeks',
  evidence: {
    run_ids: ['mr_abc', 'bad id with spaces'],
    trace_ids: ['tr_1'],
    log_window: {
      file: '~/.mama/logs/daemon.log',
      from: '2026-09-03T00:00:00Z',
      to: '2026-09-03T12:00:00Z',
    },
    queries: ['select count(*) from evidence_effects'],
  },
  reproduction: 'enqueue a board reconcile for a private channel',
  attempted: 'nothing; the envelope is host-built',
});

describe('Story ONE-MAMA-P3 Task 3: repair_request bundle', () => {
  it('AC #1 writes frontmatter and every section, filters unsafe ids, renders the log window as a range', () => {
    const result = writeRepairBundle(input(), root, NOW);
    expect(result.created).toBe(true);
    expect(result.repairId).toBe(repairIdFor(ISSUE));
    const text = readFileSync(result.path, 'utf-8');
    expect(text).toContain(`repair_id: ${result.repairId}`);
    expect(text).toContain(`issue_id: ${ISSUE}`);
    expect(text).toContain('created_at: 2026-09-04T06:00:00.000Z');
    for (const section of [
      '## Symptom',
      '## Impact',
      '## Evidence',
      '## Reproduction',
      '## Attempted',
      '## Repair',
    ]) {
      expect(text).toContain(section);
    }
    expect(text).toContain('- run ids: mr_abc');
    expect(text).not.toContain('bad id with spaces');
    expect(text).toContain(
      'log window: ~/.mama/logs/daemon.log from 2026-09-03T00:00:00Z to 2026-09-03T12:00:00Z'
    );
    expect(text).toContain('no content is embedded');
  });

  it('AC #2 a token-shaped symptom is stored redacted with zero original characters', () => {
    const secret = ['ghp', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789ab'].join('_');
    const result = writeRepairBundle({ ...input(), symptom: `failed with ${secret}` }, root, NOW);
    const text = readFileSync(result.path, 'utf-8');
    expect(text).not.toContain(secret);
    expect(text).toContain('[redacted:');
  });

  it('AC #3 a path-traversing or malformed issue_id is refused', () => {
    expect(() =>
      writeRepairBundle({ ...input(), issue_id: '../../etc/passwd' }, root, NOW)
    ).toThrow(/issue_id/);
    expect(() => writeRepairBundle({ ...input(), issue_id: 'iss_xyz' }, root, NOW)).toThrow(
      /issue_id/
    );
    expect(existsSync(root)).toBe(false);
  });

  it('AC #4 a duplicate request returns the existing id with created:false and rewrites nothing', () => {
    const first = writeRepairBundle(input(), root, NOW);
    const second = writeRepairBundle({ ...input(), title: 'changed' }, root, NOW + 1);
    expect(second).toEqual({ ...first, created: false });
    expect(readFileSync(first.path, 'utf-8')).toContain('# context_compile refuses board scope');
  });

  it('AC #5 containment: the bundle lives outside the workspace and the outbound guard refuses it', () => {
    const result = writeRepairBundle(input(), root, NOW);
    expect(resolve(result.path).startsWith(resolve(root))).toBe(true);
    expect(() => resolvePrivateWorkspaceFile(result.path)).toThrow(
      /private MAMA workspace|regular file/
    );
    expect(resolveRepairRoot({ MAMA_REPAIRS_DIR: '/tmp/x' } as NodeJS.ProcessEnv)).toBe('/tmp/x');
    expect(resolveRepairRoot({} as NodeJS.ProcessEnv).endsWith('/.mama/repairs')).toBe(true);
  });

  it('AC #6 source text: the module and the executor case never spawn, signal, or restart', () => {
    const module = readFileSync(
      resolve(__dirname, '../../src/operator/repair-request.ts'),
      'utf-8'
    );
    const executor = readFileSync(
      resolve(__dirname, '../../src/agent/gateway-tool-executor.ts'),
      'utf-8'
    );
    for (const forbidden of [
      'child_process',
      'process.kill',
      'launchctl',
      'systemctl',
      'execSync',
      'spawn(',
    ]) {
      expect(module).not.toContain(forbidden);
    }
    const start = executor.indexOf("case 'repair_request': {");
    const end = executor.indexOf("case 'file_export': {");
    expect(start).toBeGreaterThan(0);
    const caseText = executor.slice(start, end);
    for (const forbidden of [
      'child_process',
      'process.kill',
      'launchctl',
      'systemctl',
      'exec(',
      'spawn(',
      'writeFileSync',
    ]) {
      expect(caseText).not.toContain(forbidden);
    }
  });
});
