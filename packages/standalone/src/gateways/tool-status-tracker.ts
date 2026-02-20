/**
 * Tool Status Tracker for Slack & Discord
 *
 * Provides real-time tool usage feedback via platform-specific placeholder messages.
 * Uses a PlatformAdapter pattern to abstract Slack/Discord API differences.
 *
 * Rendering format:
 *   ⏳ Working... (12s)
 *   ✅ Read: config.yaml
 *   ✅ Bash: pnpm test
 *   🔧 Grep: searching...
 */

import * as debugLogger from '@jungjaehoon/mama-core/debug-logger';

const { DebugLogger } = debugLogger as unknown as {
  DebugLogger: new (context?: string) => {
    debug: (...args: unknown[]) => void;
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
  };
};
const logger = new DebugLogger('ToolStatusTracker');

export interface PlatformAdapter {
  /** Post a new placeholder message, returns an opaque handle for later edits */
  postPlaceholder(content: string): Promise<string | null>;
  /** Edit an existing placeholder message */
  editPlaceholder(handle: string, content: string): Promise<void>;
  /** Delete a placeholder message */
  deletePlaceholder(handle: string): Promise<void>;
}

interface ToolEntry {
  name: string;
  label: string;
  status: 'running' | 'done' | 'error';
}

export interface ToolStatusTrackerOptions {
  /** Minimum ms between edits (Discord: 3000, Slack: 1500) */
  throttleMs?: number;
  /** Delay before showing placeholder (Discord: 5000, Slack: 3000) */
  initialDelayMs?: number;
  /** Max completed tools to show (oldest get trimmed) */
  maxCompletedTools?: number;
}

const DEFAULT_THROTTLE_MS = 3000;
const DEFAULT_INITIAL_DELAY_MS = 5000;
const DEFAULT_MAX_COMPLETED = 8;

/**
 * Build a human-readable label from tool name + input
 */
export function buildToolLabel(name: string, input?: Record<string, unknown>): string {
  if (!input) {
    return name;
  }

  switch (name) {
    case 'Read': {
      const filePath = input.file_path ?? input.path;
      return filePath ? `Read: ${baseName(String(filePath))}` : 'Read';
    }
    case 'Write': {
      const filePath = input.file_path ?? input.path;
      return filePath ? `Write: ${baseName(String(filePath))}` : 'Write';
    }
    case 'Edit': {
      const filePath = input.file_path ?? input.path;
      return filePath ? `Edit: ${baseName(String(filePath))}` : 'Edit';
    }
    case 'Bash': {
      const cmd = input.command ?? input.cmd;
      if (!cmd) {
        return 'Bash';
      }
      const cmdStr = String(cmd);
      return `Bash: ${cmdStr.length > 40 ? cmdStr.substring(0, 37) + '...' : cmdStr}`;
    }
    case 'Grep': {
      const pattern = input.pattern ?? input.query;
      return pattern ? `Grep: ${String(pattern).substring(0, 30)}` : 'Grep';
    }
    case 'Glob': {
      const pattern = input.pattern;
      return pattern ? `Glob: ${String(pattern).substring(0, 30)}` : 'Glob';
    }
    case 'WebFetch': {
      const url = input.url;
      return url ? `WebFetch: ${String(url).substring(0, 35)}` : 'WebFetch';
    }
    case 'WebSearch': {
      const query = input.query;
      return query ? `WebSearch: ${String(query).substring(0, 30)}` : 'WebSearch';
    }
    case 'Task': {
      const desc = input.description ?? input.prompt;
      return desc ? `Task: ${String(desc).substring(0, 30)}` : 'Task';
    }
    default:
      return name;
  }
}

function baseName(filePath: string): string {
  const parts = filePath.split('/');
  return parts[parts.length - 1] || filePath;
}

export class ToolStatusTracker {
  private adapter: PlatformAdapter;
  private tools: ToolEntry[] = [];
  private handle: string | null = null;
  private startTime = Date.now();
  private throttleMs: number;
  private initialDelayMs: number;
  private maxCompleted: number;

  private delayHandle: ReturnType<typeof setTimeout> | null = null;
  private pendingEditHandle: ReturnType<typeof setTimeout> | null = null;
  private lastEditTime = 0;
  private placeholderPosted = false;
  private destroyed = false;

  constructor(adapter: PlatformAdapter, options?: ToolStatusTrackerOptions) {
    this.adapter = adapter;
    this.throttleMs = options?.throttleMs ?? DEFAULT_THROTTLE_MS;
    this.initialDelayMs = options?.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS;
    this.maxCompleted = options?.maxCompletedTools ?? DEFAULT_MAX_COMPLETED;
  }

