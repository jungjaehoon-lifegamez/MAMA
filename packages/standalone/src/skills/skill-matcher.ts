/**
 * Skill Matcher
 *
 * Matches incoming messages to appropriate skills based on:
 * - Keywords in the message
 * - Regex patterns
 * - Required input types (attachments)
 */

import type { SkillDefinition, SkillMatch, SkillInput, SkillInputType } from './types.js';

/**
 * Get input type from content type
 */
function getInputType(contentType?: string): SkillInputType {
  if (!contentType) return 'document';

  if (contentType.startsWith('image/')) {
    return 'image';
  }

  // Common document types
  if (
    contentType.includes('spreadsheet') ||
    contentType.includes('excel') ||
    contentType.includes('csv') ||
    contentType.includes('pdf') ||
    contentType.includes('document') ||
    contentType.includes('text/') ||
    contentType.includes('json')
  ) {
    return 'document';
  }

  return 'document';
}

/**
 * Check if a skill's required inputs are satisfied
 */
function hasRequiredInputs(skill: SkillDefinition, input: SkillInput): boolean {
  const required = skill.trigger.requiredInputs;

  if (!required || required.length === 0) {
    return true; // No requirements
  }

  const attachments = input.attachments || [];

  for (const requiredType of required) {
    if (requiredType === 'any') {
      // Any attachment will do
      if (attachments.length === 0) return false;
    } else if (requiredType === 'text') {
      // Text is always present
      continue;
    } else {
      // Check for specific type
      const hasType = attachments.some((a) => {
        const inputType = getInputType(a.contentType);
        return inputType === requiredType;
      });
      if (!hasType) return false;
    }
  }

  return true;
}

/**
 * Check keyword match
 */
function matchKeywords(
  skill: SkillDefinition,
  text: string
): { matched: boolean; keyword?: string; confidence: number } {
  const keywords = skill.trigger.keywords;
  if (!keywords || keywords.length === 0) {
    return { matched: false, confidence: 0 };
  }

  const lowerText = text.toLowerCase();

  for (const keyword of keywords) {
    const lowerKeyword = keyword.toLowerCase();
    if (lowerText.includes(lowerKeyword)) {
      // Calculate confidence based on keyword position and length
      const index = lowerText.indexOf(lowerKeyword);
      const positionBonus = index === 0 ? 0.1 : 0;
      const lengthRatio = keyword.length / text.length;
      const confidence = Math.min(0.7 + positionBonus + lengthRatio * 0.2, 1.0);

      return { matched: true, keyword, confidence };
    }
  }

  return { matched: false, confidence: 0 };
}

/**
 * Check pattern match
 */
function matchPatterns(
  skill: SkillDefinition,
  text: string
): { matched: boolean; pattern?: string; confidence: number } {
  const patterns = skill.trigger.patterns;
  if (!patterns || patterns.length === 0) {
    return { matched: false, confidence: 0 };
  }

  for (const pattern of patterns) {
    try {
      const regex = new RegExp(pattern, 'i');
      if (regex.test(text)) {
        return { matched: true, pattern, confidence: 0.8 };
      }
    } catch {
      console.warn(`[SkillMatcher] Invalid pattern: ${pattern}`);
    }
  }

  return { matched: false, confidence: 0 };
}

/**
 * Match a single skill against input
 */
function matchSkill(skill: SkillDefinition, input: SkillInput): SkillMatch | null {
  // Check required inputs first
  if (!hasRequiredInputs(skill, input)) {
    return null;
  }

  // Try keyword match
  const keywordResult = matchKeywords(skill, input.text);
  if (keywordResult.matched) {
    return {
      skill,
      confidence: keywordResult.confidence,
      matchType: 'keyword',
      matchedValue: keywordResult.keyword,
    };
  }

  // Try pattern match
  const patternResult = matchPatterns(skill, input.text);
  if (patternResult.matched) {
    return {
      skill,
      confidence: patternResult.confidence,
      matchType: 'pattern',
      matchedValue: patternResult.pattern,
    };
  }

  // Check if skill matches purely based on input type
  const required = skill.trigger.requiredInputs;
  if (required && required.length > 0 && input.attachments?.length) {
    // Has required inputs and attachments - partial match
    return {
      skill,
      confidence: 0.5,
      matchType: 'input_type',
      matchedValue: required.join(', '),
    };
  }

  return null;
}

/**
 * Skill Matcher class
 */
export class SkillMatcher {
  private skills: SkillDefinition[] = [];

  /**
   * Set skills to match against
   */
  setSkills(skills: SkillDefinition[]): void {
    this.skills = skills;
  }

  /**
   * Find matching skills for an input
   * Returns matches sorted by confidence (highest first)
   */
  match(input: SkillInput): SkillMatch[] {
    const matches: SkillMatch[] = [];

    for (const skill of this.skills) {
      const match = matchSkill(skill, input);
      if (match) {
        matches.push(match);
      }
    }

    // Sort by confidence
    matches.sort((a, b) => b.confidence - a.confidence);

    return matches;
  }

  /**
   * Find the best matching skill
   */
  findBest(input: SkillInput): SkillMatch | null {
    const matches = this.match(input);
    return matches.length > 0 ? matches[0] : null;
  }

  /**
   * Check if any skill matches
   */
  hasMatch(input: SkillInput): boolean {
    return this.match(input).length > 0;
  }
}
