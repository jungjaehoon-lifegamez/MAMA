declare module '@jungjaehoon/mama-core/debug-logger' {
  export class DebugLogger {
    constructor(context?: string);
    debug(...args: unknown[]): void;
    info(...args: unknown[]): void;
    warn(...args: unknown[]): void;
    error(...args: unknown[]): void;
  }

  const defaultLogger: DebugLogger;
  export default defaultLogger;
  export const debug: (...args: unknown[]) => void;
  export const info: (...args: unknown[]) => void;
  export const warn: (...args: unknown[]) => void;
  export const error: (...args: unknown[]) => void;
}
