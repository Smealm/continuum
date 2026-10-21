import { CatalogGameRecord } from './catalog';
import { JsonlCursor } from './jsonl';

export interface OrderEntry {
  /** Byte offset of the game record in the catalogue. */
  offset: number;
  /** Bytes still missing for this game. Smaller games go first. */
  size: number;
}

/** Bytes of data packs this game still needs. */
export function remainingPackBytes(game: CatalogGameRecord): number {
  let total = 0;
  for (const data of game.data) {
    if (!data.present) {
      total += Number(data.size) || 0;
    }
  }
  return total;
}

/**
 * Read the catalogue once and return every game that is in scope, smallest
 * remaining first.
 *
 * This replaces the 500-record look-ahead window. The window only ever sorted
 * within the next 500 catalogue records, so once those were handed out the
 * ordering restarted from wherever the read cursor was: a worker could be given
 * a game of any size, and the tail of the queue was effectively in catalogue
 * order. Sizes are fixed for a catalogue generation, so one pass can sort the
 * whole thing exactly, and the result is deterministic — which is what makes a
 * saved position (an index into this list) safe to resume from.
 *
 * Games with nothing left to download are kept, with size 0, because their
 * logos and screenshots may still be missing.
 */
export async function buildDownloadOrder(
  catalogFile: string,
  matches: (game: CatalogGameRecord) => boolean,
): Promise<OrderEntry[]> {
  const cursor = new JsonlCursor<CatalogGameRecord>(catalogFile);
  const entries: OrderEntry[] = [];
  try {
    for (;;) {
      const next = await cursor.next();
      if (!next) {
        break;
      }
      if (!matches(next.value)) {
        continue;
      }
      entries.push({ offset: next.startOffset, size: remainingPackBytes(next.value) });
    }
  } finally {
    await cursor.close().catch(() => undefined);
  }
  entries.sort((a, b) => a.size - b.size || a.offset - b.offset);
  return entries;
}