  /**
   * Called when a tool starts executing.
   * If previous tool had no explicit complete, auto-complete it.
   */
  onToolUse(name: string, input?: Record<string, unknown>): void {
    if (this.destroyed) return;

    // Auto-complete any running tool (no explicit onToolComplete received)
    for (const tool of this.tools) {
      if (tool.status === 'running') {
        tool.status = 'done';
      }
    }

    const label = buildToolLabel(name, input);
    this.tools.push({ name, label, status: 'running' });

    this.scheduleStart();
    this.scheduleEdit();
  }

  /**
   * Called when a tool finishes executing.
   */
  onToolComplete(name: string, _toolUseId: string, isError: boolean): void {
    if (this.destroyed) return;

    // Find the last matching running tool
    for (let i = this.tools.length - 1; i >= 0; i--) {
      if (this.tools[i].name === name && this.tools[i].status === 'running') {
        this.tools[i].status = isError ? 'error' : 'done';
        break;
      }
    }

    this.scheduleEdit();
  }

  /**
   * Render the current status as a string.
   */
  render(): string {
    const elapsed = Math.round((Date.now() - this.startTime) / 1000);
    const lines: string[] = [`⏳ Working... (${elapsed}s)`];

    // Trim completed tools if over limit
    const completed = this.tools.filter((t) => t.status !== 'running');
    const running = this.tools.filter((t) => t.status === 'running');

    let visibleCompleted = completed;
    if (completed.length > this.maxCompleted) {
      const skip = completed.length - this.maxCompleted;
      visibleCompleted = completed.slice(skip);
      lines.push(`  ... ${skip} more`);
    }

    for (const tool of visibleCompleted) {
      const icon = tool.status === 'error' ? '❌' : '✅';
      lines.push(`${icon} ${tool.label}`);
    }

    for (const tool of running) {
      lines.push(`🔧 ${tool.label}`);
    }

    return lines.join('\n');
  }

  /**
   * Clean up: delete placeholder and cancel timers.
   */
  async cleanup(): Promise<void> {
    this.destroyed = true;

    if (this.delayHandle) {
      clearTimeout(this.delayHandle);
      this.delayHandle = null;
    }
    if (this.pendingEditHandle) {
      clearTimeout(this.pendingEditHandle);
      this.pendingEditHandle = null;
    }

    if (this.handle) {
      try {
        await this.adapter.deletePlaceholder(this.handle);
      } catch (err) {
        logger.warn(`Failed to delete placeholder: ${err}`);
      }
      this.handle = null;
    }
  }

  /**
   * Schedule the initial placeholder post after initialDelayMs.
   */
  private scheduleStart(): void {
    if (this.delayHandle || this.placeholderPosted || this.destroyed) return;

    this.delayHandle = setTimeout(async () => {
      this.delayHandle = null;
      if (this.destroyed) return;

      try {
        const content = this.render();
        this.handle = await this.adapter.postPlaceholder(content);
        this.placeholderPosted = true;
        this.lastEditTime = Date.now();
      } catch (err) {
        logger.warn(`Failed to post placeholder: ${err}`);
      }
    }, this.initialDelayMs);
  }

  /**
   * Schedule a throttled edit of the placeholder.
   */
  private scheduleEdit(): void {
    if (!this.placeholderPosted || !this.handle || this.destroyed) return;

    const now = Date.now();
    const elapsed = now - this.lastEditTime;

    if (elapsed >= this.throttleMs) {
      this.doEdit();
    } else if (!this.pendingEditHandle) {
      const delay = this.throttleMs - elapsed;
      this.pendingEditHandle = setTimeout(() => {
        this.pendingEditHandle = null;
        if (!this.destroyed) this.doEdit();
      }, delay);
    }
  }

  private doEdit(): void {
    if (!this.handle || this.destroyed) return;
    this.lastEditTime = Date.now();
    const content = this.render();
    this.adapter.editPlaceholder(this.handle, content).catch((err) => {
      logger.warn(`Failed to edit placeholder: ${err}`);
    });
  }

  /**
   * Build StreamCallbacks that feed into this tracker.
   */
  toStreamCallbacks(): {
    onToolUse: (name: string, input: Record<string, unknown>) => void;
    onToolComplete: (name: string, toolUseId: string, isError: boolean) => void;
  } {
    return {
      onToolUse: (name, input) => this.onToolUse(name, input),
      onToolComplete: (name, toolUseId, isError) => this.onToolComplete(name, toolUseId, isError),
    };
  }

  /**
   * Build PromptCallbacks (for multi-agent sendMessage).
   */
  toPromptCallbacks(): {
    onToolUse: (name: string, input: Record<string, unknown>) => void;
  } {
    return {
      onToolUse: (name, input) => this.onToolUse(name, input),
    };
  }
}
