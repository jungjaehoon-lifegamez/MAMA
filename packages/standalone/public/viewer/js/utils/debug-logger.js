/* eslint-env browser */

/**
 * Lightweight DebugLogger for viewer modules.
 * Mirrors mama-core DebugLogger behavior (no console.log usage).
 */
export class DebugLogger {
  constructor(context = 'Viewer') {
    this.context = context;
  }

  _format(level, args) {
    const ts = new Date().toISOString();
    return [`[${ts}] [${this.context}] [${level}]`, ...args];
  }

  debug(...args) {
    console.error(...this._format('DEBUG', args));
  }

  info(...args) {
    console.error(...this._format('INFO', args));
  }

  warn(...args) {
    console.warn(...this._format('WARN', args));
  }

  error(...args) {
    console.error(...this._format('ERROR', args));
  }
}

export default DebugLogger;
