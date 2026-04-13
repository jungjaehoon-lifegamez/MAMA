import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as debugLogger from '@jungjaehoon/mama-core/debug-logger';
import type { EntityAuditQueueAdapter, EntityAuditRunQueue } from './entity-audit-queue.js';

// mama-core entity audit helpers are exported at runtime but not via stable TS
// subpath types yet; require + local interfaces keep standalone build green.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { classifyAuditRun, computeAuditMetrics } = require('@jungjaehoon/mama-core') as {
  classifyAuditRun: (input: {
    current: AuditMetricSummary;
    baseline: AuditMetricSummary | null;
  }) => 'improved' | 'stable' | 'regressed' | 'inconclusive';
  computeAuditMetrics: (snapshot: {
    candidates: AuditCandidateSnapshot[];
    gold_pairs: AuditGoldPair[];
    candidate_gold_matches: AuditCandidateGoldLink[];
    gold_canonical_projection_counts: Record<string, number>;
  }) => AuditMetricSummary;
};

const { DebugLogger } = debugLogger as unknown as {
  DebugLogger: new (context?: string) => {
    warn: (...args: unknown[]) => void;
    info: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
  };
};

const auditLogger = new DebugLogger('EntityAuditRunner');
const DEFAULT_FIXTURE_DIR = resolve(__dirname, '../../../mama-core/tests/entities/fixtures');

interface AuditCandidateSnapshot {
  id: string;
  status: 'pending' | 'auto_merged' | 'approved' | 'rejected' | 'deferred';
  score_total: number;
  left_canonical_id: string | null;
  right_canonical_id: string | null;
  left_kind: string | null;
  right_kind: string | null;
}

interface AuditGoldPair {
  canonical_id: string;
  left_obs_id: string;
  right_obs_id: string;
}

interface AuditCandidateGoldLink {
  candidate_id: string;
  matched_pair_key: string;
  score_total: number;
}

interface AuditMetricSummary {
  false_merge_rate: number;
  false_merge_numerator: number;
  false_merge_denominator: number;
  cross_language_candidate_recall_at_10: number;
  cross_language_recall_numerator: number;
  cross_language_recall_denominator: number;
  ontology_violation_count: number;
  projection_fragmentation_rate: number;
}

interface GoldAlias {
  label: string;
  lang: string;
  script: string;
}

interface GoldGroup {
  canonical_id: string;
  kind: 'project' | 'person' | 'organization' | 'work_item';
  preferred_label: string;
  aliases: GoldAlias[];
}

interface GoldFixture {
  groups: GoldGroup[];
}

interface CrossLangPair {
  canonical_id: string;
  left: { label: string; lang: string };
  right: { label: string; lang: string };
}

interface CrossLangFixture {
  pairs: CrossLangPair[];
}

interface RawCandidateRow {
  id: string;
  status: AuditCandidateSnapshot['status'];
  score_total: number;
  left_ref: string;
  right_ref: string;
}

interface ResolvedRefRow {
  id: string;
  label: string;
  kind: string | null;
}

export function resolveEntityAuditFixturesPath(fixturesPath?: string): string {
  const candidate =
    fixturesPath ?? process.env.MAMA_ENTITY_AUDIT_FIXTURES_PATH ?? DEFAULT_FIXTURE_DIR;
  if (!existsSync(candidate)) {
    throw new Error(`Entity audit fixtures path does not exist: ${candidate}`);
  }
  return candidate;
}

function loadJson<T>(fixturesPath: string, filename: string): T {
  return JSON.parse(readFileSync(resolve(fixturesPath, filename), 'utf8')) as T;
}

function normalizeAuditLabel(input: string): string {
  const collapsed = input.normalize('NFKC').trim().replace(/\s+/gu, ' ');
  const hasLatin = /\p{Script=Latin}/u.test(collapsed);
  return hasLatin ? collapsed.toLowerCase() : collapsed;
}

