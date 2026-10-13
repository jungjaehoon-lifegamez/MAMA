import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCommand } from '../../src/tools/command-runner.js';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

it('reports per-page embedded font names using metadata without extracting any font bytes', async () => {
  const output = mkdtempSync(join(tmpdir(), 'raster-fonts-'));
  roots.push(output);
  const script = `
import pathlib, runpy, sys, types
class Pixmap:
    def save(self, path): pathlib.Path(path).write_bytes(b"png")
class Page:
    rect = types.SimpleNamespace(width=100, height=100)
    def __init__(self, fonts): self.fonts = fonts
    def get_pixmap(self, **kwargs): return Pixmap()
    def get_fonts(self, full):
        assert full
        return self.fonts
class PDF:
    is_encrypted = False
    def __enter__(self): return self
    def __exit__(self, *args): pass
    def __len__(self): return 2
    def __iter__(self):
        return iter([
            Page([(1, "ttf", "TrueType", "Embedded-A", "F1", "", 0),
                  (2, "n/a", "Type1", "Not-Embedded", "F2", "", 0),
                  (3, "ttf", "TrueType", "Embedded-A", "F3", "", 0)]),
            Page([(4, "cff", "Type1", "Embedded-B", "F4", "", 0)])])
    def extract_font(self, xref):
        raise AssertionError("font bytes must never be extracted")
sys.modules["pymupdf"] = types.SimpleNamespace(open=lambda _: PDF(), Matrix=lambda *args: None)
script, output = sys.argv[1:]
sys.argv = [script, "unused.pdf", output, "50"]
runpy.run_path(script, run_name="__main__")
`;
  const result = await runCommand(
    '/usr/bin/python3',
    ['-I', '-c', script, join(__dirname, '../../toolkit/rasterize.py'), output],
    { timeoutMs: 5000 }
  );
  expect(JSON.parse(result.stdout)).toEqual({
    pageCount: 2,
    pages: ['page-001.png', 'page-002.png'],
    fonts: [['Embedded-A'], ['Embedded-B']],
  });
});
