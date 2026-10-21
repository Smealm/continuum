import { JsonlCursor } from './jsonl';

export interface WindowItem<T> {
  value: T;
  /** Byte offset just past this record, for the "furthest read" marker. */
  offset: number;
  /** Byte offset where this record starts, for the resume cursor. */
  startOffset: number;
  /** Lower is handled first. */
  score: number;
  /** Original catalogue position, to keep ties in catalogue order. */
  sequence: number;
}

/**
 * A bounded look-ahead over the catalogue that hands out the cheapest game
 * first. It exists so a pass can follow shortest-remaining-first order without
 * loading 221k records or losing the byte cursor that makes a stop safe:
 *
 * - records are only read `size` at a time, so memory stays small;
 * - `earliestStartOffset` is the start of the first record still waiting, and
 *   the engine keeps the saved cursor at it, so a force close re-reads at most
 *   one window instead of skipping the games in it;
 * - a tie is broken by catalogue order, so the same catalogue always yields the
 *   same sequence.
 */
export class GameWindow<T> {
  private items: WindowItem<T>[] = [];
  private sequence = 0;
  private eof = false;
  private reachedOffset = 0;

  constructor(
    private readonly cursor: JsonlCursor<T>,
    private readonly size: number,
    private readonly score: (value: T) => number,
  ) {}

  get length(): number {
    return this.items.length;
  }

  /** Furthest byte read ahead, used once the window is empty. */
  get endOffset(): number {
    return this.reachedOffset;
  }

  get finished(): boolean {
    return this.eof && this.items.length === 0;
  }

  /** Start of the earliest record still waiting, or null when none is. */
  get earliestStartOffset(): number | null {
    let earliest: number | null = null;
    for (const item of this.items) {
      if (earliest === null || item.startOffset < earliest) {
        earliest = item.startOffset;
      }
    }
    return earliest;
  }

  /** Read ahead until the window is full or the catalogue ends. */
  async fill(): Promise<void> {
    while (!this.eof && this.items.length < Math.max(1, this.size)) {
      const next = await this.cursor.next();
      if (!next) {
        this.eof = true;
        return;
      }
      this.items.push({
        value: next.value,
        offset: next.offset,
        startOffset: next.startOffset,
        score: this.score(next.value),
        sequence: this.sequence,
      });
      this.sequence += 1;
      this.reachedOffset = next.offset;
    }
  }

  /** Remove and return the best item in the window, or null when it is empty. */
  take(): WindowItem<T> | null {
    if (this.items.length === 0) {
      return null;
    }
    let best = 0;
    for (let index = 1; index < this.items.length; index += 1) {
      const candidate = this.items[index];
      const current = this.items[best];
      if (candidate.score < current.score
        || (candidate.score === current.score && candidate.sequence < current.sequence)) {
        best = index;
      }
    }
    return this.items.splice(best, 1)[0];
  }
}
