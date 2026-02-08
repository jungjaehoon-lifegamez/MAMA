/**
 * ReviewGate - Evidence-based APPROVE enforcement
 *
 * @module enforcement/review-gate
 * @see docs/spike-prep-enforcement-layer-2026-02-08.md (Test Cases 5, 6)
 */

export interface ReviewResult {
  approved: boolean;
  hasEvidence: boolean;
  evidenceFound: string[];
  reason?: string;
}

export interface ReviewGateConfig {
  enabled: boolean;
  /** @default true */
  requireEvidence: boolean;
}

/** Approval keywords: APPROVE/APPROVED, LGTM, looks good, 승인, 통과, 합격 */
const APPROVAL_PATTERNS: RegExp[] = [
  /\bAPPROVE\b/i,
  /\bAPPROVED\b/i,
  /\bLGTM\b/i,
  /\blooks\s+good\b/i,
  /승인/,
  /통과/,
  /합격/,
];

/** Evidence regex → human-readable label (deduplicated via Set in extractEvidence) */
const EVIDENCE_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /tests?\s+pass(?:ing|ed)?/i, label: 'test pass' },
  { pattern: /\d+\/\d+\s+(?:pass|passing|passed)/i, label: 'test count' },
  { pattern: /\d+\s+tests?\s+pass(?:ing|ed)?/i, label: 'test count' },
  { pattern: /\d+\/\d+/i, label: 'test count' },
  { pattern: /build\s+succeed(?:ed)?/i, label: 'build succeed' },
  { pattern: /build\s+success/i, label: 'build success' },
  { pattern: /typecheck\s+pass(?:ing|ed)?/i, label: 'typecheck pass' },
  { pattern: /typecheck\s+clean/i, label: 'typecheck clean' },
  { pattern: /typescript\s+compiles?/i, label: 'typecheck pass' },
  { pattern: /0\s+errors?/i, label: '0 errors' },
  { pattern: /\bverified\b/i, label: 'verified' },
  { pattern: /\bchecked\b/i, label: 'checked' },
  { pattern: /\bconfirmed\b/i, label: 'confirmed' },
  { pattern: /reviewed?\s+(?:code|changes|files?)/i, label: 'reviewed code' },
  { pattern: /files?\s+reviewed/i, label: 'reviewed code' },
  { pattern: /\bgit\s+diff\b/i, label: 'git diff' },
  { pattern: /lint\s+pass(?:ing|ed)?/i, label: 'lint pass' },
  { pattern: /lint:\s*0\s+errors?/i, label: 'lint clean' },
  { pattern: /no\s+lint\s+errors?/i, label: 'lint clean' },
];

const DEFAULT_CONFIG: ReviewGateConfig = {
  enabled: true,
  requireEvidence: true,
};

/**
 * Enforces evidence-based APPROVE verdicts.
 * Non-approval responses pass through. Approval without evidence → REJECT.
 */
export class ReviewGate {
  private readonly config: ReviewGateConfig;

  constructor(config?: Partial<ReviewGateConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Main gate: passthrough for non-approval, require evidence for approval.
   * @param response - Full review response text
   */
  checkApproval(response: string): ReviewResult {
    if (!this.config.enabled) {
      return { approved: true, hasEvidence: false, evidenceFound: [], reason: 'Gate disabled' };
    }

    const isApproval = this.containsApproval(response);

    if (!isApproval) {
      return { approved: true, hasEvidence: false, evidenceFound: [] };
    }

    const evidenceFound = this.extractEvidence(response);
    const hasEvidence = evidenceFound.length > 0;

    if (this.config.requireEvidence && !hasEvidence) {
      return {
        approved: false,
        hasEvidence: false,
        evidenceFound: [],
        reason:
          'APPROVE verdict requires evidence (test results, build status, typecheck, files reviewed). Flattery does not substitute for evidence.',
      };
    }

    return { approved: true, hasEvidence, evidenceFound };
  }

  containsApproval(response: string): boolean {
    return APPROVAL_PATTERNS.some((pattern) => pattern.test(response));
  }

  extractEvidence(response: string): string[] {
    const found = new Set<string>();

    for (const { pattern, label } of EVIDENCE_PATTERNS) {
      if (pattern.test(response)) {
        found.add(label);
      }
    }

    return [...found];
  }
}
