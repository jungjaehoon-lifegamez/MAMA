/**
 * @fileoverview Output Parser - parses Claude Code stdout into structured events
 * @module mobile/output-parser
 * @version 1.5.0
 *
 * Parses raw stdout from Claude Code CLI, identifying message types
 * such as stream content, tool usage, completion, and errors.
 *
 * @example
 * const { OutputParser } = require('./output-parser');
 * const parser = new OutputParser();
 * const events = parser.parse(chunk);
 * // events: [{ type: 'stream', text: '...' }, { type: 'tool_use', tool: 'Read' }]
 */

/**
 * Message types returned by the parser
 * @typedef {'stream'|'tool_use'|'tool_complete'|'complete'|'error'} MessageType
 */

/**
 * Parsed output event
 * @typedef {Object} ParsedEvent
 * @property {MessageType} type - Event type
 * @property {string} [text] - Text content (for stream type)
 * @property {string} [tool] - Tool name (for tool_use type)
 * @property {string} [status] - Tool status (started/completed)
 * @property {string} [message] - Error message (for error type)
 */

/**
 * Tool detection patterns
 * @type {RegExp[]}
 */
const TOOL_PATTERNS = [
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
 * @type {RegExp[]}
 */
const TOOL_COMPLETE_PATTERNS = [/Tool\s+(\w+)\s+completed/i, /(\w+)\s+finished/i, /✓\s*(\w+)/];

/**
 * Error patterns
 * @type {RegExp[]}
 */
const ERROR_PATTERNS = [
  /Error:\s*(.+)/i,
  /ERROR:\s*(.+)/i,
  /Failed:\s*(.+)/i,
  /Exception:\s*(.+)/i,
];

/**
 * Completion/prompt patterns
 * @type {RegExp[]}
 */
const COMPLETE_PATTERNS = [
  /^>\s*$/m, // Simple prompt
  /^\$\s*$/m, // Shell prompt
  /^claude>\s*$/im, // Claude prompt
  /\n\n\n$/, // Multiple empty lines
];

/**
 * ANSI escape code regex pattern
 * @type {RegExp}
 */
// eslint-disable-next-line no-control-regex
const ANSI_REGEX = /\x1b\[[0-9;]*m/g;

/**
 * OutputParser class - parses Claude Code stdout
 */
class OutputParser {
  /**
   * Create a new OutputParser instance
   */
  constructor() {
    this.buffer = '';
    this.lastToolDetected = null;
  }

  /**
   * Parse a stdout chunk into events
   * @param {string|Buffer} chunk - Raw stdout data
   * @returns {ParsedEvent[]} Array of parsed events
   */
  parse(chunk) {
    const text = typeof chunk === 'string' ? chunk : chunk.toString();
    const cleanText = this.stripAnsi(text);

    // Add to buffer for incomplete line handling
    this.buffer += cleanText;

    const events = [];

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
   * @param {string} text - Text with potential ANSI codes
   * @returns {string} Clean text
   */
  stripAnsi(text) {
    return text.replace(ANSI_REGEX, '');
  }

  /**
   * Detect tool usage pattern in text
   * @param {string} text - Text to analyze
   * @returns {Object|null} Tool info or null
   */
  detectToolUse(text) {
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
   * @param {string} text - Text to analyze
   * @returns {string|null} Tool name or null
   */
  detectToolComplete(text) {
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
   * @param {string} text - Text to analyze
   * @returns {boolean} True if completion detected
   */
  detectComplete(text) {
    for (const pattern of COMPLETE_PATTERNS) {
      if (pattern.test(text)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Detect error pattern in text
   * @param {string} text - Text to analyze
   * @returns {string|null} Error message or null
   */
  detectError(text) {
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
   * @returns {ParsedEvent[]} Remaining events
   */
  flush() {
    const events = [];
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
  reset() {
    this.buffer = '';
    this.lastToolDetected = null;
  }

  /**
   * Get current buffer content
   * @returns {string}
   */
  getBuffer() {
    return this.buffer;
  }
}

module.exports = {
  OutputParser,
  TOOL_PATTERNS,
  ERROR_PATTERNS,
  COMPLETE_PATTERNS,
  ANSI_REGEX,
};
