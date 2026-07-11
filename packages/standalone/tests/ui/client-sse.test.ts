import { afterEach, describe, expect, it, vi } from 'vitest';
import { connectReportSse } from '../../ui/src/api/client';

type Listener = (event: Event) => void;

class FakeEventSource {
  static instance: FakeEventSource | null = null;
  readonly listeners = new Map<string, Listener[]>();
  readonly close = vi.fn();

  constructor(readonly url: string) {
    FakeEventSource.instance = this;
  }

  addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    const callback = listener as Listener;
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), callback]);
  }

  emit(type: string, event = new Event(type)): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }
}

describe('connectReportSse', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    FakeEventSource.instance = null;
  });

  it('wires open and down callbacks and closes the stream', () => {
    vi.stubGlobal('EventSource', FakeEventSource);
    const onOpen = vi.fn();
    const onDown = vi.fn();

    const disconnect = connectReportSse({ onUpdate: vi.fn(), onOpen, onDown });
    const source = FakeEventSource.instance;
    expect(source?.url).toBe('/api/report/events');

    source?.emit('open');
    source?.emit('error');
    disconnect();

    expect(onOpen).toHaveBeenCalledOnce();
    expect(onDown).toHaveBeenCalledOnce();
    expect(source?.close).toHaveBeenCalledOnce();
  });

  it('reports error-to-open recovery in order on repeated reconnects', () => {
    vi.stubGlobal('EventSource', FakeEventSource);
    const callbackOrder: string[] = [];

    connectReportSse({
      onUpdate: vi.fn(),
      onOpen: () => callbackOrder.push('open'),
      onDown: () => callbackOrder.push('down'),
    });
    const source = FakeEventSource.instance;

    source?.emit('error');
    source?.emit('open');
    source?.emit('error');
    source?.emit('open');

    expect(callbackOrder).toEqual(['down', 'open', 'down', 'open']);
  });
});
