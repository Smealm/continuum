import { errorMessage } from './catalog';
import { HttpStatusError, isNotFound } from './download';
import { readJson, writeJsonAtomic } from './jsonl';

/**
 * Persisted retry queue for downloads that failed for a transient reason.
 *
 * Before this existed a failed pack was only retried when the whole catalogue
 * was walked again, which is hours, and a 404 was retried forever. Entries are
 * self-contained (filename, sha256, size) so a retry needs neither the
 * catalogue nor a new database read, and they survive restarts, catalogue
 * rebuilds and force closes.
 */

export const RETRY_VERSION = 1;

export type RetryKind = 'pack' | 'image';

export interface RetryEntry {
  /** `kind|gameId|target` - unique per file. */
  key: string;
  kind: RetryKind;
  gameId: string;
  title: string;
  /** Data pack id, when the entry is a pack. */
  packId?: number;
  /** Pack filename, or the image path below the images folder. */
  target: string;
  sha256?: string;
  size?: number;
  attempts: number;
  lastError: string;
  firstFailedAt: string;
  nextAttemptAt: string;
}

export interface RetryInput {
  kind: RetryKind;
  gameId: string;
  title: string;
  target: string;
  packId?: number;
  sha256?: string;
  size?: number;
}

interface RetryFile {
  version: number;
  updatedAt: string;
  entries: RetryEntry[];
}

/** 1 m, 5 m, 15 m, 1 h, 6 h, 24 h. */
const DELAYS_MS = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000, 6 * 60 * 60_000, 24 * 60 * 60_000];

/** Give up after this many attempts; the audit trail stays in failures.jsonl. */
export const MAX_RETRY_ATTEMPTS = 8;

export function retryKey(kind: RetryKind, gameId: string, target: string): string {
  return `${kind}|${gameId}|${target}`;
}

export function retryDelayMs(attempts: number): number {
  const index = Math.min(Math.max(attempts - 1, 0), DELAYS_MS.length - 1);
  return DELAYS_MS[index];
}

/**
 * A missing file on the mirror (404/410) or a wrong hash will not fix itself, so
 * it is not retried. 408 and 429 are timeouts and rate limits, which will.
 */
export function isPermanentFailure(error: unknown): boolean {
  if (error instanceof HttpStatusError || isNotFound(error)) {
    const status = (error as HttpStatusError).status;
    if (status === 408 || status === 429) {
      return false;
    }
    return status >= 400 && status < 500;
  }
  return /does not match/i.test(errorMessage(error));
}

export class RetryStore {
  private entries = new Map<string, RetryEntry>();
  /**
   * Writes are serialised: a launcher install event can call `forgetGame`
   * while the engine is saving a failure, and two saves share one temp file.
   */
  private saveChain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly filePath: string,
    private readonly now: () => number = Date.now,
  ) {}

  /** Read the saved queue. A missing or unreadable file starts empty. */
  async load(): Promise<void> {
    this.entries.clear();
    const saved = await readJson<RetryFile>(this.filePath).catch(() => null);
    if (!saved || saved.version !== RETRY_VERSION || !Array.isArray(saved.entries)) {
      return;
    }
    for (const entry of saved.entries) {
      if (entry && typeof entry.key === 'string' && entry.key) {
        this.entries.set(entry.key, entry);
      }
    }
  }

  count(): number {
    return this.entries.size;
  }

  all(): RetryEntry[] {
    return Array.from(this.entries.values());
  }

  /** Entries whose backoff has elapsed, oldest first. */
  due(now = this.now()): RetryEntry[] {
    return this.all()
      .filter((entry) => Date.parse(entry.nextAttemptAt) <= now)
      .sort((left, right) => Date.parse(left.nextAttemptAt) - Date.parse(right.nextAttemptAt));
  }

  /** Milliseconds until the next entry is due, or null when the queue is empty. */
  nextDueIn(now = this.now()): number | null {
    let soonest: number | null = null;
    for (const entry of this.entries.values()) {
      const at = Date.parse(entry.nextAttemptAt);
      if (!Number.isFinite(at)) {
        continue;
      }
      const wait = at - now;
      if (soonest === null || wait < soonest) {
        soonest = wait;
      }
    }
    return soonest;
  }

  /**
   * Record a failed attempt. Returns the entry that was kept, or null when the
   * failure is permanent and nothing will be retried. `minDelayMs` lets a
   * server's `Retry-After` push the next attempt later than our own backoff.
   */
  async recordFailure(
    input: RetryInput,
    error: unknown,
    options: { minDelayMs?: number } = {},
  ): Promise<RetryEntry | null> {
    const now = this.now();
    const key = retryKey(input.kind, input.gameId, input.target);
    const previous = this.entries.get(key);
    const attempts = (previous?.attempts ?? 0) + 1;
    if (isPermanentFailure(error) || attempts >= MAX_RETRY_ATTEMPTS) {
      if (this.entries.delete(key)) {
        await this.save();
      }
      return null;
    }
    const entry: RetryEntry = {
      key,
      kind: input.kind,
      gameId: input.gameId,
      title: input.title,
      packId: input.packId,
      target: input.target,
      sha256: input.sha256,
      size: input.size,
      attempts,
      lastError: errorMessage(error),
      firstFailedAt: previous?.firstFailedAt ?? new Date(now).toISOString(),
      nextAttemptAt: new Date(now + Math.max(retryDelayMs(attempts), options.minDelayMs ?? 0)).toISOString(),
    };
    this.entries.set(key, entry);
    await this.save();
    return entry;
  }

  /** Drop an entry because the file is now on disk. */
  async recordSuccess(kind: RetryKind, gameId: string, target: string): Promise<void> {
    if (this.entries.delete(retryKey(kind, gameId, target))) {
      await this.save();
    }
  }

  /** Forget an entry without counting it as a success or a failure. */
  async forget(key: string): Promise<void> {
    if (this.entries.delete(key)) {
      await this.save();
    }
  }

  /** Drop every queued retry for a game, e.g. because the launcher installed it. */
  async forgetGame(gameId: string): Promise<number> {
    let removed = 0;
    for (const [key, entry] of this.entries) {
      if (entry.gameId === gameId) {
        this.entries.delete(key);
        removed += 1;
      }
    }
    if (removed > 0) {
      await this.save();
    }
    return removed;
  }

  save(): Promise<void> {
    const run = this.saveChain.then(async () => {
      // Build the contents when the write actually runs, so a queued write
      // always persists the latest queue rather than an older snapshot.
      const file: RetryFile = {
        version: RETRY_VERSION,
        updatedAt: new Date(this.now()).toISOString(),
        entries: this.all(),
      };
      await writeJsonAtomic(this.filePath, file);
    });
    this.saveChain = run.catch(() => undefined);
    return run;
  }
}
