/**
 * Response Validator - Flattery Detection & Response Quality Enforcement
 *
 * Detects and rejects agent responses containing excessive flattery,
 * self-congratulation, status filler, and unnecessary confirmation.
 * Supports both Korean and English pattern detection.
 *
 * @module enforcement/response-validator
 * @see docs/spike-prep-enforcement-layer-2026-02-08.md
 */

/**
 * Result of validating a response
 */
export interface ValidationResult {
  valid: boolean;
  reason?: string;
  matched?: string[];
  flatteryRatio?: number;
}

/**
 * Configuration for the ResponseValidator
 */
export interface ResponseValidatorConfig {
  /** Whether validation is enabled */
  enabled: boolean;
  /** Flattery ratio threshold (0.0–1.0). Default: 0.2 (20%) */
  flatteryThreshold: number;
  /** Maximum retries for rejected responses. Default: 3 */
  maxRetries: number;
  /** Strict mode for agent-to-agent communication. Default: true */
  strictMode: boolean;
  /** Distinct pattern count that triggers rejection regardless of ratio. Default: 5 */
  patternCountThreshold: number;
}

/**
 * A single flattery pattern with its category and regex
 */
interface FlatPattern {
  regex: RegExp;
  category: FlatCategory;
  label: string;
}

/**
 * Flattery pattern categories
 */
type FlatCategory =
  | 'direct_praise'
  | 'self_congratulation'
  | 'status_filler'
  | 'unnecessary_confirmation';

// ---------------------------------------------------------------------------
// Pattern Definitions (26 Korean + 24 English = 50 total)
// ---------------------------------------------------------------------------

const KOREAN_PATTERNS: FlatPattern[] = [
  // Direct Praise (10)
  { regex: /완벽합니다/g, category: 'direct_praise', label: '완벽합니다' },
  { regex: /훌륭합니다/g, category: 'direct_praise', label: '훌륭합니다' },
  { regex: /인상적입니다/g, category: 'direct_praise', label: '인상적입니다' },
  { regex: /놀라운/g, category: 'direct_praise', label: '놀라운' },
  { regex: /뛰어난/g, category: 'direct_praise', label: '뛰어난' },
  { regex: /감동적/g, category: 'direct_praise', label: '감동적' },
  { regex: /환상적/g, category: 'direct_praise', label: '환상적' },
  { regex: /탁월한/g, category: 'direct_praise', label: '탁월한' },
  { regex: /우아한/g, category: 'direct_praise', label: '우아한' },
  { regex: /최고의/g, category: 'direct_praise', label: '최고의' },

  // Self-Congratulation (8)
  { regex: /엔터프라이즈급/g, category: 'self_congratulation', label: '엔터프라이즈급' },
  { regex: /프로덕션\s*레디/g, category: 'self_congratulation', label: '프로덕션 레디' },
  { regex: /세계\s*최고/g, category: 'self_congratulation', label: '세계 최고' },
  { regex: /역사에\s*기록될/g, category: 'self_congratulation', label: '역사에 기록될' },
  { regex: /프로페셔널/g, category: 'self_congratulation', label: '프로페셔널' },
  { regex: /마스터피스/g, category: 'self_congratulation', label: '마스터피스' },
  { regex: /레전더리/g, category: 'self_congratulation', label: '레전더리' },
  { regex: /아름다운\s*코드/g, category: 'self_congratulation', label: '아름다운 코드' },

  // Status Filler (5)
  { regex: /깔끔한\s*구현/g, category: 'status_filler', label: '깔끔한 구현' },
  { regex: /완벽한\s*설계/g, category: 'status_filler', label: '완벽한 설계' },
  { regex: /최고의\s*품질/g, category: 'status_filler', label: '최고의 품질' },
  { regex: /우아한\s*솔루션/g, category: 'status_filler', label: '우아한 솔루션' },
  { regex: /완벽하게\s*작동/g, category: 'status_filler', label: '완벽하게 작동' },

  // Unnecessary Confirmation (3)
  { regex: /물론입니다/g, category: 'unnecessary_confirmation', label: '물론입니다' },
  { regex: /당연히/g, category: 'unnecessary_confirmation', label: '당연히' },
  { regex: /확실히/g, category: 'unnecessary_confirmation', label: '확실히' },
];

