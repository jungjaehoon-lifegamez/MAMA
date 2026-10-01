/**
 * SessionStart, the plugin's one hook: the last checkpoint and the newest active decisions.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOOK = path.join(__dirname, '../../scripts/sessionstart-hook.js');
const MARKER = 'PROCESS_EXIT_CALLED';

let dir;
let dbPath;

function runHook() {
  const result = spawnSync(process.execPath, ['-r', path.join(dir, 'mark-exit.cjs'), HOOK], {
    input: '{}',
    encoding: 'utf8',
    timeout: 60_000,
    env: {
      ...process.env,
      HOME: dir,
      MAMA_DB_PATH: dbPath,
      CLAUDE_PLUGIN_DATA: '',
      MAMA_FORCE_TIER_3: 'true',
    },
  });
  const context = result.stdout
    ? JSON.parse(result.stdout).hookSpecificOutput.additionalContext
    : '';
  return { ...result, context };
}

// node:sqlite in a child: vitest's module loader does not resolve node:sqlite.
function seed(sql) {
  const result = spawnSync(
    process.execPath,
    [
      '-e',
      `const { DatabaseSync } = require('node:sqlite');
       new DatabaseSync(process.argv[1]).exec(process.argv[2]);`,
      dbPath,
      sql,
    ],
    { encoding: 'utf8' }
  );
  if (result.status !== 0) {
    throw new Error(result.stderr);
  }
}

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mama-sessionstart-'));
  dbPath = path.join(dir, 'memory.db');
  fs.writeFileSync(
    path.join(dir, 'mark-exit.cjs'),
    `const exit = process.exit;
process.exit = (code) => { process.stderr.write('${MARKER}\\n'); exit(code); };
`
  );
});

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('SessionStart hook', () => {
  it('opens the memory and ends on its own', () => {
    const result = runHook();
    expect(result.status).toBe(0);
    expect(result.stderr).not.toContain(MARKER);
    expect(result.context).toContain('MAMA memory');
    expect(result.context).toContain('/mama:search');
  });

  it('lists active decisions newest first, reading text timestamps as dates', () => {
    const now = Date.now();
    seed(`
      INSERT INTO decisions (id, topic, decision, created_at, updated_at, status, payload_json) VALUES
        ('d1', 'kept_older', 'Older active decision', ${now - 3 * 3_600_000}, ${now}, 'active', '{}'),
        ('d2', 'kept_newer', 'Newer active decision', ${now - 3_600_000}, ${now}, 'active', '{}'),
        ('d3', 'replaced_one', 'A replaced decision', ${now - 60_000}, ${now}, 'superseded', '{}'),
        ('d4', 'judgment/d1', 'Status applied to d1', ${now - 30_000}, ${now}, 'active',
         '{"amended":"d1","status":"stale"}'),
        ('d5', 'text_timestamp', 'Written with a text date', '2026-02-15 04:29:33', ${now},
         'active', '{}');
    `);
    const { status, context } = runHook();
    expect(status).toBe(0);
    expect(context).not.toContain('NaN');
    expect(context).not.toContain('replaced_one');
    expect(context).not.toContain('judgment/d1');
    const order = ['kept_newer', 'kept_older', 'text_timestamp'].map((topic) =>
      context.indexOf(topic)
    );
    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });
});
