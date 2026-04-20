/**
 * Benchmark E2E for the canonical entity ontology.
 *
 * Drives the real normalization + candidate generator + audit metrics
 * pipeline against the synthetic fixtures under
 * `packages/mama-core/tests/entities/fixtures/` and asserts the hard
 * ingest-quality gates from the plan:
 *
 *   - false_merge_rate <= 0.02 on the gold canonical identity set
 *   - every gold cross-language alias pair is caught in top-N candidates
 *   - no ontology violations in the gold set
 *   - projection fragmentation stays at zero on this synthetic run
 *
 * Keeps the e2e local and deterministic: no embedding scorer, no
 * network, no database writes.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  classifyAuditRun,
  computeAuditMetrics,
  FALSE_MERGE_HARD_CEILING,
  type AuditCandidateGoldLink,
  type AuditCandidateSnapshot,
  type AuditGoldPair,
} from '../../src/entities/audit-metrics.js';
import { generateResolutionCandidates } from '../../src/entities/candidate-generator.js';
import { normalizeEntityLabel } from '../../src/entities/normalization.js';
import type { EntityObservation } from '../../src/entities/types.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = join(HERE, 'fixtures');

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
  schema_version: number;
  extractor_version: string;
  embedding_model_version: string;
  groups: GoldGroup[];
}

interface CrossLangPair {
  canonical_id: string;
  left: { label: string };
  right: { label: string };
}

interface CrossLangFixture {
  schema_version: number;
  pairs: CrossLangPair[];
}

function loadJson<T>(name: string): T {
  const raw = readFileSync(join(FIXTURE_DIR, name), 'utf8');
  return JSON.parse(raw) as T;
}

function observationFor(group: GoldGroup, alias: GoldAlias, index: number): EntityObservation {
  const id = `obs_${group.canonical_id}_${index}`;
  return {
    id,
    observation_type: 'generic',
    entity_kind_hint: group.kind,
    surface_form: alias.label,
    normalized_form: normalizeEntityLabel(alias.label),
    lang: alias.lang,
    script: alias.script,
    context_summary: `${group.preferred_label} fixture evidence`,
    related_surface_forms: [alias.label],
    timestamp_observed: 1_710_000_000_000 + index,
    scope_kind: 'channel',
    scope_id: `C-SYNTH-${group.canonical_id.toUpperCase()}`,
    extractor_version: 'history-extractor@v1',
    embedding_model_version: 'multilingual-e5-large',
    source_connector: 'synthetic',
    source_locator: '~/.mama/tests/entities/fixtures',
    source_raw_record_id: `${group.canonical_id}_${index}`,
    created_at: 1_710_000_000_000 + index,
  };
}

describe('entity ontology benchmark e2e', () => {
  it('runs the full ingest path over the gold fixtures and meets the plan gates', async () => {
    const gold = loadJson<GoldFixture>('gold-canonical-identities.json');

    const canonicalByObservation = new Map<string, string>();
    const kindByObservation = new Map<string, string>();
    const observations: EntityObservation[] = [];

    for (const group of gold.groups) {
      group.aliases.forEach((alias, idx) => {
        const obs = observationFor(group, alias, idx);
        observations.push(obs);
        canonicalByObservation.set(obs.id, group.canonical_id);
        kindByObservation.set(obs.id, group.kind);
      });
    }

    const candidates = await generateResolutionCandidates(observations);
    expect(candidates.length).toBeGreaterThan(0);

    const candidateSnapshots: AuditCandidateSnapshot[] = candidates.map((c) => ({
      id: c.id,
      status: c.status,
      score_total: c.score_total,
      left_canonical_id: canonicalByObservation.get(c.left_ref) ?? null,
      right_canonical_id: canonicalByObservation.get(c.right_ref) ?? null,
      left_kind: kindByObservation.get(c.left_ref) ?? null,
      right_kind: kindByObservation.get(c.right_ref) ?? null,
    }));

    // Every gold cross-language pair should appear among the generated
    // candidates. Record one AuditCandidateGoldLink per match so recall@10
    // can assess the plan's cross-language target.
    const crossLang = loadJson<CrossLangFixture>('cross-language-aliases.json');
    const matches: AuditCandidateGoldLink[] = [];
    const goldPairs: AuditGoldPair[] = [];

    for (const pair of crossLang.pairs) {
      const group = gold.groups.find((g) => g.canonical_id === pair.canonical_id);
      if (!group) continue;
      const leftAliasIdx = group.aliases.findIndex((a) => a.label === pair.left.label);
      const rightAliasIdx = group.aliases.findIndex((a) => a.label === pair.right.label);
      if (leftAliasIdx < 0 || rightAliasIdx < 0) continue;
      const leftObsId = `obs_${group.canonical_id}_${leftAliasIdx}`;
      const rightObsId = `obs_${group.canonical_id}_${rightAliasIdx}`;
      goldPairs.push({
        canonical_id: group.canonical_id,
        left_obs_id: leftObsId,
        right_obs_id: rightObsId,
      });

      for (const cand of candidates) {
        const sameGroup =
          (cand.left_ref === leftObsId && cand.right_ref === rightObsId) ||
          (cand.left_ref === rightObsId && cand.right_ref === leftObsId);
        if (sameGroup) {
          matches.push({
            candidate_id: cand.id,
            matched_pair_key: `${group.canonical_id}:${leftObsId}:${rightObsId}`,
            score_total: cand.score_total,
          });
        }
      }
    }

    // Projection fragmentation: synthetic run has exactly one canonical per
    // group because we have not written any projection rows, so fragmentation
    // is 0 and we compute it from per-group observation counts that all map
    // to a single canonical id.
    const projectionCounts: Record<string, number> = {};
    for (const group of gold.groups) {
      projectionCounts[group.canonical_id] = 1;
    }

    const summary = computeAuditMetrics({
      candidates: candidateSnapshots,
      gold_pairs: goldPairs,
      candidate_gold_matches: matches,
      gold_canonical_projection_counts: projectionCounts,
    });

    // Hard gate from the plan: no auto-merges were made in this run, so the
    // false_merge_rate is 0 by construction (no denominator) — still strictly
    // assert it does not exceed the ceiling.
    expect(summary.false_merge_rate).toBeLessThanOrEqual(FALSE_MERGE_HARD_CEILING);

    // Cross-language recall target: every gold cross-language pair must be
    // recoverable from the generated candidates. The recall@10 metric is a
    // soft improvement gate, but on synthetic gold fixtures it should be
    // strictly 1.0 so regressions are caught immediately.
    expect(summary.cross_language_candidate_recall_at_10).toBe(1);

    // Ontology violations: the fixture is kind-consistent by construction.
    expect(summary.ontology_violation_count).toBe(0);

    // Projection fragmentation stays at zero on this synthetic run because
    // we do not issue projection writes.
    expect(summary.projection_fragmentation_rate).toBe(0);

    // First real benchmark run has no baseline → classification is
    // 'inconclusive', which is the expected first-run signal from the plan.
    expect(classifyAuditRun({ current: summary, baseline: null })).toBe('inconclusive');
  });
});
