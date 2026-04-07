/**
 * ConnectorEventLog — in-memory ring buffer for connector extraction events.
 * Used by the Control Tower UI to show recent activity.
 */

export interface ConnectorEvent {
  timestamp: string; // ISO 8601
  source: string; // connector name (e.g. 'slack')
  channel: string; // channel key (e.g. '#project-alpha')
  memoriesExtracted: number;
  error?: string;
}

export class ConnectorEventLog {
  private readonly buffer: ConnectorEvent[] = [];
  private readonly maxSize: number;

  constructor(maxSize = 200) {
    this.maxSize = maxSize;
  }

  push(event: ConnectorEvent): void {
    this.buffer.push(event);
    if (this.buffer.length > this.maxSize) {
      this.buffer.shift();
    }
  }

  getRecent(limit = 50): ConnectorEvent[] {
    const start = Math.max(0, this.buffer.length - limit);
    return this.buffer.slice(start).reverse();
  }

  getStats(): { total: number; errors: number; totalMemories: number } {
    let errors = 0;
    let totalMemories = 0;
    for (const event of this.buffer) {
      if (event.error) errors++;
      totalMemories += event.memoriesExtracted;
    }
    return { total: this.buffer.length, errors, totalMemories };
  }
}
