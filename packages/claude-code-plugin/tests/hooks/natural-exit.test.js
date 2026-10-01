/**
 * Hooks end on their own instead of calling process.exit().
 *
 * Once the embedding model has loaded, onnxruntime-node 1.21 aborts in its exit-time teardown
 * on macOS when process.exit() is called (exit 134, microsoft/onnxruntime#24579): SessionStart
 * and PreCompact lose their output and PreToolUse loses the exit 2 that carries related
 * decisions. Any path of these hooks may run after the model loads, so none may call it.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'path';
import os from 'os';
import fs from 'fs';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPTS = path.join(__dirname, '../../scripts');
const MARKER = 'PROCESS_EXIT_CALLED';

let dir;
let preload;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mama-natural-exit-'));
  preload = path.join(dir, 'mark-process-exit.cjs');
  fs.writeFileSync(
    preload,
    `const exit = process.exit;
process.exit = (code) => {
  process.stderr.write('${MARKER}\\n');
  exit(code);
};
`
  );
});

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function run(script, stdin, env = {}) {
  return new Promise((resolve) => {
    const child = spawn('node', ['-r', preload, path.join(SCRIPTS, script)], {
      env: { ...process.env, SESSION_DIR: dir, MAMA_FORCE_TIER_3: 'true', ...env },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (data) => (stdout += data));
    child.stderr.on('data', (data) => (stderr += data));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(stdin);
  });
}

describe('hooks end without process.exit()', () => {
  it('PreToolUse', async () => {
    const result = await run(
      'pretooluse-hook.js',
      JSON.stringify({ tool_name: 'Grep', tool_input: { pattern: 'x' } })
    );
    expect(result.stderr).not.toContain(MARKER);
    expect(result.code).toBe(0);
    expect(result.stderr).toContain('allow');
  });

  it('PreCompact', async () => {
    const transcript = path.join(dir, 'transcript.jsonl');
    fs.writeFileSync(transcript, `${JSON.stringify({ content: 'no candidates here' })}\n`);
    const result = await run('precompact-hook.js', JSON.stringify({ transcript_path: transcript }));
    expect(result.stderr).not.toContain(MARKER);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).systemMessage).toContain('Compaction Summary');
  });

  it('SessionStart', async () => {
    const result = await run('sessionstart-hook.js', '{}', {
      MAMA_WARM_STATUS: 'ready',
      MAMA_SESSION_START: String(Date.now()),
    });
    expect(result.stderr).not.toContain(MARKER);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Session resumed');
  });
});
