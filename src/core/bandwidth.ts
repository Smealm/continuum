/**
 * How fast the connection actually goes, as opposed to how fast it has averaged
 * since the job started.
 *
 * The old ETA divided the remaining bytes by the job's lifetime average byte
 * rate. With smallest-first ordering that average is set by the first minutes,
 * when thousands of tiny packs are limited by request latency rather than by
 * the link, so the estimate was hours too long: it assumed the whole archive
 * would arrive at the speed of the small-file wall. The link is in fact much
 * faster once a large pack is in flight.
 *
 * So the meter keeps the best *sustained* rate seen, and the ETA applies that
 * to the remaining bytes. It also keeps the best pack and game completion
 * rates, because a queue of tiny games can be limited by how many of them
 * finish per second even when their bytes are cheap.
 *
 * A three second sample is used so a single burst (a file served from a cache,
 * a brief window of extra bandwidth) cannot raise the estimate on its own. If
 * the link stays at less than half the peak for five minutes, the peak is
 * lowered: the connection changed, and the old number is no longer honest.
 *
 * One exception: a peak measured by the probe is not lowered that way. A queue
 * of 120 KB packs delivers very little per second no matter how fast the link
 * is, so five minutes of it is not evidence that the connection got slower.
 * The probed rate stays the ETA's upper bound until a newer probe replaces it,
 * which the engine runs at the start of a job and at most once an hour.
 */

export interface RateSnapshot {
  /** Bytes per second over the most recent sample, or 0 before the first one. */
  currentBytesPerSecond: number;
  /** Best sustained byte rate seen, 0 when nothing has been measured yet. */
  peakBytesPerSecond: number;
  /** Best sustained pack completion rate seen. */
  peakPacksPerSecond: number;
  /** Best sustained game completion rate seen. */
  peakGamesPerSecond: number;
}

/** A sample has to cover this much time to count as sustained. */
const SAMPLE_MS = 3000;
/** Samples below this fraction of the peak count as a slow phase. */
const SLOW_FRACTION = 0.5;
/** After this many slow samples in a row (five minutes), lower the peak. */
const SLOW_SAMPLES = 100;

interface RateWindow {
  bytes: number;
  packs: number;
  games: number;
  elapsedMs: number;
  at: number;
}

export class BandwidthMeter {
  private pending = { bytes: 0, packs: 0, games: 0, elapsedMs: 0 };
  private last: RateWindow | null = null;
  private peak = 0;
  /** Rate from the last probe; the slow-phase relearn cannot fall below it. */
  private probedPeak = 0;
  private packPeak = 0;
  private gamePeak = 0;
  private slowSamples = 0;

  reset(): void {
    this.pending = { bytes: 0, packs: 0, games: 0, elapsedMs: 0 };
    this.last = null;
    this.peak = 0;
    this.probedPeak = 0;
    this.packPeak = 0;
    this.gamePeak = 0;
    this.slowSamples = 0;
  }

  /** Account for bytes, packs and games finished since the previous sample. */
  observeWindow(
    bytes: number,
    packs: number,
    games: number,
    elapsedMs: number,
    at: number,
  ): void {
    if (!Number.isFinite(bytes)
      || !Number.isFinite(packs)
      || !Number.isFinite(games)
      || !(elapsedMs > 0)) {
      return;
    }
    this.pending.bytes += Math.max(0, bytes);
    this.pending.packs += Math.max(0, packs);
    this.pending.games += Math.max(0, games);
    this.pending.elapsedMs += elapsedMs;
    if (this.pending.elapsedMs < SAMPLE_MS) {
      return;
    }

    const sample: RateWindow = { ...this.pending, at };
    this.pending = { bytes: 0, packs: 0, games: 0, elapsedMs: 0 };
    this.last = sample;

    const seconds = sample.elapsedMs / 1000;
    const bytesPerSecond = sample.bytes / seconds;
    const packsPerSecond = sample.packs / seconds;
    const gamesPerSecond = sample.games / seconds;
    if (packsPerSecond > this.packPeak) {
      this.packPeak = packsPerSecond;
    }
    if (gamesPerSecond > this.gamePeak) {
      this.gamePeak = gamesPerSecond;
    }

    if (bytesPerSecond > this.peak) {
      this.peak = bytesPerSecond;
      this.slowSamples = 0;
      return;
    }
    if (this.peak > 0 && bytesPerSecond < this.peak * SLOW_FRACTION) {
      this.slowSamples += 1;
      if (this.slowSamples >= SLOW_SAMPLES) {
        // The connection really is slower now; do not keep promising the old
        // peak for the rest of the job. A probed rate is exempt: tiny files are
        // not proof the link changed, and a new probe is the honest way to
        // lower it.
        this.peak = Math.max(bytesPerSecond, this.peak / 2, this.probedPeak);
        this.slowSamples = 0;
      }
      return;
    }
    this.slowSamples = 0;
  }

  /**
   * Record a rate measured outside the normal download stream. The engine's
   * speed probe uses this: one large transfer, watched until it plateaus, is a
   * direct measurement of what the link can do when it is pressed.
   *
   * It becomes a floor for the rest of the session, so a wall of small files
   * cannot halve the ETA's rate every five minutes. A newer probe replaces it,
   * even with a lower figure: that is a fresh look at the connection.
   */
  observePeak(bytesPerSecond: number): void {
    if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) {
      return;
    }
    this.probedPeak = bytesPerSecond;
    this.peak = Math.max(this.peak, bytesPerSecond);
    this.slowSamples = 0;
  }

  snapshot(): RateSnapshot {
    return {
      currentBytesPerSecond: this.last ? this.last.bytes / (this.last.elapsedMs / 1000) : 0,
      peakBytesPerSecond: this.peak,
      peakPacksPerSecond: this.packPeak,
      peakGamesPerSecond: this.gamePeak,
    };
  }
}
