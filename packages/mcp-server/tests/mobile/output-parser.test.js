/**
 * @fileoverview Tests for OutputParser class
 * @module tests/mobile/output-parser.test
 */

import { describe, it, expect, beforeEach } from 'vitest';

const { OutputParser, ANSI_REGEX } = await import('../../src/mobile/output-parser.js');

describe('OutputParser', () => {
  let parser;

  beforeEach(() => {
    parser = new OutputParser();
  });

  describe('constructor', () => {
    it('should initialize with empty buffer', () => {
      expect(parser.buffer).toBe('');
      expect(parser.lastToolDetected).toBeNull();
    });
  });

  describe('parse()', () => {
    it('should return stream event for plain text', () => {
      const events = parser.parse('Hello, World!\n');

      expect(events).toContainEqual({
        type: 'stream',
        text: 'Hello, World!\n',
      });
    });

    it('should handle Buffer input', () => {
      const events = parser.parse(Buffer.from('Test buffer\n'));

      expect(events).toContainEqual({
        type: 'stream',
        text: 'Test buffer\n',
      });
    });

    it('should strip ANSI escape codes', () => {
      const events = parser.parse('\x1b[32mColored\x1b[0m text\n');

      expect(events).toContainEqual({
        type: 'stream',
        text: 'Colored text\n',
      });
    });
  });

  describe('detectToolUse()', () => {
    it('should detect "Tool: Read" pattern', () => {
      const events = parser.parse('Tool: Read /path/to/file\n');

      expect(events).toContainEqual(
        expect.objectContaining({
          type: 'tool_use',
          tool: 'Read',
          status: 'started',
        })
      );
    });

    it('should detect "Using X tool" pattern', () => {
      const events = parser.parse('Using Write tool to save file\n');

      expect(events).toContainEqual(
        expect.objectContaining({
          type: 'tool_use',
          tool: 'Write',
          status: 'started',
        })
      );
    });

    it('should detect "Calling X" pattern', () => {
      const events = parser.parse('Calling Bash to execute command\n');

      expect(events).toContainEqual(
        expect.objectContaining({
          type: 'tool_use',
          tool: 'Bash',
          status: 'started',
        })
      );
    });

    it('should return null for no tool pattern', () => {
      const result = parser.detectToolUse('Just some regular text');
      expect(result).toBeNull();
    });
  });

  describe('detectComplete()', () => {
    it('should detect ">" prompt', () => {
      expect(parser.detectComplete('>\n')).toBe(true);
    });

    it('should detect "$" shell prompt', () => {
      expect(parser.detectComplete('$\n')).toBe(true);
    });

    it('should detect "claude>" prompt', () => {
      expect(parser.detectComplete('claude>\n')).toBe(true);
    });

    it('should detect multiple empty lines', () => {
      expect(parser.detectComplete('text\n\n\n')).toBe(true);
    });

    it('should return false for regular text', () => {
      expect(parser.detectComplete('Just some text')).toBe(false);
    });
  });

  describe('detectError()', () => {
    it('should detect "Error:" pattern', () => {
      const result = parser.detectError('Error: Something went wrong');
      expect(result).toBe('Something went wrong');
    });

    it('should detect "ERROR:" pattern', () => {
      const result = parser.detectError('ERROR: Critical failure');
      expect(result).toBe('Critical failure');
    });

    it('should detect "Failed:" pattern', () => {
      const result = parser.detectError('Failed: Operation failed');
      expect(result).toBe('Operation failed');
    });

    it('should detect "Exception:" pattern', () => {
      const result = parser.detectError('Exception: Null pointer');
      expect(result).toBe('Null pointer');
    });

    it('should return null for no error', () => {
      const result = parser.detectError('Normal output');
      expect(result).toBeNull();
    });
  });

  describe('buffer management', () => {
    it('should clear buffer when line ends with newline', () => {
      parser.parse('Complete line\n');
      expect(parser.buffer).toBe('');
    });

    it('should keep incomplete line in buffer', () => {
      parser.parse('Incomplete');
      expect(parser.buffer).toBe('Incomplete');
    });

    it('should handle partial lines across multiple parses', () => {
      parser.parse('First ');
      expect(parser.buffer).toBe('First ');

      const events = parser.parse('Second\n');
      expect(parser.buffer).toBe('');
      expect(events).toContainEqual({
        type: 'stream',
        text: 'Second\n',
      });
    });

    it('should keep only last incomplete line', () => {
      parser.parse('Line 1\nLine 2\nIncomplete');
      expect(parser.buffer).toBe('Incomplete');
    });
  });

  describe('flush()', () => {
    it('should return remaining buffer content', () => {
      parser.parse('Remaining content');
      const events = parser.flush();

      expect(events).toContainEqual({
        type: 'stream',
        text: 'Remaining content',
      });
    });

    it('should clear buffer after flush', () => {
      parser.parse('Some content');
      parser.flush();
      expect(parser.buffer).toBe('');
    });

    it('should return empty array if buffer is empty', () => {
      const events = parser.flush();
      expect(events).toHaveLength(0);
    });

    it('should reset lastToolDetected', () => {
      parser.lastToolDetected = 'Read';
      parser.flush();
      expect(parser.lastToolDetected).toBeNull();
    });
  });

  describe('reset()', () => {
    it('should clear buffer and lastToolDetected', () => {
      parser.buffer = 'Some content';
      parser.lastToolDetected = 'Write';

      parser.reset();

      expect(parser.buffer).toBe('');
      expect(parser.lastToolDetected).toBeNull();
    });
  });

  describe('stripAnsi()', () => {
    it('should remove color codes', () => {
      expect(parser.stripAnsi('\x1b[32mGreen\x1b[0m')).toBe('Green');
    });

    it('should remove bold codes', () => {
      expect(parser.stripAnsi('\x1b[1mBold\x1b[0m')).toBe('Bold');
    });

    it('should preserve non-ANSI text', () => {
      expect(parser.stripAnsi('Plain text')).toBe('Plain text');
    });

    it('should handle multiple ANSI codes', () => {
      expect(parser.stripAnsi('\x1b[1;31;40mStyled\x1b[0m')).toBe('Styled');
    });
  });

  describe('integration scenarios', () => {
    it('should handle typical Claude output stream', () => {
      const chunks = [
        'I will help you with that.\n',
        'Tool: Read /src/index.js\n',
        'Reading file contents...\n',
        '✓ Read completed\n',
        '>\n',
      ];

      const allEvents = [];
      for (const chunk of chunks) {
        allEvents.push(...parser.parse(chunk));
      }

      const types = allEvents.map((e) => e.type);
      expect(types).toContain('stream');
      expect(types).toContain('tool_use');
      expect(types).toContain('complete');
    });

    it('should handle error in output', () => {
      const events = parser.parse('Error: File not found\n');

      expect(events).toContainEqual(
        expect.objectContaining({
          type: 'error',
          message: 'File not found',
        })
      );
    });
  });
});

describe('ANSI_REGEX', () => {
  it('should match standard color codes', () => {
    expect('\x1b[32m'.match(ANSI_REGEX)).not.toBeNull();
    expect('\x1b[0m'.match(ANSI_REGEX)).not.toBeNull();
  });

  it('should match complex codes', () => {
    expect('\x1b[1;31;40m'.match(ANSI_REGEX)).not.toBeNull();
  });
});
