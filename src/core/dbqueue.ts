import { Logger } from './types';

/**
 * Serialises database writes made by Continuum.
 *
 * The launcher shares one SQLite file with us and writes to it from its own
 * downloader, curation imports and the UI. Four mirror workers each saving a
 * `game_data` row was enough to produce "SQLite error: database is locked" on
 * roughly one pack per minute in the 2026-10-20 run, and every one of those was
 * counted as a failed download even though the file had arrived intact.
 *
 * The launcher solves the same problem with an EventQueue; this is the same
 * idea, plus a bounded exponential backoff for the times the launcher itself
 * holds the write lock.
 */
export interface DbWriteQueueOptions {
  log: Logger;
  /** Total tries per write, including the first. */
  attempts?: number;
  /** First backoff delay; doubles each try. */
  baseDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export function isSqliteLockError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /database is locked|database table is locked|SQLITE_BUSY/i.test(message);
}

export class DbWriteQueue {
  private chain: Promise<unknown> = Promise.resolve();
  private readonly attempts: number;
  private readonly baseDelayMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly options: DbWriteQueueOptions) {
    this.attempts = Math.max(1, options.attempts ?? 5);
    this.baseDelayMs = Math.max(1, options.baseDelayMs ?? 200);
    this.sleep = options.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /** Queue `work` behind every write already queued. Never runs two at once. */
  run<T>(label: string, work: () => Promise<T>): Promise<T> {
    const next = this.chain.then(() => this.withRetry(label, work));
    // Keep the chain alive after a failed write; the next one still runs.
    this.chain = next.then(() => undefined, () => undefined);
    return next;
  }

  private async withRetry<T>(label: string, work: () => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await work();
      } catch (error) {
        if (!isSqliteLockError(error) || attempt >= this.attempts) {
          if (isSqliteLockError(error)) {
            this.options.log.warn(
              `The launcher database stayed locked while writing ${label} (${attempt} attempts).`,
            );
          }
          throw error;
        }
        const delay = this.baseDelayMs * 2 ** (attempt - 1);
        this.options.log.debug(
          `The launcher database is locked while writing ${label}; retrying in ${delay} ms.`,
        );
        await this.sleep(delay);
      }
    }
  }
}
