#!/usr/bin/env node

const { existsSync, mkdirSync } = require('node:fs');
const { homedir } = require('node:os');
const { dirname, join, resolve } = require('node:path');
const { spawnSync } = require('node:child_process');

const REQUIREMENTS = ['easyocr==1.7.2', 'Pillow>=10,<13', 'numpy>=1.26,<3'];
const FONT_GUIDANCE =
  'Install a Korean/CJK font (Ubuntu/Debian: apt install fonts-noto-cjk) or set ' +
  'MAMA_KOREAN_FONT to a readable .ttf/.ttc font file.';
const RUNTIME_CHECK = String.raw`
import os
from pathlib import Path
import easyocr, PIL, numpy
from PIL import ImageFont

candidates = [
    os.environ.get("MAMA_KOREAN_FONT"),
    "/System/Library/Fonts/AppleSDGothicNeo.ttc",
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc",
]
for candidate in candidates:
    if not candidate or not Path(candidate).is_file():
        continue
    try:
        font = ImageFont.truetype(candidate, 18)
        if font.getbbox("한글"):
            print(easyocr.__version__)
            raise SystemExit(0)
    except OSError:
        pass
raise SystemExit("Korean/CJK font is unavailable")
`;

function runtimeRoot() {
  return resolve(process.env.MAMA_OCR_ENV || join(homedir(), '.mama', 'ocr-env'));
}

function runtimePython(root) {
  return process.platform === 'win32'
    ? join(root, 'Scripts', 'python.exe')
    : join(root, 'bin', 'python3');
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    encoding: 'utf8',
    env: process.env,
  });
  if (result.error || result.status !== 0) {
    const detail = result.error?.message || result.stderr?.trim() || `exit ${result.status}`;
    throw new Error(`${command} ${args.join(' ')} failed: ${detail}`);
  }
  return result.stdout || '';
}

function check() {
  const python = runtimePython(runtimeRoot());
  if (!existsSync(python)) {
    return false;
  }
  try {
    run(python, ['-c', RUNTIME_CHECK], { capture: true });
    return true;
  } catch {
    return false;
  }
}

function setup() {
  const root = runtimeRoot();
  const bootstrapPython = process.env.MAMA_OCR_BOOTSTRAP_PYTHON || 'python3';
  mkdirSync(dirname(root), { recursive: true, mode: 0o700 });
  if (!existsSync(runtimePython(root))) {
    run(bootstrapPython, ['-m', 'venv', root]);
  }
  const python = runtimePython(root);
  run(python, ['-m', 'pip', 'install', '--upgrade', 'pip']);
  run(python, ['-m', 'pip', 'install', ...REQUIREMENTS]);
  if (!check()) {
    throw new Error(`MAMA OCR runtime failed its dependency/font check. ${FONT_GUIDANCE}`);
  }
  process.stdout.write(`MAMA OCR runtime ready: ${python}\n`);
}

function main() {
  const command = process.argv[2];
  if (command === '--print-requirements') {
    process.stdout.write(`${REQUIREMENTS.join('\n')}\n`);
    return;
  }
  if (command === '--print-font-guidance') {
    process.stdout.write(`${FONT_GUIDANCE}\n`);
    return;
  }
  if (command === '--check') {
    if (check()) {
      process.stdout.write(`MAMA OCR runtime ready: ${runtimePython(runtimeRoot())}\n`);
      return;
    }
    process.stderr.write(
      `MAMA OCR runtime is not ready at ${runtimeRoot()}. Run: pnpm setup:ocr\n${FONT_GUIDANCE}\n`
    );
    process.exitCode = 1;
    return;
  }
  setup();
}

try {
  main();
} catch (error) {
  process.stderr.write(
    `MAMA OCR setup failed: ${error instanceof Error ? error.message : error}\n`
  );
  process.exitCode = 1;
}
