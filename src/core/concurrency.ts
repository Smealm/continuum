/**
 * How many transfers to run at once, decided by what the connection actually
 * delivers instead of a fixed number.
 *
 * Adding a worker only helps while the bottleneck is per connection (request
 * latency, server shaping, TLS setup). Once the link is saturated, more workers
 * split the same bytes and make each game slower without finishing more of them,
 * so the controller climbs while goodput improves and settles when it does not.
 * Server failures back it off hard. The ceiling is the user's configured
 * maximum, so the archive never sees more than that from one client.
 */

export interface ConcurrencyOptions {
  min: number;
  max: number;
  /** Workers to start with; defaults to two, capped by `max`. */
  start?: number;
  /** After a failure, wait this long before probing upwards again. */
  cooldownMs?: number;
}

export interface ConcurrencySample {
  /** Bytes completed since the previous sample. */
  bytes: number;
  /** Permanent failures since the previous sample. */
  failures: number;
  elapsedMs: number;
}

export interface ConcurrencyDecision {
  limit: number;
  changed: boolean;
  reason: string;
}

/** A single sample this much worse than the best seen means "too many". */
const REGRESSION = 0.85;
/** A single sample this much better means "there is still room". */
const IMPROVEMENT = 1.05;

export class ConcurrencyController {
  private current: number;
  private bestGoodput: number | null = null;
  private cooldownUntil = 0;

  constructor(
    private readonly options: ConcurrencyOptions,
    private readonly now: () => number = Date.now,
  ) {
    const max = Math.max(1, options.max);
    const min = Math.min(Math.max(1, options.min), max);
    this.current = Math.min(max, Math.max(min, options.start ?? 2));
  }

  get limit(): number {
    return this.current;
  }

  sample(sample: ConcurrencySample): ConcurrencyDecision {
    const seconds = Math.max(0.001, sample.elapsedMs / 1000);
    const goodput = Math.max(0, sample.bytes) / seconds;

    if (sample.failures > 0) {
      this.bestGoodput = null;
      this.cooldownUntil = this.now() + (this.options.cooldownMs ?? 60_000);
      return this.apply(Math.max(1, Math.floor(this.current / 2)), 'failures; backing off');
    }

    if (this.now() < this.cooldownUntil) {
      return { limit: this.current, changed: false, reason: 'cooling down after failures' };
    }

    if (this.bestGoodput === null) {
      this.bestGoodput = goodput;
      return { limit: this.current, changed: false, reason: 'learning the connection' };
    }

    if (goodput > this.bestGoodput * IMPROVEMENT) {
      this.bestGoodput = goodput;
      if (this.current < this.options.max) {
        return this.apply(this.current + 1, 'throughput improved');
      }
      return { limit: this.current, changed: false, reason: 'at the ceiling' };
    }

    if (goodput < this.bestGoodput * REGRESSION) {
      this.bestGoodput = goodput;
      if (this.current > (this.options.min ?? 1)) {
        return this.apply(this.current - 1, 'throughput fell');
      }
      return { limit: this.current, changed: false, reason: 'at the floor' };
    }

    return { limit: this.current, changed: false, reason: 'holding' };
  }

  private apply(limit: number, reason: string): ConcurrencyDecision {
    const next = Math.min(this.options.max, Math.max(1, limit));
    const changed = next !== this.current;
    this.current = next;
    return { limit: next, changed, reason };
  }
}

/**
 * A counting gate around the worker loops. The engine can run a fixed pool of
 * loops and change how many of them may hold work at once, which is how the
 * controller raises and lowers concurrency without stopping transfers that are
 * already in progress.
 */
export class WorkGate {
  private active = 0;
  private limit: number;
  private waiters: Array<(open: boolean) => void> = [];

  constructor(limit: number) {
    this.limit = Math.max(1, limit);
  }

  get inFlight(): number {
    return this.active;
  }

  get width(): number {
    return this.limit;
  }

  /** Resolves false when `cancelled()` becomes true while waiting. */
  async acquire(cancelled?: () => boolean): Promise<boolean> {
    for (;;) {
      if (cancelled?.()) {
        return false;
      }
      if (this.active < this.limit) {
        this.active += 1;
        return true;
      }
      const open = await new Promise<boolean>((resolve) => {
        this.waiters.push(resolve);
      });
      if (!open) {
        return false;
      }
    }
  }

  release(): void {
    if (this.active > 0) {
      this.active -= 1;
    }
    this.wake(true);
  }

  setLimit(limit: number): void {
    this.limit = Math.max(1, limit);
    this.wake(true);
  }

  /** Wake everyone and let `acquire` report false; used when a job ends. */
  cancel(): void {
    this.wake(false);
  }

  private wake(open: boolean): void {
    for (const resolve of this.waiters.splice(0)) {
      resolve(open);
    }
  }
}
