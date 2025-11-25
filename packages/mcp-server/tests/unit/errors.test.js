/**
 * Tests for MAMA Error Classes
 *
 * Story 8.3: Typed Error Classes
 */

import { describe, it, expect } from 'vitest';

import {
  MAMAError,
  NotFoundError,
  ValidationError,
  DatabaseError,
  EmbeddingError,
  ConfigurationError,
  LinkError,
  RateLimitError,
  TimeoutError,
  ErrorCodes,
  wrapError,
  isMAMAError,
} from '../../src/mama/errors.js';

describe('Story 8.3: Typed Error Classes', () => {
  describe('MAMAError (base class)', () => {
    it('should create error with message, code, and details', () => {
      const error = new MAMAError('Test error', 'TEST_ERROR', { key: 'value' });

      expect(error.message).toBe('Test error');
      expect(error.code).toBe('TEST_ERROR');
      expect(error.details).toEqual({ key: 'value' });
      expect(error.name).toBe('MAMAError');
      expect(error.timestamp).toBeDefined();
    });

    it('should convert to MCP response format', () => {
      const error = new MAMAError('Test error', 'TEST_ERROR', { foo: 'bar' });
      const response = error.toResponse();

      expect(response).toEqual({
        error: {
          code: 'TEST_ERROR',
          message: 'Test error',
          details: { foo: 'bar' },
        },
      });
    });

    it('should convert to JSON for logging', () => {
      const error = new MAMAError('Test error', 'TEST_ERROR');
      const json = error.toJSON();

      expect(json.name).toBe('MAMAError');
      expect(json.code).toBe('TEST_ERROR');
      expect(json.message).toBe('Test error');
      expect(json.timestamp).toBeDefined();
      expect(json.stack).toBeDefined();
    });

    it('should be an instance of Error', () => {
      const error = new MAMAError('Test');
      expect(error instanceof Error).toBe(true);
      expect(error instanceof MAMAError).toBe(true);
    });
  });

  describe('NotFoundError', () => {
    it('should create error for missing decision', () => {
      const error = new NotFoundError('decision', 'decision_abc123');

      expect(error.name).toBe('NotFoundError');
      expect(error.code).toBe('DECISION_NOT_FOUND');
      expect(error.message).toBe('decision not found: decision_abc123');
      expect(error.details.resourceType).toBe('decision');
      expect(error.details.identifier).toBe('decision_abc123');
    });

    it('should create error for missing checkpoint', () => {
      const error = new NotFoundError('checkpoint', 'chkpt_xyz');

      expect(error.code).toBe('CHECKPOINT_NOT_FOUND');
      expect(error.message).toBe('checkpoint not found: chkpt_xyz');
    });
  });

  describe('ValidationError', () => {
    it('should create error for invalid field', () => {
      const error = new ValidationError('topic', 'must be non-empty string', '');

      expect(error.name).toBe('ValidationError');
      expect(error.code).toBe('INVALID_INPUT');
      expect(error.field).toBe('topic');
      expect(error.message).toContain('topic');
      expect(error.details.received).toBe('');
    });

    it('should truncate long received values', () => {
      const longValue = 'x'.repeat(200);
      const error = new ValidationError('field', 'too long', longValue);

      expect(error.details.received.length).toBeLessThanOrEqual(100);
    });
  });

  describe('DatabaseError', () => {
    it('should create error for failed operation', () => {
      const error = new DatabaseError('insert', 'unique constraint violated', {
        table: 'decisions',
      });

      expect(error.name).toBe('DatabaseError');
      expect(error.code).toBe('DATABASE_ERROR');
      expect(error.operation).toBe('insert');
      expect(error.details.table).toBe('decisions');
    });
  });

  describe('EmbeddingError', () => {
    it('should create error for embedding failure', () => {
      const error = new EmbeddingError('model not loaded', { model: 'all-MiniLM-L6-v2' });

      expect(error.name).toBe('EmbeddingError');
      expect(error.code).toBe('EMBEDDING_ERROR');
      expect(error.details.model).toBe('all-MiniLM-L6-v2');
    });
  });

  describe('ConfigurationError', () => {
    it('should create error for config issue', () => {
      const error = new ConfigurationError('MAMA_DB_PATH', 'invalid path format');

      expect(error.name).toBe('ConfigurationError');
      expect(error.code).toBe('CONFIG_ERROR');
      expect(error.configKey).toBe('MAMA_DB_PATH');
    });
  });

  describe('LinkError', () => {
    it('should create error for link operation failure', () => {
      const error = new LinkError('approve', 'link not found', {
        from_id: 'a',
        to_id: 'b',
      });

      expect(error.name).toBe('LinkError');
      expect(error.code).toBe('LINK_ERROR');
      expect(error.operation).toBe('approve');
      expect(error.details.from_id).toBe('a');
    });
  });

  describe('RateLimitError', () => {
    it('should create error with retry time', () => {
      const error = new RateLimitError('vectorSearch', 1000);

      expect(error.name).toBe('RateLimitError');
      expect(error.code).toBe('RATE_LIMITED');
      expect(error.retryAfterMs).toBe(1000);
      expect(error.message).toContain('1000ms');
    });
  });

  describe('TimeoutError', () => {
    it('should create error with timeout duration', () => {
      const error = new TimeoutError('embedding', 5000);

      expect(error.name).toBe('TimeoutError');
      expect(error.code).toBe('TIMEOUT');
      expect(error.timeoutMs).toBe(5000);
      expect(error.message).toContain('5000ms');
    });
  });

  describe('ErrorCodes', () => {
    it('should have all standard error codes', () => {
      expect(ErrorCodes.DECISION_NOT_FOUND).toBe('DECISION_NOT_FOUND');
      expect(ErrorCodes.INVALID_INPUT).toBe('INVALID_INPUT');
      expect(ErrorCodes.DATABASE_ERROR).toBe('DATABASE_ERROR');
      expect(ErrorCodes.EMBEDDING_ERROR).toBe('EMBEDDING_ERROR');
      expect(ErrorCodes.RATE_LIMITED).toBe('RATE_LIMITED');
      expect(ErrorCodes.TIMEOUT).toBe('TIMEOUT');
    });
  });

  describe('wrapError', () => {
    it('should return MAMA error unchanged', () => {
      const original = new NotFoundError('decision', 'abc');
      const wrapped = wrapError(original, 'context');

      expect(wrapped).toBe(original);
    });

    it('should wrap regular Error', () => {
      const original = new Error('Something failed');
      const wrapped = wrapError(original, 'Database query');

      expect(wrapped instanceof MAMAError).toBe(true);
      expect(wrapped.code).toBe('INTERNAL_ERROR');
      expect(wrapped.message).toContain('Database query');
      expect(wrapped.details.originalError).toBe('Something failed');
    });

    it('should wrap string error', () => {
      const wrapped = wrapError('Simple error string', 'Operation');

      expect(wrapped instanceof MAMAError).toBe(true);
      expect(wrapped.message).toContain('Simple error string');
    });
  });

  describe('isMAMAError', () => {
    it('should return true for MAMA errors', () => {
      expect(isMAMAError(new MAMAError('test'))).toBe(true);
      expect(isMAMAError(new NotFoundError('decision', 'id'))).toBe(true);
      expect(isMAMAError(new ValidationError('field', 'msg'))).toBe(true);
    });

    it('should return false for non-MAMA errors', () => {
      expect(isMAMAError(new Error('test'))).toBe(false);
      expect(isMAMAError('string')).toBe(false);
      expect(isMAMAError(null)).toBe(false);
    });
  });
});
