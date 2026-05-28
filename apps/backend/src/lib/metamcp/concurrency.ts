// Bounds how many MCP sub-server connections (= process spawns) may be
// established at the same time. A namespace can fan out to many servers at
// once (tools/list, prompts, resources, idle pre-warm, on-connect); spawning
// them all in parallel pins the CPU regardless of package manager (npx/uvx/
// node alike). Gating the single spawn choke point keeps the peak bounded for
// any stack size. Tunable via MCP_SPAWN_CONCURRENCY (default 6).

const DEFAULT_SPAWN_CONCURRENCY = 6;

export function spawnConcurrency(): number {
  const n = Number.parseInt(process.env.MCP_SPAWN_CONCURRENCY ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_SPAWN_CONCURRENCY;
}

export class Semaphore {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly max: number) {}

  private async acquire(): Promise<void> {
    if (this.active < this.max) {
      this.active++;
      return;
    }
    // No free slot: wait until release() hands one to us. The slot count is
    // not decremented on hand-off, so we must not re-increment here.
    await new Promise<void>((resolve) => this.waiters.push(resolve));
  }

  private release(): void {
    const next = this.waiters.shift();
    if (next) {
      next();
    } else {
      this.active--;
    }
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }
}
