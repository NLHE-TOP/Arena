/**
 * Bounded concurrency for platform calls, shared across rooms and runtimes.
 *
 * This is pure scheduling plumbing: it holds no poker state and no turn
 * authority, so sharing one limiter between runtimes cannot leak game state.
 */
import type { DecisionConcurrencyLimiterLike } from './contracts.js';

export class DecisionConcurrencyLimiter implements DecisionConcurrencyLimiterLike {
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(readonly max: number) {
    if (!Number.isSafeInteger(max) || max < 1) {
      throw new RangeError(`concurrency limit must be a positive safe integer: ${String(max)}`);
    }
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) {
      await new Promise<void>((resolve) => {
        this.waiting.push(resolve);
      });
    }
    this.active += 1;
    try {
      return await task();
    } finally {
      this.active -= 1;
      const next = this.waiting.shift();
      if (next) next();
    }
  }
}