const ENGLISH_PATTERNS: FlatPattern[] = [
  // Direct Praise (10)
  { regex: /\bperfect\b/gi, category: 'direct_praise', label: 'perfect' },
  { regex: /\bexcellent\b/gi, category: 'direct_praise', label: 'excellent' },
  { regex: /\bimpressive\b/gi, category: 'direct_praise', label: 'impressive' },
  { regex: /\bwonderful\b/gi, category: 'direct_praise', label: 'wonderful' },
  { regex: /\bfantastic\b/gi, category: 'direct_praise', label: 'fantastic' },
  { regex: /\bbrilliant\b/gi, category: 'direct_praise', label: 'brilliant' },
  { regex: /\boutstanding\b/gi, category: 'direct_praise', label: 'outstanding' },
  { regex: /\bexceptional\b/gi, category: 'direct_praise', label: 'exceptional' },
  { regex: /\bremarkable\b/gi, category: 'direct_praise', label: 'remarkable' },
  { regex: /\bsuperb\b/gi, category: 'direct_praise', label: 'superb' },

  // Self-Congratulation (8)
  { regex: /enterprise-grade/gi, category: 'self_congratulation', label: 'enterprise-grade' },
  { regex: /production-ready/gi, category: 'self_congratulation', label: 'production-ready' },
  { regex: /world-class/gi, category: 'self_congratulation', label: 'world-class' },
  { regex: /\blegendary\b/gi, category: 'self_congratulation', label: 'legendary' },
  { regex: /\bmasterpiece\b/gi, category: 'self_congratulation', label: 'masterpiece' },
  { regex: /beautiful\s+code/gi, category: 'self_congratulation', label: 'beautiful code' },
  { regex: /\bstunning\b/gi, category: 'self_congratulation', label: 'stunning' },
  { regex: /\bmagnificent\b/gi, category: 'self_congratulation', label: 'magnificent' },

  // Status Filler (4)
  { regex: /elegant\s+solution/gi, category: 'status_filler', label: 'elegant solution' },
  { regex: /clean\s+implementation/gi, category: 'status_filler', label: 'clean implementation' },
  { regex: /great\s+question/gi, category: 'status_filler', label: 'great question' },
  { regex: /really\s+good/gi, category: 'status_filler', label: 'really good' },

  // Unnecessary Confirmation (2)
  { regex: /of\s+course/gi, category: 'unnecessary_confirmation', label: 'of course' },
  { regex: /\babsolutely\b/gi, category: 'unnecessary_confirmation', label: 'absolutely' },
];

const ALL_PATTERNS: FlatPattern[] = [...KOREAN_PATTERNS, ...ENGLISH_PATTERNS];

// ---------------------------------------------------------------------------
// Code Block Stripping
// ---------------------------------------------------------------------------

/**
 * Strip fenced code blocks (```...```) from text so their content
 * is not scanned for flattery patterns.
 */
function stripCodeBlocks(text: string): string {
  return text.replace(/```[\s\S]*?```/g, '');
}

/**
 * Strip inline code spans (`...`) from text so their content
 * is not scanned for flattery patterns.
 */
