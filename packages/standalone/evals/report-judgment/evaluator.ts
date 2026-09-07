export type JudgmentDisposition =
  | 'confirmed'
  | 'unconfirmed'
  | 'unsupported'
  | 'completed'
  | 'agent_action'
  | 'owner_decision';

export interface EvidenceItem {
  ref: string;
  observedAt: string;
  period: string;
  coverage?: 'complete' | 'partial' | 'unavailable';
  text: string;
}

export interface ExpectedConclusion {
  label: string;
  disposition: JudgmentDisposition;
  period: string;
  requiredRefs: string[];
}

export interface JudgmentFixture {
  id: string;
  asOf: string;
  evidence: EvidenceItem[];
  expected: ExpectedConclusion[];
}

export interface ModelConclusion {
  label: string;
  disposition: JudgmentDisposition;
  period: string;
  evidenceRefs: string[];
  explanation: string;
}

export interface ModelJudgment {
  fixtureId: string;
  conclusions: ModelConclusion[];
  coverageGaps: string[];
  report: string;
}

export interface EvaluationIssue {
  code:
    | 'malformed_output'
    | 'fixture_mismatch'
    | 'missing_conclusion'
    | 'duplicate_conclusion'
    | 'unexpected_conclusion'
    | 'wrong_disposition'
    | 'wrong_period'
    | 'missing_required_ref'
    | 'unknown_evidence_ref'
    | 'future_evidence_ref';
  label?: string;
  detail: string;
}

export interface EvaluationResult {
  fixtureId: string;
  passed: boolean;
  issues: EvaluationIssue[];
  matchedConclusions: number;
  expectedConclusions: number;
}

const DISPOSITIONS = new Set<JudgmentDisposition>([
  'confirmed',
  'unconfirmed',
  'unsupported',
  'completed',
  'agent_action',
  'owner_decision',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

export function parseModelJudgment(raw: string): ModelJudgment {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  let parsed: unknown;
  try {
    parsed = JSON.parse(fenced?.[1] ?? trimmed);
  } catch (error: unknown) {
    throw new Error('Model judgment is not valid JSON', { cause: error });
  }
  if (
    !isRecord(parsed) ||
    typeof parsed.fixtureId !== 'string' ||
    !Array.isArray(parsed.conclusions) ||
    !strings(parsed.coverageGaps) ||
    typeof parsed.report !== 'string'
  ) {
    throw new Error('Model judgment does not match the required top-level shape');
  }
  const conclusions: ModelConclusion[] = parsed.conclusions.map((value, index) => {
    if (
      !isRecord(value) ||
      typeof value.label !== 'string' ||
      !DISPOSITIONS.has(value.disposition as JudgmentDisposition) ||
      typeof value.period !== 'string' ||
      !strings(value.evidenceRefs) ||
      typeof value.explanation !== 'string'
    ) {
      throw new Error(`Model judgment conclusion ${index} is malformed`);
    }
    return {
      label: value.label,
      disposition: value.disposition as JudgmentDisposition,
      period: value.period,
      evidenceRefs: value.evidenceRefs,
      explanation: value.explanation,
    };
  });
  return {
    fixtureId: parsed.fixtureId,
    conclusions,
    coverageGaps: parsed.coverageGaps,
    report: parsed.report,
  };
}

export function evaluateJudgment(
  fixture: JudgmentFixture,
  judgment: ModelJudgment
): EvaluationResult {
  const issues: EvaluationIssue[] = [];
  if (judgment.fixtureId !== fixture.id) {
    issues.push({
      code: 'fixture_mismatch',
      detail: `expected ${fixture.id}; received ${judgment.fixtureId}`,
    });
  }

  const evidence = new Map(fixture.evidence.map((item) => [item.ref, item]));
  const expected = new Map(fixture.expected.map((item) => [item.label, item]));
  const grouped = new Map<string, ModelConclusion[]>();
  for (const conclusion of judgment.conclusions) {
    const existing = grouped.get(conclusion.label) ?? [];
    existing.push(conclusion);
    grouped.set(conclusion.label, existing);
    if (!expected.has(conclusion.label)) {
      issues.push({
        code: 'unexpected_conclusion',
        label: conclusion.label,
        detail: 'conclusion was not part of the frozen material labels',
      });
    }
    for (const ref of conclusion.evidenceRefs) {
      const item = evidence.get(ref);
      if (!item) {
        issues.push({ code: 'unknown_evidence_ref', label: conclusion.label, detail: ref });
      } else if (Date.parse(item.observedAt) > Date.parse(fixture.asOf)) {
        issues.push({
          code: 'future_evidence_ref',
          label: conclusion.label,
          detail: `${ref} was observed after ${fixture.asOf}`,
        });
      }
    }
  }

  let matchedConclusions = 0;
  for (const item of fixture.expected) {
    const matches = grouped.get(item.label) ?? [];
    if (matches.length === 0) {
      issues.push({ code: 'missing_conclusion', label: item.label, detail: 'label was omitted' });
      continue;
    }
    if (matches.length > 1) {
      issues.push({
        code: 'duplicate_conclusion',
        label: item.label,
        detail: `received ${matches.length} entries`,
      });
      continue;
    }
    const actual = matches[0];
    let exact = true;
    if (actual.disposition !== item.disposition) {
      exact = false;
      issues.push({
        code: 'wrong_disposition',
        label: item.label,
        detail: `expected ${item.disposition}; received ${actual.disposition}`,
      });
    }
    if (actual.period !== item.period) {
      exact = false;
      issues.push({
        code: 'wrong_period',
        label: item.label,
        detail: `expected ${item.period}; received ${actual.period}`,
      });
    }
    for (const requiredRef of item.requiredRefs) {
      if (!actual.evidenceRefs.includes(requiredRef)) {
        exact = false;
        issues.push({
          code: 'missing_required_ref',
          label: item.label,
          detail: requiredRef,
        });
      }
    }
    if (exact) {
      matchedConclusions += 1;
    }
  }

  return {
    fixtureId: fixture.id,
    passed: issues.length === 0,
    issues,
    matchedConclusions,
    expectedConclusions: fixture.expected.length,
  };
}
