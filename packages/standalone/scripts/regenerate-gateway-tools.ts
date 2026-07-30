/**
 * Regenerate src/agent/gateway-tools.md from the ToolRegistry.
 *
 * The drift guard (tests/agent/gateway-tools-generation.test.ts) pins the
 * file's generated tool lines against ToolRegistry.generatePrompt(), but until
 * this script there was no sanctioned way to bring the file back in line - the
 * 2026-07-24 prettier corruption survived six days partly because "regenerate"
 * had no command. Run: npx tsx scripts/regenerate-gateway-tools.ts
 *
 * The file carries hand-written sections around the generated catalog: a HEAD
 * above the first category heading (the tool_call JSON invocation preamble -
 * without it the persona does not know how to call anything) and a TAIL below
 * the last generated tool line (cron surface bullets and similar). Only the
 * span between them is replaced.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ToolRegistry } from '../src/agent/tool-registry.js';

const here = dirname(fileURLToPath(import.meta.url));
const target = join(here, '../src/agent/gateway-tools.md');

const generated = ToolRegistry.generatePrompt();
const current = readFileSync(target, 'utf8');

const isToolLine = (line: string) => /^- \*\*[a-z][A-Za-z0-9_]*\*\*\(/.test(line.trim());

// Head: everything above the first category heading (title + hand-written
// invocation preamble). Tail: everything below the last generated tool line.
const lines = current.split('\n');
const firstCategoryIdx = lines.findIndex((l) => /^## /.test(l));
let lastToolIdx = -1;
lines.forEach((l, i) => {
  if (isToolLine(l)) lastToolIdx = i;
});
const head = firstCategoryIdx > 0 ? lines.slice(0, firstCategoryIdx).join('\n') + '\n' : '';
const tail = lastToolIdx >= 0 ? lines.slice(lastToolIdx + 1).join('\n') : '';

// generated starts with its own '# Gateway Tools' title; the preserved head
// (when present) already carries it, so drop the generated title line.
const generatedBody = head
  ? generated
      .split('\n')
      .slice(generated.startsWith('# ') ? 2 : 0, undefined)
      .join('\n')
  : generated;

writeFileSync(target, head + generatedBody + (tail ? '\n' + tail : '\n'));

const count = generated.split('\n').filter(isToolLine).length;
console.log(`regenerated: ${count} tool lines, tail preserved: ${tail.trim().length > 0}`);
