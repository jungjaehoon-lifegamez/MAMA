/**
 * @fileoverview Claude Code Daemon - stream-json based subprocess manager
 * @module mobile/daemon
 * @version 1.5.2
 *
 * Manages Claude Code as a subprocess using stream-json mode for
 * bidirectional JSON communication.
 *
 * @example
 * const { ClaudeDaemon } = require('./daemon');
 * const daemon = new ClaudeDaemon('/path/to/project', 'session_123');
 * await daemon.spawn();
 * daemon.send('Hello Claude!');
 * daemon.on('output', (data) => console.log(data));
 */

const { EventEmitter } = require('events');
const { spawn } = require('child_process');

/**
 * ANSI escape code regex pattern
 * @type {RegExp}
 */
// eslint-disable-next-line no-control-regex
const ANSI_REGEX = /\x1b\[[0-9;]*m/g;

/**
 * ClaudeDaemon class - manages Claude Code subprocess via stream-json
 * @extends EventEmitter
 *
 * @fires ClaudeDaemon#output - When stdout data is received
 * @fires ClaudeDaemon#error - When an error occurs
 * @fires ClaudeDaemon#exit - When the process exits
 */
class ClaudeDaemon extends EventEmitter {
  /**
   * Create a new ClaudeDaemon instance
   * @param {string} projectDir - Working directory for Claude Code
   * @param {string} sessionId - Unique session identifier
   */
  constructor(projectDir, sessionId) {
    super();
    this.projectDir = projectDir;
    this.sessionId = sessionId;
    this.process = null;
    this.pid = null;
    this.isRunning = false;
    this.buffer = '';
  }

  /**
   * Spawn the Claude Code subprocess with stream-json mode
   * @returns {Promise<void>}
   * @throws {Error} If spawn fails or process is already running
   */
  async spawn() {
    if (this.isRunning) {
      throw new Error('Daemon is already running');
    }

    return new Promise((resolve, reject) => {
      try {
        // Use stream-json mode for bidirectional JSON communication
        const args = [
          '--print',
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
        this.pid = this.process.pid;
        this.isRunning = true;

        console.error(
          `[MobileDaemon] Session ${this.sessionId} spawned with PID ${this.pid} (stream-json mode)`
        );

        // Handle stdout data (JSON stream)
        this.process.stdout.on('data', (chunk) => {
          this.buffer += chunk.toString();

          // Try to parse complete JSON objects from buffer
          let newlineIndex;
          while ((newlineIndex = this.buffer.indexOf('\n')) !== -1) {
            const line = this.buffer.slice(0, newlineIndex).trim();
            this.buffer = this.buffer.slice(newlineIndex + 1);

            if (line) {
              try {
                const parsed = JSON.parse(line);
                console.error(
                  `[MobileDaemon] Parsed JSON: ${JSON.stringify(parsed).substring(0, 100)}...`
                );

                // Extract text content from various message types
                let textContent = '';
                if (parsed.type === 'assistant' && parsed.message?.content) {
                  // Assistant message with content blocks
                  for (const block of parsed.message.content) {
                    if (block.type === 'text') {
                      textContent += block.text;
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
                  });
                }

                // Detect response completion (result message)
                if (parsed.type === 'result') {
                  console.error(`[MobileDaemon] Response complete for session ${this.sessionId}`);
                  this.emit('response_complete', {
                    sessionId: this.sessionId,
                    result: parsed.result,
                    duration_ms: parsed.duration_ms,
                  });
                }
              } catch (e) {
                // Not valid JSON, emit as raw text
                console.error(`[MobileDaemon] Raw output: ${line.substring(0, 100)}...`);
                this.emit('output', {
                  type: 'stdout',
                  text: line,
                  raw: line,
                  sessionId: this.sessionId,
                });
              }
            }
          }
        });

        // Handle stderr data
        this.process.stderr.on('data', (chunk) => {
          const text = chunk.toString();
          console.error(`[MobileDaemon] stderr: ${text.substring(0, 200)}`);
          this.emit('output', {
            type: 'stderr',
            text: text.replace(ANSI_REGEX, ''),
            raw: text,
            sessionId: this.sessionId,
          });
        });

        // Handle process errors
        this.process.on('error', (err) => {
          console.error(`[MobileDaemon] Error in session ${this.sessionId}:`, err.message);
          this.isRunning = false;
          this.emit('error', {
            error: err,
            sessionId: this.sessionId,
          });
          reject(err);
        });

        // Handle process exit
        this.process.on('exit', (code, signal) => {
          console.error(
            `[MobileDaemon] Session ${this.sessionId} exited with code ${code}, signal ${signal}`
          );
          this.isRunning = false;
          this.pid = null;
          this.emit('exit', {
            code,
            signal,
            sessionId: this.sessionId,
          });
        });

        // Process should be ready immediately in stream-json mode
        setTimeout(() => {
          if (this.isRunning) {
            resolve();
          }
        }, 100);
      } catch (err) {
        console.error(`[MobileDaemon] Failed to spawn session ${this.sessionId}:`, err.message);
        this.isRunning = false;
        this.emit('error', {
          error: err,
          sessionId: this.sessionId,
        });
        reject(err);
      }
    });
  }

  /**
   * Send a message to Claude via stdin (stream-json format)
   * @param {string} message - Message to send
   * @throws {Error} If process is not running
   */
  send(message) {
    if (!this.isRunning || !this.process || !this.process.stdin) {
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

    this.process.stdin.write(jsonMessage + '\n');

    console.error(
      `[MobileDaemon] Sent JSON to session ${this.sessionId}: ${jsonMessage.substring(0, 100)}...`
    );
  }

  /**
   * Kill the Claude Code subprocess
   * @param {string} [signal='SIGTERM'] - Signal to send to process
   */
  kill(signal = 'SIGTERM') {
    if (!this.process) {
      console.error(`[MobileDaemon] No process to kill for session ${this.sessionId}`);
      return;
    }

    try {
      console.error(`[MobileDaemon] Killing session ${this.sessionId} with signal ${signal}`);
      this.process.kill(signal);
      this.isRunning = false;

      // Emit exit event
      this.emit('exit', {
        code: null,
        signal,
        sessionId: this.sessionId,
        manual: true,
      });
    } catch (err) {
      console.error(`[MobileDaemon] Error killing session ${this.sessionId}:`, err.message);
      this.emit('error', {
        error: err,
        sessionId: this.sessionId,
      });
    }
  }

  /**
   * Check if the daemon is currently running
   * @returns {boolean}
   */
  isActive() {
    return this.isRunning && this.process !== null;
  }

  /**
   * Get the process ID
   * @returns {number|null}
   */
  getPid() {
    return this.pid;
  }
}

module.exports = {
  ClaudeDaemon,
  ANSI_REGEX,
};
