import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseVec, dot, statsOf, computeTop1, computeLeakage, buildLineage, VEC_BYTES } from './audit-lib.mjs';

test('parseVec rejects wrong-size buffers', () => {
  assert.equal(parseVec(Buffer.alloc(10)), null);
  assert.equal(parseVec(null), null);
});

test('parseVec normalizes a 4096-byte float32 buffer to unit length', () => {
  const f = new Float32Array(1024);
  f[0] = 3;
  f[1] = 4; // norm 5
  const v = parseVec(Buffer.from(f.buffer));
  assert.equal(v.length, 1024);
  assert.ok(Math.abs(dot(v, v) - 1) < 1e-6);
});

test('dot of orthogonal unit vectors is 0, identical is 1', () => {
  const a = new Float32Array(4); a[0] = 1;
  const b = new Float32Array(4); b[1] = 1;
  assert.ok(Math.abs(dot(a, b)) < 1e-9);
  assert.ok(Math.abs(dot(a, a) - 1) < 1e-9);
});

test('statsOf reports mean and >0.90 fraction', () => {
  const s = statsOf([0.8, 0.95, 0.99, 0.7]);
  assert.equal(s.n, 4);
  assert.equal(s.pct_gt_090, 0.5);
  assert.ok(s.min <= s.p50 && s.p50 <= s.max);
});

test('computeTop1 isolates distinct-text nearest neighbour', () => {
  const e = (i) => { const v = new Float32Array(4); v[i] = 1; return v; };
  const items = [
    { vec: e(0), dtext: 'A' },
    { vec: e(0), dtext: 'A' }, // duplicate text of item 0
    { vec: e(1), dtext: 'B' },
  ];
  const { top1, top1Distinct } = computeTop1(items);
  assert.equal(top1.length, 3);
  // item 0 best overall = its duplicate (cos 1); best distinct-text = B (cos 0)
  assert.ok(Math.abs(top1[0] - 1) < 1e-9);
  assert.ok(Math.abs(top1Distinct[0] - 0) < 1e-9);
});

test('buildLineage + computeLeakage flag a retrieved lineage relative', () => {
  const e = (i) => { const v = new Float32Array(4); v[i % 4] = 1; return v; };
  const rows = [
    { id: 'old', supersedes: null, superseded_by: 'new', refined_from: null },
    { id: 'new', supersedes: 'old', superseded_by: null, refined_from: null },
  ];
  const linkOf = buildLineage(rows, []);
  const items = [
    { id: 'old', vec: e(0), dtext: 'x', created_at: 1 },
    { id: 'new', vec: e(0), dtext: 'y', created_at: 2 }, // held (last 20%)
  ];
  const sorted = items.sort((a, b) => a.created_at - b.created_at);
  const leak = computeLeakage(sorted, linkOf, 1);
  assert.equal(leak.lineage_rate, 1);
});

test('VEC_BYTES is 4096', () => {
  assert.equal(VEC_BYTES, 4096);
});
