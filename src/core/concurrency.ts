/**
 * How many transfers to run at once, decided by what the connection actually
 * delivers instead of a fixed number.
 *
 * Two numbers drive it, because a download is limited by two different things.
 *
 * The first is the rate the probe measured on one large pack. That is what the
 * link does when it is pressed, and it is a floor under the goal: a self-sample
 * can raise the goal above it but never push it below it. A queue of 120 KB
 * packs is limited by requests per second, not by bandwidth, so its byte rate
 * says nothing about the connection — treating that rate as the new peak is how
 * a 10 MB/s link ended up pinned at 500 KB/s with no way back up.
 *
 * The second is completions per second (packs plus games). That is what a small
 * file queue can actually show: bytes per second stay flat while more
 * connections finish more games per second, and finishing more games is the
 * point. The width keeps growing while either measure improves, so a hundred
 * slow connections adding up to the whole link is a win, not a shortfall.
 *
 * The width stops growing when the probe's rate is reached, when it hits the
 * configured ceiling, or when a wider width is worse on both measures. Failures
 * still halve it with a cooldown, and the ceiling stays the user's maximum, so
 * the archive never sees more than that from one client.
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
  /**
   * Packs and games finished since the previous sample. Optional: a caller that
   * only has byte counts still works, and then only bytes decide.
   */
  packs?: number;
  games?: number;
}

export interface ConcurrencyDecision {
  limit: number;
  changed: boolean;
  reason: string;
}

/** Within this fraction of the best rate seen, the link counts as pressed. */
const TARGET = 0.9;
/** A sample this much better than the best seen counts as an improvement. */
const IMPROVEMENT = 1.05;
/** Below half the probed peak, double the width instead of adding one. */
const FAST_RAMP = 0.5;
/** A wider width that delivers this much less than the best backs off at once. */
const REGRESSION = 0.85;

export class ConcurrencyController {
  private current: number;
  /**
   * What the last probe measured, or null when nothing has been probed. A
   * self-sample may raise the goal above this, never lower the goal below it.
   */
  private probePeak: number | null = null;
  private bestGoodput: number | null = null;
  /** Best packs-plus-games per second seen, so a small-file wall can still win. */
  private bestCompletion = 0;
  /**
   * Width that produced the best result. Null until the first sample, and not
   * set by a probe, where the width that produced the rate is not known.
   */
  private peakWidth: number | null = null;
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
   * large pack). It is a measurement of the link, so the controller will not
   * stop below it just because the queue is full of tiny files. A newer probe
   * does replace an older one — including with a lower figure — because that is
   * a fresh measurement rather than the shape of the current queue.
   */
  observePeak(bytesPerSecond: number): void {
    if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) {
      return;
    }
    this.probePeak = bytesPerSecond;
  }

  sample(sample: ConcurrencySample): ConcurrencyDecision {
    const seconds = Math.max(0.001, sample.elapsedMs / 1000);
    const goodput = Math.max(0, sample.bytes) / seconds;
    const completionKnown = sample.packs !== undefined || sample.games !== undefined;
    const completion = completionKnown
      ? (Math.max(0, sample.packs ?? 0) + Math.max(0, sample.games ?? 0)) / seconds
      : 0;

    if (sample.failures > 0) {
      this.cooldownUntil = this.now() + (this.options.cooldownMs ?? 60_000);
      return this.apply(Math.max(1, Math.floor(this.current / 2)), 'failures; backing off');
    }

    if (this.now() < this.cooldownUntil) {
      return this.hold('cooling down after failures');
    }

    const first = this.bestGoodput === null;
    if (first) {
      this.bestGoodput = goodput;
      this.peakWidth = this.current;
      this.bestCompletion = completion;
    }

    const betterBytes = goodput > this.bestGoodput! * IMPROVEMENT;
    const betterCompletion = completionKnown && completion > this.bestCompletion * IMPROVEMENT;
    if (betterBytes) {
      this.bestGoodput = goodput;
      this.peakWidth = this.current;
    }
    if (betterCompletion) {
      this.bestCompletion = completion;
      this.peakWidth = this.current;
    }

    // The goal: what the probe measured, or the best this job has delivered.
    const target = Math.max(this.probePeak ?? 0, this.bestGoodput ?? 0);
    if (this.probePeak !== null && goodput >= target * TARGET && !betterCompletion) {
      return this.hold('matching the measured peak');
    }

    if (this.current >= this.options.max) {
      // No extra worker can help: the ceiling is already in use.
      return this.hold('at the ceiling');
    }

    if (this.probePeak !== null && goodput < this.probePeak * TARGET) {
      // The link has been measured faster than this, and the queue has not used
      // it. A wall of small files needs more connections, not a lower target,
      // so close a large gap in one step and a small one by one.
      const next = goodput < this.probePeak * FAST_RAMP
        ? Math.min(this.options.max, this.current * 2)
        : this.current + 1;
      return this.apply(next, 'below the measured peak');
    }

    if (betterBytes || betterCompletion) {
      return this.apply(
        this.current + 1,
        betterBytes ? 'throughput improved' : 'finishing more files',
      );
    }

    const peakWidth = this.peakWidth;
    if (peakWidth !== null
      && this.current > peakWidth
      && goodput < this.bestGoodput! * REGRESSION
      && (!completionKnown || completion <= this.bestCompletion)) {
      // A connection beyond the width that produced the best result is not
      // paying for itself on either measure. Go back to that width.
      return this.apply(peakWidth, 'throughput fell');
    }

    // Nothing improved and nothing regressed: hold where the last gain was
    // found. Unlike the old relearn, this leaves the goal alone, so a later
    // improvement (or a new probe) can still raise it.
    return this.hold(first ? 'learning the connection' : 'holding near the measured peak');
  }

  private hold(reason: string): ConcurrencyDecision {
    return { limit: this.current, changed: false, reason };
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
