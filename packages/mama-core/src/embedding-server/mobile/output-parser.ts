/**
 * @fileoverview Output Parser - parses Claude Code stdout into structured events
 * @module mobile/output-parser
 * @version 1.5.0
 *
 * Parses raw stdout from Claude Code CLI, identifying message types
 * such as stream content, tool usage, completion, and errors.
 *
 * @example
 * import { OutputParser } from './output-parser';
 * const parser = new OutputParser();
 * const events = parser.parse(chunk);
 * // events: [{ type: 'stream', text: '...' }, { type: 'tool_use', tool: 'Read' }]
 */

/**
 * Message types returned by the parser
 */
export type MessageType = 'stream' | 'tool_use' | 'tool_complete' | 'complete' | 'error';

/**
 * Parsed output event
 */
export interface ParsedEvent {
  type: MessageType;
  text?: string;
  tool?: string;
  status?: string;
  message?: string;
  args?: string | null;
}

/**
 * Tool detection result
 */
interface ToolDetectResult {
  tool: string;
  args: string | null;
}

/**
 * Tool detection patterns
 */
export const TOOL_PATTERNS: RegExp[] = [
  /Tool:\s*(\w+)/i,
  /Using\s+(\w+)\s+tool/i,
  /Calling\s+(\w+)/i,
  /⏺\s*(\w+)/, // Claude Code uses this indicator
  /\[(\w+)\]\s*Reading/i,
  /\[(\w+)\]\s*Writing/i,
  /\[(\w+)\]\s*Editing/i,
];

/**
 * Tool completion patterns
 */
const TOOL_COMPLETE_PATTERNS: RegExp[] = [
  /Tool\s+(\w+)\s+completed/i,
  /(\w+)\s+finished/i,
  /✓\s*(\w+)/,
];

/**
 * Error patterns
 */
export const ERROR_PATTERNS: RegExp[] = [
  /Error:\s*(.+)/i,
  /ERROR:\s*(.+)/i,
  /Failed:\s*(.+)/i,
  /Exception:\s*(.+)/i,
];

/**
 * Completion/prompt patterns
 */
export const COMPLETE_PATTERNS: RegExp[] = [
  /^>\s*$/m, // Simple prompt
  /^\$\s*$/m, // Shell prompt
  /^claude>\s*$/im, // Claude prompt
  /\n\n\n$/, // Multiple empty lines
];

/**
 * ANSI escape code regex pattern
 */
// eslint-disable-next-line no-control-regex
export const ANSI_REGEX: RegExp = /\x1b\[[0-9;]*m/g;

/**
 * OutputParser class - parses Claude Code stdout
 */
export class OutputParser {
  private buffer: string;
  private lastToolDetected: string | null;

  /**
   * Create a new OutputParser instance
   */
  constructor() {
    this.buffer = '';
    this.lastToolDetected = null;
  }

  /**
   * Parse a stdout chunk into events
   * @param chunk - Raw stdout data
   * @returns Array of parsed events
   */
  parse(chunk: string | Buffer): ParsedEvent[] {
    const text = typeof chunk === 'string' ? chunk : chunk.toString();
    const cleanText = this.stripAnsi(text);

    // Add to buffer for incomplete line handling
    this.buffer += cleanText;

    const events: ParsedEvent[] = [];

    // Check for errors first (highest priority)
    const errorResult = this.detectError(this.buffer);
    if (errorResult) {
      events.push({
        type: 'error',
        message: errorResult,
      });
      // Don't clear buffer entirely, might have more content
    }

    // Check for tool usage
    const toolResult = this.detectToolUse(this.buffer);
    if (toolResult) {
      events.push({
        type: 'tool_use',
        tool: toolResult.tool,
        status: 'started',
        args: toolResult.args || null,
      });
      this.lastToolDetected = toolResult.tool;
    }

    // Check for tool completion
    const toolComplete = this.detectToolComplete(this.buffer);
    if (toolComplete) {
      events.push({
        type: 'tool_complete',
        tool: toolComplete,
        status: 'completed',
      });
    }

    // Check for completion
    if (this.detectComplete(this.buffer)) {
      events.push({
        type: 'complete',
      });
    }

    // Always emit stream event with the text
    if (cleanText.trim()) {
      events.push({
        type: 'stream',
        text: cleanText,
      });
    }

    // Clear buffer if we have complete lines (ends with newline)
    if (this.buffer.endsWith('\n')) {
      this.buffer = '';
    } else {
      // Keep only the incomplete last line
      const lastNewline = this.buffer.lastIndexOf('\n');
      if (lastNewline !== -1) {
        this.buffer = this.buffer.substring(lastNewline + 1);
      }
    }

    return events;
  }

  /**
   * Remove ANSI escape codes from text
   * @param text - Text with potential ANSI codes
   * @returns Clean text
   */
  stripAnsi(text: string): string {
    return text.replace(ANSI_REGEX, '');
  }

  /**
   * Detect tool usage pattern in text
   * @param text - Text to analyze
   * @returns Tool info or null
   */
  detectToolUse(text: string): ToolDetectResult | null {
    for (const pattern of TOOL_PATTERNS) {
      const match = text.match(pattern);
      if (match) {
        const tool = match[1];
        // Try to extract args if present
        const argsMatch = text.match(new RegExp(`${tool}[:\\s]+(.+?)(?:\\n|$)`, 'i'));
        return {
          tool,
          args: argsMatch ? argsMatch[1].trim() : null,
        };
      }
    }
    return null;
  }

  /**
   * Detect tool completion pattern in text
   * @param text - Text to analyze
   * @returns Tool name or null
   */
  detectToolComplete(text: string): string | null {
    for (const pattern of TOOL_COMPLETE_PATTERNS) {
      const match = text.match(pattern);
      if (match) {
        return match[1];
      }
    }
    return null;
  }

  /**
   * Detect completion pattern in text
   * @param text - Text to analyze
   * @returns True if completion detected
   */
  detectComplete(text: string): boolean {
    for (const pattern of COMPLETE_PATTERNS) {
      if (pattern.test(text)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Detect error pattern in text
   * @param text - Text to analyze
   * @returns Error message or null
   */
  detectError(text: string): string | null {
    for (const pattern of ERROR_PATTERNS) {
      const match = text.match(pattern);
      if (match) {
        return match[1].trim();
      }
    }
    return null;
  }

  /**
   * Flush any remaining buffer content
   * @returns Remaining events
   */
  flush(): ParsedEvent[] {
    const events: ParsedEvent[] = [];
    if (this.buffer.trim()) {
      events.push({
        type: 'stream',
        text: this.buffer,
      });
    }
    this.buffer = '';
    this.lastToolDetected = null;
    return events;
  }

  /**
   * Reset the parser state
   */
  reset(): void {
    this.buffer = '';
    this.lastToolDetected = null;
  }

  /**
   * Get current buffer content
   * @returns Buffer content
   */
  getBuffer(): string {
    return this.buffer;
  }
}
