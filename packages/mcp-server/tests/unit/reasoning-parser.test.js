/**
 * Story 2.2: Reasoning Field Parsing Tests
 *
 * Tests for parseReasoningForRelationships function
 */

import { describe, it, expect } from 'vitest';
import {
  parseReasoningForRelationships,
  VALID_EDGE_TYPES,
} from '../../src/mama/decision-tracker.js';

describe('Story 2.2: Reasoning Field Parsing', () => {
  describe('VALID_EDGE_TYPES constant', () => {
    it('should include original edge types', () => {
      expect(VALID_EDGE_TYPES).toContain('supersedes');
      expect(VALID_EDGE_TYPES).toContain('refines');
      expect(VALID_EDGE_TYPES).toContain('contradicts');
    });

    it('should include v1.3 extended edge types', () => {
      expect(VALID_EDGE_TYPES).toContain('builds_on');
      expect(VALID_EDGE_TYPES).toContain('debates');
      expect(VALID_EDGE_TYPES).toContain('synthesizes');
    });
  });

  describe('parseReasoningForRelationships', () => {
    it('should return empty array for null/undefined reasoning', () => {
      expect(parseReasoningForRelationships(null)).toEqual([]);
      expect(parseReasoningForRelationships(undefined)).toEqual([]);
      expect(parseReasoningForRelationships('')).toEqual([]);
    });

    it('should return empty array for reasoning without references', () => {
      const reasoning = 'This is a regular reasoning without any decision references.';
      expect(parseReasoningForRelationships(reasoning)).toEqual([]);
    });

    it('should detect builds_on: pattern', () => {
      const reasoning = 'This decision builds_on: decision_auth_strategy_123_abc';
      const result = parseReasoningForRelationships(reasoning);

      expect(result).toHaveLength(1);
      expect(result[0].type).toBe('builds_on');
      expect(result[0].targetIds).toEqual(['decision_auth_strategy_123_abc']);
    });

    it('should detect debates: pattern', () => {
      const reasoning = 'This decision debates: decision_old_approach_456_def because...';
      const result = parseReasoningForRelationships(reasoning);

      expect(result).toHaveLength(1);
      expect(result[0].type).toBe('debates');
      expect(result[0].targetIds).toEqual(['decision_old_approach_456_def']);
    });

    it('should detect synthesizes: pattern with single ID', () => {
      const reasoning = 'synthesizes: decision_first_789_ghi';
      const result = parseReasoningForRelationships(reasoning);

      expect(result).toHaveLength(1);
      expect(result[0].type).toBe('synthesizes');
      expect(result[0].targetIds).toContain('decision_first_789_ghi');
    });

    it('should detect synthesizes: pattern with multiple IDs', () => {
      const reasoning =
        'This synthesizes: decision_first_111_aaa, decision_second_222_bbb from previous work';
      const result = parseReasoningForRelationships(reasoning);

      expect(result).toHaveLength(1);
      expect(result[0].type).toBe('synthesizes');
      expect(result[0].targetIds).toContain('decision_first_111_aaa');
      expect(result[0].targetIds).toContain('decision_second_222_bbb');
    });

    it('should detect synthesizes: pattern with bracket notation', () => {
      const reasoning =
        'synthesizes: [decision_a_123_xxx, decision_b_456_yyy] combining both approaches';
      const result = parseReasoningForRelationships(reasoning);

      expect(result).toHaveLength(1);
      expect(result[0].type).toBe('synthesizes');
      expect(result[0].targetIds).toHaveLength(2);
    });

    it('should detect multiple different relationship types', () => {
      const reasoning = `
        This decision builds_on: decision_base_111_aaa
        but also debates: decision_alternative_222_bbb
      `;
      const result = parseReasoningForRelationships(reasoning);

      expect(result).toHaveLength(2);
      expect(result.find((r) => r.type === 'builds_on')).toBeDefined();
      expect(result.find((r) => r.type === 'debates')).toBeDefined();
    });

    it('should be case-insensitive for relationship keywords', () => {
      const reasoning = 'BUILDS_ON: decision_test_123_abc';
      const result = parseReasoningForRelationships(reasoning);

      expect(result).toHaveLength(1);
      expect(result[0].type).toBe('builds_on');
    });
  });
});