function loadBaseline(
  adapter: EntityAuditQueueAdapter,
  currentRunId: string
): AuditMetricSummary | null {
  const row = adapter
    .prepare(
      `
        SELECT metric_summary_json
        FROM entity_audit_runs
        WHERE id != ? AND status = 'complete' AND metric_summary_json IS NOT NULL
        ORDER BY created_at DESC
        LIMIT 1
      `
    )
    .get(currentRunId) as { metric_summary_json: string | null } | undefined;

  if (!row?.metric_summary_json) {
    return null;
  }

  return JSON.parse(row.metric_summary_json) as AuditMetricSummary;
}

function buildCanonicalLookup(
  gold: GoldFixture
): Map<string, { canonicalId: string; kind: string }> {
  const lookup = new Map<string, { canonicalId: string; kind: string }>();
  for (const group of gold.groups) {
    lookup.set(normalizeAuditLabel(group.preferred_label), {
      canonicalId: group.canonical_id,
      kind: group.kind,
    });
    for (const alias of group.aliases) {
      lookup.set(normalizeAuditLabel(alias.label), {
        canonicalId: group.canonical_id,
        kind: group.kind,
      });
    }
  }
  return lookup;
}

function resolveRef(adapter: EntityAuditQueueAdapter, refId: string): ResolvedRefRow {
  const obs = adapter
    .prepare(`SELECT id, surface_form, entity_kind_hint FROM entity_observations WHERE id = ?`)
    .get(refId) as
    | { id: string; surface_form: string; entity_kind_hint: string | null }
    | undefined;
  if (obs) {
    return { id: obs.id, label: obs.surface_form, kind: obs.entity_kind_hint };
  }

  const entity = adapter
    .prepare(`SELECT id, preferred_label, kind FROM entity_nodes WHERE id = ?`)
    .get(refId) as { id: string; preferred_label: string; kind: string } | undefined;
  if (entity) {
    return { id: entity.id, label: entity.preferred_label, kind: entity.kind };
  }

  return { id: refId, label: refId, kind: null };
}

function buildGoldPairs(crossLang: CrossLangFixture): AuditGoldPair[] {
  return crossLang.pairs.map((pair) => ({
    canonical_id: pair.canonical_id,
    left_obs_id: normalizeAuditLabel(pair.left.label),
    right_obs_id: normalizeAuditLabel(pair.right.label),
  }));
}

function buildCandidateSnapshots(
  adapter: EntityAuditQueueAdapter,
  canonicalLookup: Map<string, { canonicalId: string; kind: string }>
): {
  snapshots: AuditCandidateSnapshot[];
  candidateMatches: AuditCandidateGoldLink[];
} {
  const rows = adapter
    .prepare(
      `
        SELECT id, status, score_total, left_ref, right_ref
        FROM entity_resolution_candidates
        ORDER BY score_total DESC, id ASC
      `
    )
    .all() as RawCandidateRow[];

  const snapshots: AuditCandidateSnapshot[] = [];
  const candidateMatches: AuditCandidateGoldLink[] = [];

  for (const row of rows) {
    const left = resolveRef(adapter, row.left_ref);
    const right = resolveRef(adapter, row.right_ref);
    const leftCanonical = canonicalLookup.get(normalizeAuditLabel(left.label));
    const rightCanonical = canonicalLookup.get(normalizeAuditLabel(right.label));

    snapshots.push({
      id: row.id,
      status: row.status,
      score_total: row.score_total,
      left_canonical_id: leftCanonical?.canonicalId ?? null,
      right_canonical_id: rightCanonical?.canonicalId ?? null,
      left_kind: leftCanonical?.kind ?? left.kind,
      right_kind: rightCanonical?.kind ?? right.kind,
    });

    if (
      leftCanonical &&
      rightCanonical &&
      leftCanonical.canonicalId === rightCanonical.canonicalId &&
      left.label !== right.label
    ) {
      const normalizedLeft = normalizeAuditLabel(left.label);
      const normalizedRight = normalizeAuditLabel(right.label);
      const ordered =
        normalizedLeft.localeCompare(normalizedRight) <= 0
          ? [normalizedLeft, normalizedRight]
          : [normalizedRight, normalizedLeft];
      candidateMatches.push({
        candidate_id: row.id,
        matched_pair_key: `${leftCanonical.canonicalId}:${ordered[0]}:${ordered[1]}`,
        score_total: row.score_total,
      });
    }
  }

  return { snapshots, candidateMatches };
}