function stripInlineCode(text: string): string {
  return text.replace(/`[^`]+`/g, '');
}

/**
 * Prepare text for pattern matching by removing code blocks and inline code.
 */
function prepareText(text: string): string {
  return stripInlineCode(stripCodeBlocks(text));
}

// ---------------------------------------------------------------------------
// ResponseValidator
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG: ResponseValidatorConfig = {
  enabled: true,
  flatteryThreshold: 0.2,
  maxRetries: 3,
  strictMode: true,
  patternCountThreshold: 5,
};

/**
 * Validates agent responses for excessive flattery and empty praise.
 *
 * In agent-to-agent (strict) mode, responses exceeding the flattery
 * threshold are rejected. In human-facing (lenient) mode, a higher
 * effective threshold (2× configured) is used, allowing more praise
 * before rejection.
 *
 * @example
 * ```typescript
 * const validator = new ResponseValidator({ flatteryThreshold: 0.2 });
 * const result = validator.validate(agentResponse, true);
 * if (!result.valid) {
 *   // re-prompt agent with result.reason
 * }
 * ```
 */
export class ResponseValidator {
  private readonly config: ResponseValidatorConfig;

  constructor(config?: Partial<ResponseValidatorConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Validate a response string.
   *
   * @param response - The full response text to validate
   * @param isAgentToAgent - Whether this is agent-to-agent communication (strict mode)
   * @returns ValidationResult with pass/fail, reason, matched patterns, and ratio
   */
  validate(response: string, isAgentToAgent: boolean): ValidationResult {
    if (!this.config.enabled) {
      return { valid: true };
    }

    if (response.trim().length === 0) {
      return { valid: true, flatteryRatio: 0, matched: [] };
    }

    const matched = this.detectFlattery(response);
    const ratio = this.getFlatteryRatio(response);

    // Agent-to-agent uses configured threshold; human-facing uses 2× threshold
    const effectiveThreshold = isAgentToAgent
      ? this.config.flatteryThreshold
      : this.config.flatteryThreshold * 2;

    if (ratio > effectiveThreshold) {
      return {
        valid: false,
        reason: `Flattery ratio ${(ratio * 100).toFixed(1)}% exceeds ${(effectiveThreshold * 100).toFixed(1)}% threshold. Matched: ${matched.join(', ')}`,
        matched,
        flatteryRatio: ratio,
      };
    }

    // Secondary check: reject if too many distinct flattery patterns are matched,
    // even when the ratio is below threshold (catches verbose English self-congratulation
    // where long filler text dilutes the character ratio).
    const effectiveCountThreshold = isAgentToAgent
      ? this.config.patternCountThreshold
      : this.config.patternCountThreshold * 2;

    if (matched.length >= effectiveCountThreshold) {
      return {
        valid: false,
        reason: `${matched.length} distinct flattery patterns detected (threshold: ${effectiveCountThreshold}). Matched: ${matched.join(', ')}`,
        matched,
        flatteryRatio: ratio,
      };
    }

    return { valid: true, matched, flatteryRatio: ratio };
  }

  /**
   * Calculate the flattery ratio for a response.
   *
   * Ratio = (total matched characters) / (total non-code characters).
   * Code blocks and inline code are excluded from both numerator and denominator.
   *
   * @param response - The full response text
   * @returns A ratio between 0.0 and 1.0
   */
  getFlatteryRatio(response: string): number {
    const cleanText = prepareText(response);

    if (cleanText.trim().length === 0) {
      return 0;
    }

    const totalChars = cleanText.trim().length;
    let flatteryChars = 0;

    for (const pattern of ALL_PATTERNS) {
      // Create a fresh regex instance to reset lastIndex
      const fresh = new RegExp(pattern.regex.source, pattern.regex.flags);
      let match: RegExpExecArray | null;
      while ((match = fresh.exec(cleanText)) !== null) {
        flatteryChars += match[0].length;
      }
    }

    return Math.min(flatteryChars / totalChars, 1.0);
  }

  /**
   * Detect all flattery pattern labels present in a response.
   *
   * Code blocks and inline code are excluded before scanning.
   *
   * @param response - The full response text
   * @returns Array of matched pattern labels (deduplicated)
   */
  detectFlattery(response: string): string[] {
    const cleanText = prepareText(response);
    const matched: string[] = [];

    for (const pattern of ALL_PATTERNS) {
      const fresh = new RegExp(pattern.regex.source, pattern.regex.flags);
      if (fresh.test(cleanText)) {
        matched.push(pattern.label);
      }
    }

    // Deduplicate (in case compound patterns overlap with simple ones)
    return [...new Set(matched)];
  }
}
