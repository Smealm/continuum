/**
 * How many transfers to run at once, decided by what the connection actually
 * delivers instead of a fixed number.
 *
 * The controller aims at a rate, not at "is one more better than the last
 * sample". It remembers the best sustained goodput it has seen (and accepts a
 * rate measured by the engine's probe) and keeps adding workers while the job
 * is below a band around that peak. Only when the bandwidth is being pressed
 * does it hold: at that point extra connections would just split the same bytes
 * and make each game slower.
 *
 * That distinction matters for a smallest-first queue. A wall of 120 KB packs
 * cannot show the link's real ceiling, so a controller that only climbs on a 5%
 * improvement stops at two or four workers and leaves most of the connection
 * idle. Knowing the peak from a large transfer gives it something to aim for,
 * and the ramp doubles the width while it is far below, so the wall is behind
 * the job in seconds instead of minutes.
 *
 * Server failures still back it off hard, and the ceiling is the user's
 * configured maximum, so the archive never sees more than that from one client.
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

/** Within this fraction of the best rate seen, the link counts as pressed. */
const TARGET = 0.9;
/** A sample this much better than the best seen raises the peak. */
const IMPROVEMENT = 1.05;
/** Below half the peak, double the width instead of adding one. */
const FAST_RAMP = 0.5;
/** A sample this much worse than the peak at a wider width backs off at once. */
const REGRESSION = 0.85;
/** How many short samples in a row mean "the peak is stale, relearn". */
const RELEARN_SAMPLES = 3;

export class ConcurrencyController {
  private current: number;
  private bestGoodput: number | null = null;
  /**
   * Width that produced the best rate. Null when the peak came from a probe,
   * where the width that produced it is not known.
   */
  private peakWidth: number | null = null;
  private lowStreak = 0;
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

  /**
   * Accept a rate measured outside the download loop (the engine's probe of a
   * large pack). It becomes the target the worker count climbs towards.
   */
  observePeak(bytesPerSecond: number): void {
    if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) {
      return;
    }
    if (this.bestGoodput === null || bytesPerSecond > this.bestGoodput) {
      this.bestGoodput = bytesPerSecond;
      this.peakWidth = null;
      this.lowStreak = 0;
    }
  }

  sample(sample: ConcurrencySample): ConcurrencyDecision {
    const seconds = Math.max(0.001, sample.elapsedMs / 1000);
    const goodput = Math.max(0, sample.bytes) / seconds;

    if (sample.failures > 0) {
      this.lowStreak = 0;
      this.cooldownUntil = this.now() + (this.options.cooldownMs ?? 60_000);
      return this.apply(Math.max(1, Math.floor(this.current / 2)), 'failures; backing off');
    }

    if (this.now() < this.cooldownUntil) {
      return { limit: this.current, changed: false, reason: 'cooling down after failures' };
    }

    if (this.bestGoodput === null) {
      this.bestGoodput = goodput;
      this.peakWidth = this.current;
      this.lowStreak = 0;
      return { limit: this.current, changed: false, reason: 'learning the connection' };
    }

    if (goodput > this.bestGoodput * IMPROVEMENT) {
      this.bestGoodput = goodput;
      this.peakWidth = this.current;
      this.lowStreak = 0;
      if (this.current < this.options.max) {
        return this.apply(this.current + 1, 'throughput improved');
      }
      return { limit: this.current, changed: false, reason: 'at the ceiling' };
    }

    if (goodput >= this.bestGoodput * TARGET) {
      this.lowStreak = 0;
      return { limit: this.current, changed: false, reason: 'matching the measured peak' };
    }

    if (this.current >= this.options.max) {
      // The ceiling is already in use, so no extra worker can help.
      return this.maybeRelearn(goodput, 'at the ceiling');
    }

    if (this.peakWidth !== null && this.current > this.peakWidth) {
      // A connection beyond the width that produced the peak is not paying for
      // itself. Go back to that width instead of adding more of them.
      if (goodput < this.bestGoodput * REGRESSION) {
        this.lowStreak = 0;
        return this.apply(this.peakWidth, 'throughput fell');
      }
      return this.maybeRelearn(goodput, 'holding');
    }

    if (this.peakWidth !== null && this.current === this.peakWidth) {
      // This width already delivered the peak, so the shortfall is the link or
      // the server, not too few workers. Hold instead of thrashing, and lower
      // the target if the shortfall lasts.
      return this.maybeRelearn(goodput, 'holding');
    }

    // Below a peak measured at another width, or below a probe result: there is
    // headroom. Close a large gap in one step so a queue of small files does
    // not spend minutes ramping.
    this.lowStreak = 0;
    const next = goodput < this.bestGoodput * FAST_RAMP
      ? Math.min(this.options.max, this.current * 2)
      : this.current + 1;
    return this.apply(next, 'below the measured peak');
  }

  /** Hold, and after a run of short samples accept that the peak is stale. */
  private maybeRelearn(goodput: number, reason: string): ConcurrencyDecision {
    this.lowStreak += 1;
    if (this.lowStreak < RELEARN_SAMPLES) {
      return { limit: this.current, changed: false, reason };
    }
    this.bestGoodput = goodput;
    this.peakWidth = this.current;
    this.lowStreak = 0;
    return { limit: this.current, changed: false, reason: 'relearned the connection' };
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
