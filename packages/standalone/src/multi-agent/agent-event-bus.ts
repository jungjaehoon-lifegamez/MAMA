export interface AgentNotice {
  agent: string;
  action: string;
  target: string;
  timestamp: number;
}

export type AgentEvent =
  | { type: 'memory:saved'; topic: string; project?: string }
  | { type: 'extraction:completed'; projects: string[] }
  | { type: 'wiki:compiled'; pages: string[] }
  | { type: 'dashboard:refresh' }
  | { type: 'agent:action'; agent: string; action: string; target: string };

export type AgentEventType = AgentEvent['type'];
type EventHandler = (event: AgentEvent) => void | Promise<void>;

export class AgentEventBus {
  static readonly MAX_NOTICES = 50;
  private listeners = new Map<AgentEventType, Set<EventHandler>>();
  private debounceTimers = new Map<AgentEventType, ReturnType<typeof setTimeout>>();
  private notices: AgentNotice[] = [];

  on(type: AgentEventType, handler: EventHandler): void {
    if (!this.listeners.has(type)) {
      this.listeners.set(type, new Set());
    }
    this.listeners.get(type)!.add(handler);
  }

  off(type: AgentEventType, handler: EventHandler): void {
    this.listeners.get(type)?.delete(handler);
  }

  emit(event: AgentEvent): void {
    const handlers = this.listeners.get(event.type);
    if (handlers) {
      for (const handler of handlers) {
        try {
          const result = handler(event);
          if (result && typeof (result as Promise<void>).catch === 'function') {
            (result as Promise<void>).catch((err) =>
              console.error(`[EventBus] Handler error for ${event.type}:`, err)
            );
          }
        } catch (err) {
          console.error(`[EventBus] Sync handler error for ${event.type}:`, err);
        }
      }
    }

    if (event.type === 'agent:action') {
      this.notices.unshift({
        agent: event.agent,
        action: event.action,
        target: event.target,
        timestamp: Date.now(),
      });
      if (this.notices.length > AgentEventBus.MAX_NOTICES) {
        this.notices.length = AgentEventBus.MAX_NOTICES;
      }
    }
  }

  emitDebounced(event: AgentEvent, delayMs: number): void {
    const existing = this.debounceTimers.get(event.type);
    if (existing) clearTimeout(existing);
    this.debounceTimers.set(
      event.type,
      setTimeout(() => {
        this.debounceTimers.delete(event.type);
        this.emit(event);
      }, delayMs)
    );
  }

  getRecentNotices(limit: number): AgentNotice[] {
    return this.notices.slice(0, limit);
  }

  destroy(): void {
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();
    this.listeners.clear();
    this.notices.length = 0;
  }
}