function buildProjectionCounts(
  adapter: EntityAuditQueueAdapter,
  canonicalLookup: Map<string, { canonicalId: string; kind: string }>
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const { canonicalId } of canonicalLookup.values()) {
    counts[canonicalId] = counts[canonicalId] ?? 0;
  }

  const rows = adapter
    .prepare(
      `SELECT preferred_label, status, merged_into FROM entity_nodes WHERE status = 'active'`
    )
    .all() as Array<{ preferred_label: string; status: string; merged_into: string | null }>;

  for (const row of rows) {
    if (row.merged_into) {
      continue;
    }
    const canonical = canonicalLookup.get(normalizeAuditLabel(row.preferred_label));
    if (!canonical) {
      continue;
    }
    counts[canonical.canonicalId] = (counts[canonical.canonicalId] ?? 0) + 1;
  }

  return counts;
}

function persistAuditDetails(
  adapter: EntityAuditQueueAdapter,
  runId: string,
  summary: AuditMetricSummary,
  classification: ReturnType<typeof classifyAuditRun>
): void {
  const metricRows = Object.entries(summary).map(([metricName, metricValue]) => ({
    metricName,
    metricValue,
  }));

  for (const metric of metricRows) {
    adapter
      .prepare(
        `
          INSERT OR REPLACE INTO entity_audit_metrics (run_id, metric_name, metric_value, metric_meta_json, created_at)
          VALUES (?, ?, ?, ?, ?)
        `
      )
      .run(runId, metric.metricName, Number(metric.metricValue), null, Date.now());
  }

  adapter.prepare(`DELETE FROM entity_audit_findings WHERE run_id = ?`).run(runId);

  if (classification === 'regressed') {
    adapter
      .prepare(
        `
          INSERT INTO entity_audit_findings (id, run_id, finding_kind, severity, summary, details_json, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `
      )
      .run(
        `finding_${runId}_false_merge`,
        runId,
        'false_merge_rate',
        'critical',
        'false_merge_rate exceeded the configured audit threshold',
        JSON.stringify({
          false_merge_rate: summary.false_merge_rate,
        }),
        Date.now()
      );
  }
}

export async function runEntityAuditInBackground(args: {
  queue: EntityAuditRunQueue;
  adapter: EntityAuditQueueAdapter;
  runId: string;
  fixturesPath?: string;
}): Promise<void> {
  try {
    const fixturesPath = resolveEntityAuditFixturesPath(args.fixturesPath);
    const gold = loadJson<GoldFixture>(fixturesPath, 'gold-canonical-identities.json');
    const crossLang = loadJson<CrossLangFixture>(fixturesPath, 'cross-language-aliases.json');
    const canonicalLookup = buildCanonicalLookup(gold);
    const goldPairs = buildGoldPairs(crossLang);
    const { snapshots, candidateMatches } = buildCandidateSnapshots(args.adapter, canonicalLookup);
    const projectionCounts = buildProjectionCounts(args.adapter, canonicalLookup);
    const summary = computeAuditMetrics({
      candidates: snapshots,
      gold_pairs: goldPairs,
      candidate_gold_matches: candidateMatches,
      gold_canonical_projection_counts: projectionCounts,
    });
    const baseline = loadBaseline(args.adapter, args.runId);
    const classification = classifyAuditRun({ current: summary, baseline });

    args.queue.complete(args.runId, {
      classification,
      metric_summary: summary,
    });
    persistAuditDetails(args.adapter, args.runId, summary, classification);
    auditLogger.info('[entity-audit] Completed background audit run', {
      runId: args.runId,
      classification,
      false_merge_rate: summary.false_merge_rate,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    args.queue.fail(args.runId, message);
    auditLogger.warn('[entity-audit] Failed background audit run', {
      runId: args.runId,
      error: message,
    });
  }
}
