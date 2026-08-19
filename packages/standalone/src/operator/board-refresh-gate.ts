/**
 * In-memory repair authority for the event-driven Board path (TG-06).
 *
 * The gate starts dirty so every boot earns one full repair. Channel deltas
 * receive monotonically increasing generations before debounce/budgeting. A
 * completion may clear only the generation it captured; later ingress stays
 * dirty and is repaired by a later reconcile or full pass.
 */

export interface BoardRefreshGateOptions {
  /** Test seam. Production seeds from epoch milliseconds to order across boots. */
  initialGeneration?: number;
  now?: () => number;
}

export interface FullRepairCapture {
  repairGeneration: number;
  noUpdateScope: string;
}

export function boardFullNoUpdateScope(repairGeneration: number): string {
  assertRepairGeneration(repairGeneration);
  return `full:${repairGeneration}`;
}

function assertRepairGeneration(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`board repair generation must be a non-negative safe integer`);
  }
}

export class BoardRefreshGate {
  private generation: number;
  private readonly bootGeneration: number;
  private bootDirty = true;
  private readonly channelGenerations = new Map<string, number>();

  constructor(options: BoardRefreshGateOptions = {}) {
    const initial = options.initialGeneration ?? (options.now ?? Date.now)();
    assertRepairGeneration(initial);
    this.generation = initial;
    this.bootGeneration = initial;
  }

  needsFullRepair(): boolean {
    return this.bootDirty || this.channelGenerations.size > 0;
  }

  markChannelDirty(channelKey: string): number {
    if (channelKey.length === 0) {
      throw new Error('board repair channelKey must be non-empty');
    }
    if (this.generation >= Number.MAX_SAFE_INTEGER) {
      throw new Error('board repair generation exhausted');
    }
    this.generation += 1;
    this.channelGenerations.set(channelKey, this.generation);
    return this.generation;
  }

  dirtyGeneration(channelKey: string): number | null {
    return this.channelGenerations.get(channelKey) ?? null;
  }

  captureFullRepair(): FullRepairCapture {
    return {
      repairGeneration: this.generation,
      noUpdateScope: boardFullNoUpdateScope(this.generation),
    };
  }

  completeVerifiedReconcile(channelKey: string, capturedGeneration: number): void {
    this.clearCapturedChannelGeneration(channelKey, capturedGeneration);
  }

  consumeUnauthorizedPartition(channelKey: string, capturedGeneration: number): void {
    this.clearCapturedChannelGeneration(channelKey, capturedGeneration);
  }

  completeVerifiedFull(capturedGeneration: number): void {
    assertRepairGeneration(capturedGeneration);
    if (capturedGeneration >= this.bootGeneration) {
      this.bootDirty = false;
    }
    for (const [channelKey, generation] of this.channelGenerations) {
      if (generation <= capturedGeneration) {
        this.channelGenerations.delete(channelKey);
      }
    }
  }

  private clearCapturedChannelGeneration(channelKey: string, capturedGeneration: number): void {
    assertRepairGeneration(capturedGeneration);
    const current = this.channelGenerations.get(channelKey);
    if (current !== undefined && current <= capturedGeneration) {
      this.channelGenerations.delete(channelKey);
    }
  }
}
