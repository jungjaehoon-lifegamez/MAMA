import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

import { describe, expect, it } from 'vitest';

const script = resolve(__dirname, '../../scripts/setup-ocr.js');

describe('setup-ocr script', () => {
  it('reports a missing isolated runtime without silently using system packages', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'mama-ocr-check-'));
    const result = spawnSync(process.execPath, [script, '--check'], {
      env: { ...process.env, MAMA_OCR_ENV: resolve(root, 'ocr-env') },
      encoding: 'utf8',
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('MAMA OCR runtime is not ready');
    expect(result.stderr).toContain('fonts-noto-cjk');
  });

  it('exposes pinned runtime requirements for reproducible setup', () => {
    const result = spawnSync(process.execPath, [script, '--print-requirements'], {
      encoding: 'utf8',
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('easyocr==1.7.2');
    expect(result.stdout).toContain('Pillow');
  });

  it('documents the host font dependency checked by the overlay runtime', () => {
    const result = spawnSync(process.execPath, [script, '--print-font-guidance'], {
      encoding: 'utf8',
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('fonts-noto-cjk');
    expect(result.stdout).toContain('MAMA_KOREAN_FONT');
  });
});
