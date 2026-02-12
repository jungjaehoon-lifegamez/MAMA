/**
 * @fileoverview Claude Code Daemon - stream-json based subprocess manager
 * @module mobile/daemon
 * @version 1.5.2
 *
 * Manages Claude Code as a subprocess using stream-json mode for
 * bidirectional JSON communication.
 *
 * @example
 * import { ClaudeDaemon } from './daemon';
 * const daemon = new ClaudeDaemon('/path/to/project', 'session_123');
 * await daemon.spawn();
 * daemon.send('Hello Claude!');
 * daemon.on('output', (data) => console.log(data));
 */

import { EventEmitter } from 'events';
import { spawn, ChildProcess } from 'child_process';
import type { Readable, Writable } from 'stream';

/**
 * ANSI escape code regex pattern
 */
// eslint-disable-next-line no-control-regex
export const ANSI_REGEX: RegExp = /\x1b\[[0-9;]*m/g;

/**
 * Output event data
 */
export interface OutputEvent {
  type: 'stdout' | 'stderr';
  text: string;
  raw: string;
  parsed?: unknown;
  sessionId: string;
}

/**
 * Error event data
 */
export interface ErrorEvent {
  error: Error;
  sessionId: string;
}

/**
 * Exit event data
 */
export interface ExitEvent {
  code: number | null;
  signal: NodeJS.Signals | null;
  sessionId: string;
  manual?: boolean;
}

/**
 * Tool use event data
 */
export interface ToolUseEvent {
  tool: string;
  toolId: string;
  input: unknown;
  sessionId: string;
}

/**
 * Tool complete event data
 */
export interface ToolCompleteEvent {
  index: number;
  sessionId: string;
}

/**
 * Response complete event data
 */
export interface ResponseCompleteEvent {
  sessionId: string;
  result: unknown;
  duration_ms?: number;
}

/**
 * ClaudeDaemon class - manages Claude Code subprocess via stream-json
 * @extends EventEmitter
 *
 * @fires ClaudeDaemon#output - When stdout data is received
 * @fires ClaudeDaemon#error - When an error occurs
 * @fires ClaudeDaemon#exit - When the process exits
 */
export class ClaudeDaemon extends EventEmitter {
  private projectDir: string;
  private sessionId: string;
  private process: ChildProcess | null;
  private _pid: number | null;
  private _isRunning: boolean;
  private buffer: string;

  /**
   * Create a new ClaudeDaemon instance
   * @param projectDir - Working directory for Claude Code
   * @param sessionId - Unique session identifier
   */
  constructor(projectDir: string, sessionId: string) {
    super();
    this.projectDir = projectDir;
    this.sessionId = sessionId;
    this.process = null;
    this._pid = null;
    this._isRunning = false;
    this.buffer = '';
  }

  /**
   * Check if the daemon is currently running
   */
  get isRunning(): boolean {
    return this._isRunning;
  }

  /**
   * Get the process ID
   */
  get pid(): number | null {
    return this._pid;
  }

  /**
   * Spawn the Claude Code subprocess with stream-json mode
   * @returns Promise that resolves when process is ready
   * @throws Error if spawn fails or process is already running
   */
  async spawn(): Promise<void> {
    if (this._isRunning) {
      throw new Error('Daemon is already running');
    }

    return new Promise((resolve, reject) => {
      let settled = false;

      try {
        // Use stream-json mode for bidirectional JSON communication
        const args = [
          '--dangerously-skip-permissions',
          '--input-format',
          'stream-json',
          '--output-format',
          'stream-json',
        ];

        // Spawn Claude Code CLI
        this.process = spawn('claude', args, {
          cwd: this.projectDir,
          stdio: ['pipe', 'pipe', 'pipe'],
          env: {
            ...process.env,
            CLAUDE_CODE_ENTRY_POINT: 'cli',
          },
        });

        // Store PID
        this._pid = this.process.pid || null;
        this._isRunning = true;

        console.error(
          `[MobileDaemon] Session ${this.sessionId} spawned with PID ${this._pid} (stream-json mode)`
        );

        // Handle stdout data (JSON stream)
        (this.process.stdout as Readable).on('data', (chunk: Buffer) => {
          this.buffer += chunk.toString();

          // Try to parse complete JSON objects from buffer
          let newlineIndex: number;
          while ((newlineIndex = this.buffer.indexOf('\n')) !== -1) {
            const line = this.buffer.slice(0, newlineIndex).trim();
            this.buffer = this.buffer.slice(newlineIndex + 1);

            if (line) {
              try {
                const parsed = JSON.parse(line) as {
                  type?: string;
                  content_block?: { type?: string; name?: string; id?: string; input?: unknown };
                  index?: number;
                  message?: { content?: Array<{ type: string; text?: string }> };
                  delta?: { text?: string };
                  result?: { content?: string };
                  duration_ms?: number;
                };
                console.error(
                  `[MobileDaemon] Parsed JSON: ${JSON.stringify(parsed).substring(0, 100)}...`
                );

                // Detect tool usage (content_block_start with tool_use type)
                if (
                  parsed.type === 'content_block_start' &&
                  parsed.content_block?.type === 'tool_use'
                ) {
                  const toolBlock = parsed.content_block;
                  console.error(`[MobileDaemon] Tool use detected: ${toolBlock.name}`);
                  this.emit('tool_use', {
                    tool: toolBlock.name,
                    toolId: toolBlock.id,
                    input: toolBlock.input,
                    sessionId: this.sessionId,
                  } as ToolUseEvent);
                }

                // Detect tool completion (content_block_stop after tool_use)
                if (parsed.type === 'content_block_stop' && parsed.index !== undefined) {
                  console.error(`[MobileDaemon] Tool complete for block ${parsed.index}`);
                  this.emit('tool_complete', {
                    index: parsed.index,
                    sessionId: this.sessionId,
                  } as ToolCompleteEvent);
                }

                // Extract text content from various message types
                let textContent = '';
                if (parsed.type === 'assistant' && parsed.message?.content) {
                  // Assistant message with content blocks
                  for (const block of parsed.message.content) {
                    if (block.type === 'text') {
                      textContent += block.text || '';
                    }
                  }
                } else if (parsed.type === 'content_block_delta' && parsed.delta?.text) {
                  // Streaming delta
                  textContent = parsed.delta.text;
                } else if (parsed.result?.content) {
                  // Final result
                  textContent = parsed.result.content;
                }

                if (textContent) {
                  this.emit('output', {
                    type: 'stdout',
                    text: textContent,
                    raw: line,
                    parsed,
                    sessionId: this.sessionId,
                  } as OutputEvent);
                }

                // Detect response completion (result message)
                if (parsed.type === 'result') {
                  console.error(`[MobileDaemon] Response complete for session ${this.sessionId}`);
                  this.emit('response_complete', {
                    sessionId: this.sessionId,
                    result: parsed.result,
                    duration_ms: parsed.duration_ms,
                  } as ResponseCompleteEvent);
                }
              } catch {
                // Not valid JSON, emit as raw text
                console.error(`[MobileDaemon] Raw output: ${line.substring(0, 100)}...`);
                this.emit('output', {
                  type: 'stdout',
                  text: line,
                  raw: line,
                  sessionId: this.sessionId,
                } as OutputEvent);
              }
            }
          }
        });

        // Handle stderr data
        (this.process.stderr as Readable).on('data', (chunk: Buffer) => {
          const text = chunk.toString();
          console.error(`[MobileDaemon] stderr: ${text.substring(0, 200)}`);
          this.emit('output', {
            type: 'stderr',
            text: text.replace(ANSI_REGEX, ''),
            raw: text,
            sessionId: this.sessionId,
          } as OutputEvent);
        });

        // Handle process errors
        this.process.on('error', (err: Error) => {
          console.error(`[MobileDaemon] Error in session ${this.sessionId}:`, err.message);
          this._isRunning = false;
          this.emit('error', {
            error: err,
            sessionId: this.sessionId,
          } as ErrorEvent);
          if (!settled) {
            settled = true;
            reject(err);
          }
        });

        // Handle process exit
        this.process.on('exit', (code: number | null, signal: NodeJS.Signals | null) => {
          console.error(
            `[MobileDaemon] Session ${this.sessionId} exited with code ${code}, signal ${signal}`
          );
          this._isRunning = false;
          this._pid = null;
          this.emit('exit', {
            code,
            signal,
            sessionId: this.sessionId,
          } as ExitEvent);
          // Reject if process exits before we resolve
          if (!settled) {
            settled = true;
            reject(new Error(`Process exited with code ${code} before ready`));
          }
        });

        // Process should be ready immediately in stream-json mode
        setTimeout(() => {
          if (this._isRunning && !settled) {
            settled = true;
            resolve();
          }
        }, 100);
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        console.error(`[MobileDaemon] Failed to spawn session ${this.sessionId}:`, error.message);
        this._isRunning = false;
        this.emit('error', {
          error,
          sessionId: this.sessionId,
        } as ErrorEvent);
        reject(error);
      }
    });
  }

  /**
   * Send a message to Claude via stdin (stream-json format)
   * @param message - Message to send
   * @throws Error if process is not running
   */
  send(message: string): void {
    if (!this._isRunning || !this.process || !this.process.stdin) {
      throw new Error('Daemon is not running');
    }

    // Send as JSON object with type "user" and nested message object
    const jsonMessage = JSON.stringify({
      type: 'user',
      message: {
        role: 'user',
        content: message,
      },
    });

    (this.process.stdin as Writable).write(jsonMessage + '\n');

    console.error(
      `[MobileDaemon] Sent JSON to session ${this.sessionId}: ${jsonMessage.substring(0, 100)}...`
    );
  }

  /**
   * Kill the Claude Code subprocess
   * @param signal - Signal to send to process
   */
  kill(signal: NodeJS.Signals = 'SIGTERM'): void {
    if (!this.process) {
      console.error(`[MobileDaemon] No process to kill for session ${this.sessionId}`);
      return;
    }

    try {
      console.error(`[MobileDaemon] Killing session ${this.sessionId} with signal ${signal}`);
      this.process.kill(signal);
      // Note: exit event will be emitted by process.on('exit') handler
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      console.error(`[MobileDaemon] Error killing session ${this.sessionId}:`, error.message);
      // Ensure state is consistent even if kill fails
      this._isRunning = false;
      this.emit('error', {
        error,
        sessionId: this.sessionId,
      } as ErrorEvent);
    }
  }

  /**
   * Check if the daemon is currently running
   * @returns True if running
   */
  isActive(): boolean {
    return this._isRunning && this.process !== null;
  }

  /**
   * Get the process ID
   * @returns Process ID or null
   */
  getPid(): number | null {
    return this._pid;
  }
}
