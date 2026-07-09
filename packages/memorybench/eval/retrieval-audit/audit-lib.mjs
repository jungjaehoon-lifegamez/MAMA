// audit-lib.mjs - pure aggregate helpers for the e5 retrieval audit.
// No DB access, no model, no decision content. Numbers only.

export const VEC_BYTES = 4096; // 1024 float32

// Byte-safe: build a fresh 4096-byte ArrayBuffer at offset 0, then L2-normalize.
export function parseVec(buf) {
  if (!buf || buf.length !== VEC_BYTES) return null;
  const u = new Uint8Array(VEC_BYTES);
  u.set(buf);
  const f = new Float32Array(u.buffer);
  let n = 0;
  for (let i = 0; i < f.length; i++) n += f[i] * f[i];
  n = Math.sqrt(n);
  if (!(n > 0)) return null;
  const out = new Float32Array(f.length);
  for (let i = 0; i < f.length; i++) out[i] = f[i] / n;
  return out;
}

export function dot(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

export function statsOf(arr) {
  const a = arr.slice().sort((x, y) => x - y);
  const n = a.length || 1;
  const q = (p) => a[Math.min(a.length - 1, Math.max(0, Math.floor(p * (a.length - 1))))];
  const mean = a.reduce((s, x) => s + x, 0) / n;
  return {
    n: a.length,
    min: +(+q(0)).toFixed(4),
    p50: +(+q(0.5)).toFixed(4),
    mean: +mean.toFixed(4),
    p90: +(+q(0.9)).toFixed(4),
    max: +(+q(1)).toFixed(4),
    pct_gt_090: +(a.filter((x) => x > 0.9).length / n).toFixed(4),
    pct_gt_095: +(a.filter((x) => x > 0.95).length / n).toFixed(4),
  };
}

// items: [{ vec, dtext }]. Returns { top1, top1Distinct } arrays of best cosine.
export function computeTop1(items) {
  const top1 = [];
  const top1Distinct = [];
  for (let i = 0; i < items.length; i++) {
    let best = -1;
    let bestDistinct = -1;
    for (let j = 0; j < items.length; j++) {
      if (i === j) continue;
      const s = dot(items[i].vec, items[j].vec);
      if (s > best) best = s;
      if (s > bestDistinct && items[j].dtext !== items[i].dtext) bestDistinct = s;
    }
    top1.push(best);
    if (bestDistinct >= 0) top1Distinct.push(bestDistinct);
  }
  return { top1, top1Distinct };
}

// Temporal split leakage@K. items sorted by created_at ascending by caller.
// linkOf: Map(id -> Set(neighbourId)) lineage adjacency.
export function computeLeakage(itemsSortedByTime, linkOf, K = 5) {
  const cut = Math.floor(itemsSortedByTime.length * 0.8);
  const memory = itemsSortedByTime.slice(0, cut);
  const held = itemsSortedByTime.slice(cut);
  let leakExact = 0;
  let leakLineage = 0;
  let leakAny = 0;
  let leakHiCos = 0;
  for (const h of held) {
    const scored = memory
      .map((m) => ({ m, s: dot(h.vec, m.vec) }))
      .sort((a, b) => b.s - a.s)
      .slice(0, K);
    const nbrs = linkOf.get(h.id) || new Set();
    let ex = false;
    let lin = false;
    let hi = false;
    for (const { m, s } of scored) {
      if (m.dtext === h.dtext) ex = true;
      if (nbrs.has(m.id)) lin = true;
      if (s > 0.9) hi = true;
    }
    if (ex) leakExact++;
    if (lin) leakLineage++;
    if (ex || lin) leakAny++;
    if (hi) leakHiCos++;
  }
  const dz = held.length || 1;
  return {
    held_n: held.length,
    memory_n: memory.length,
    K,
    exact_dup_rate: +(leakExact / dz).toFixed(4),
    lineage_rate: +(leakLineage / dz).toFixed(4),
    any_leak_rate: +(leakAny / dz).toFixed(4),
    topk_hi_cos_rate: +(leakHiCos / dz).toFixed(4),
  };
}

// rows: [{ id, supersedes, superseded_by, refined_from }]; edges: [{ from_id, to_id }]
export function buildLineage(rows, edges) {
  const linkOf = new Map();
  const link = (a, b) => {
    if (!a || !b) return;
    if (!linkOf.has(a)) linkOf.set(a, new Set());
    linkOf.get(a).add(b);
  };
  for (const r of rows) {
    for (const nb of [r.supersedes, r.superseded_by, r.refined_from]) {
      link(r.id, nb);
      link(nb, r.id);
    }
  }
  for (const e of edges) {
    link(e.from_id, e.to_id);
    link(e.to_id, e.from_id);
  }
  return linkOf;
}
