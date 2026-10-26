import { sleep } from './util.ts';

/** Shared bandwidth limiter: every reader asks for permission before consuming `n` bytes. */
export class Throttle {
  private nextFree = 0;
  private bytesPerSec: number;
  constructor(bytesPerSec = 0) { this.bytesPerSec = bytesPerSec; }

  setLimit(bytesPerSec: number): void { this.bytesPerSec = Math.max(0, Math.floor(bytesPerSec)); this.nextFree = 0; }
  get limit(): number { return this.bytesPerSec; }

  async take(n: number, signal?: AbortSignal): Promise<void> {
    if (!this.bytesPerSec || n <= 0) return;
    const now = Date.now();
    const start = Math.max(now, this.nextFree);
    this.nextFree = start + (n / this.bytesPerSec) * 1000;
    const wait = start - now;
    if (wait > 1) await sleep(wait, signal);
  }
}
