/**
 * In-memory repair authority for the event-driven Board path (TG-06).
 *
 * The gate is dirt, and nothing else. It starts CLEAN: a boot is not evidence
 * that anything the board reads moved, and the forced one-full-run-per-boot it
 * used to buy is what made the owner's first message after a restart wait on a
 * maintenance turn (owner decision 2026-09-09). Channel deltas receive
 * monotonically increasing generations before debounce/budgeting. A completion
 * may clear only the generation it captured; later ingress stays dirty and is
 * repaired by a later reconcile or full pass.
 *
 * Staleness and "no board has ever been published" remain grounds for a full
 * run, but they are EVIDENCE, read by the delta gate (board-delta-gate.ts),
 * never state this gate invents at boot.
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
  private readonly channelGenerations = new Map<string, number>();

  constructor(options: BoardRefreshGateOptions = {}) {
    const initial = options.initialGeneration ?? (options.now ?? Date.now)();
    assertRepairGeneration(initial);
    this.generation = initial;
  }

  needsFullRepair(): boolean {
    return this.channelGenerations.size > 0;
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
