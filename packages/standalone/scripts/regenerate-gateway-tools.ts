/**
 * Regenerate src/agent/gateway-tools.md from the ToolRegistry.
 *
 * The drift guard (tests/agent/gateway-tools-generation.test.ts) pins the
 * file's generated tool lines against ToolRegistry.generatePrompt(), but until
 * this script there was no sanctioned way to bring the file back in line - the
 * 2026-07-24 prettier corruption survived six days partly because "regenerate"
 * had no command. Run: npx tsx scripts/regenerate-gateway-tools.ts
 *
 * The file may carry hand-written sections BELOW the generated catalog (cron
 * surface bullets and similar). Everything from the start of the file through
 * the last generated tool line is replaced; anything after is preserved.
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

// Find the last generated-form tool line in the current file; everything after
// it is hand-written tail and survives the regeneration.
const lines = current.split('\n');
let lastToolIdx = -1;
lines.forEach((l, i) => {
  if (isToolLine(l)) lastToolIdx = i;
});
const tail = lastToolIdx >= 0 ? lines.slice(lastToolIdx + 1).join('\n') : '';

writeFileSync(target, generated + (tail ? '\n' + tail : '\n'));

const count = generated.split('\n').filter(isToolLine).length;
console.log(`regenerated: ${count} tool lines, tail preserved: ${tail.trim().length > 0}`);
