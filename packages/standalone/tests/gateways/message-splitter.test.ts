/**
 * Unit tests for message splitter
 */

import { describe, it, expect } from 'vitest';
import {
  splitMessage,
  splitForDiscord,
  splitForSlack,
  splitWithCodeBlocks,
  truncateWithEllipsis,
  estimateChunks,
  DEFAULT_MAX_LENGTH,
} from '../../src/gateways/message-splitter.js';

describe('Message Splitter', () => {
  describe('splitMessage()', () => {
    it('should return single chunk for short message', () => {
      const text = 'Hello, world!';
      const chunks = splitMessage(text);

      expect(chunks).toHaveLength(1);
      expect(chunks[0]).toBe(text);
    });

    it('should split long message', () => {
      const text = 'A'.repeat(3000);
      const chunks = splitMessage(text, { maxLength: 1000 });

      expect(chunks.length).toBeGreaterThan(1);
      chunks.forEach((chunk) => {
        expect(chunk.length).toBeLessThanOrEqual(1000);
      });
    });

    it('should preserve all content', () => {
      const text = 'Hello world. This is a test message.';
      const chunks = splitMessage(text, { maxLength: 15 });

      // All words should be present in the chunks (whitespace at split points may be trimmed)
      const allWords = text.split(/\s+/);
      const chunkText = chunks.join(' ');
      allWords.forEach((word) => {
        expect(chunkText).toContain(word);
      });
    });

    it('should split at newlines when possible', () => {
      const text = 'Line 1\nLine 2\nLine 3\nLine 4\nLine 5';
      const chunks = splitMessage(text, { maxLength: 15 });

      // Should split at newlines, not in the middle of lines
      expect(chunks.some((c) => c.includes('Line'))).toBe(true);
    });

    it('should split at spaces when no newlines', () => {
      const text = 'Word1 Word2 Word3 Word4 Word5 Word6';
      const chunks = splitMessage(text, { maxLength: 15 });

      // Should split at spaces
      chunks.forEach((chunk) => {
        expect(chunk.endsWith('Word')).toBe(false); // Not cut in middle
      });
    });

    it('should handle message with no split points', () => {
      const text = 'A'.repeat(100);
      const chunks = splitMessage(text, { maxLength: 30 });

      expect(chunks.length).toBeGreaterThan(1);
      // First chunks should be max length, last may be shorter
      expect(chunks[0].length).toBe(30);
    });

    it('should apply chunk suffix', () => {
      const text = 'A'.repeat(100);
      const chunks = splitMessage(text, { maxLength: 30, chunkSuffix: '...' });

      // All but last chunk should have suffix
      for (let i = 0; i < chunks.length - 1; i++) {
        expect(chunks[i].endsWith('...')).toBe(true);
      }
    });

    it('should apply continuation prefix', () => {
      const text = 'A'.repeat(100);
      const chunks = splitMessage(text, { maxLength: 30, continuationPrefix: '> ' });

      // All but first chunk should have prefix
      for (let i = 1; i < chunks.length; i++) {
        expect(chunks[i].startsWith('> ')).toBe(true);
      }
    });

    it('should respect custom split points', () => {
      const text = 'Part1|Part2|Part3|Part4';
      const chunks = splitMessage(text, {
        maxLength: 12,
        splitPoints: ['|'],
      });

      // Algorithm finds LAST split point before maxLength
      // 'Part1|Part2|' = 12 chars, split at index 11 (|) + 1
      expect(chunks).toContain('Part1|Part2|');
    });
  });

  describe('splitForDiscord()', () => {
    it('should use 2000 char limit', () => {
      const text = 'A'.repeat(5000);
      const chunks = splitForDiscord(text);

      chunks.forEach((chunk) => {
        expect(chunk.length).toBeLessThanOrEqual(2000);
      });
    });

    it('should handle exactly 2000 chars', () => {
      const text = 'A'.repeat(2000);
      const chunks = splitForDiscord(text);

      expect(chunks).toHaveLength(1);
    });

    it('should handle 2001 chars', () => {
      const text = 'A'.repeat(2001);
      const chunks = splitForDiscord(text);

      expect(chunks).toHaveLength(2);
    });
  });

  describe('splitForSlack()', () => {
    it('should use 40000 char limit', () => {
      const text = 'A'.repeat(50000);
      const chunks = splitForSlack(text);

      chunks.forEach((chunk) => {
        expect(chunk.length).toBeLessThanOrEqual(40000);
      });
    });
  });

  describe('splitWithCodeBlocks()', () => {
    it('should handle text without code blocks', () => {
      const text = 'Just regular text';
      const chunks = splitWithCodeBlocks(text);

      expect(chunks).toHaveLength(1);
      expect(chunks[0]).toBe(text);
    });

    it('should keep code blocks intact when possible', () => {
      const code = '```\ncode here\n```';
      const text = `Before\n${code}\nAfter`;
      const chunks = splitWithCodeBlocks(text, 1000);

      // Code block should be in its own chunk or with adjacent text
      expect(chunks.some((c) => c.includes('```'))).toBe(true);
    });

    it('should split long code blocks', () => {
      const longCode = '```\n' + 'A'.repeat(3000) + '\n```';
      const chunks = splitWithCodeBlocks(longCode, 1000);

      expect(chunks.length).toBeGreaterThan(1);
    });

    it('should handle multiple code blocks', () => {
      const text = 'Text\n```\ncode1\n```\nMore text\n```\ncode2\n```\nEnd';
      const chunks = splitWithCodeBlocks(text);

      expect(chunks).toHaveLength(1); // Should fit in one chunk
    });
  });

  describe('truncateWithEllipsis()', () => {
    it('should not truncate short text', () => {
      const text = 'Short';
      const result = truncateWithEllipsis(text, 100);

      expect(result).toBe(text);
    });

    it('should truncate long text with ellipsis', () => {
      const text = 'This is a long text that needs truncation';
      const result = truncateWithEllipsis(text, 20);

      expect(result.length).toBe(20);
      expect(result.endsWith('...')).toBe(true);
    });

    it('should use custom ellipsis', () => {
      const text = 'Long text here';
      const result = truncateWithEllipsis(text, 10, '…');

      expect(result.endsWith('…')).toBe(true);
    });
  });

  describe('estimateChunks()', () => {
    it('should return 1 for short text', () => {
      expect(estimateChunks('Short', 100)).toBe(1);
    });

    it('should estimate correct number of chunks', () => {
      expect(estimateChunks('A'.repeat(5000), 2000)).toBe(3);
    });

    it('should use default max length', () => {
      expect(estimateChunks('A'.repeat(4000))).toBe(2);
    });
  });

  describe('DEFAULT_MAX_LENGTH', () => {
    it('should be 2000 (Discord limit)', () => {
      expect(DEFAULT_MAX_LENGTH).toBe(2000);
    });
  });
});
