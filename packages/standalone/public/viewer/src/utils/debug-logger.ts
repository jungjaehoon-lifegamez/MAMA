/* eslint-env browser */

/**
 * Lightweight DebugLogger for viewer modules.
 * Mirrors mama-core DebugLogger behavior (no console.log usage).
 */
export class DebugLogger {
  context: string;

  constructor(context = 'Viewer') {
    this.context = String(context);
  }

  private _format(level: string, args: unknown[]) {
    const ts = new Date().toISOString();
    return [`[${ts}] [${this.context}] [${level}]`, ...args];
  }

  debug(...args: unknown[]) {
    console.debug(...this._format('DEBUG', args));
  }

  info(...args: unknown[]) {
    console.info(...this._format('INFO', args));
  }

  warn(...args: unknown[]) {
    console.warn(...this._format('WARN', args));
  }

  error(...args: unknown[]) {
    console.error(...this._format('ERROR', args));
  }
}

export default DebugLogger;
