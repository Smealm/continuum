import * as fs from 'fs';
import * as path from 'path';
import { Logger } from './types';

/** Leave recently started downloads alone; another process may be writing them. */
const STALE_PART_AGE_MS = 5 * 60_000;

/**
 * Remove leftover `<name>.zip.part` files from the data packs folder.
 *
 * `fetchToFile` deletes its part file on every error, so these only survive a
 * force close or a power loss. They are never used again (a retry re-creates and
 * truncates the part file) and can be several hundred MB each, so they are swept
 * at the start of a run. The age guard keeps a part file that the launcher or a
 * second Continuum process is still writing.
 */
export async function sweepPartFiles(
  dataPacksDir: string,
  options: { now?: number; maxAgeMs?: number; log?: Logger } = {},
): Promise<number> {
  const now = options.now ?? Date.now();
  const maxAgeMs = options.maxAgeMs ?? STALE_PART_AGE_MS;
  let removed = 0;

  let names: string[];
  try {
    names = await fs.promises.readdir(dataPacksDir);
  } catch {
    return 0;
  }

  for (const name of names) {
    if (!name.toLowerCase().endsWith('.part')) {
      continue;
    }
    const target = path.join(dataPacksDir, name);
    try {
      const stat = await fs.promises.stat(target);
      if (!stat.isFile() || now - stat.mtimeMs < maxAgeMs) {
        continue;
      }
      await fs.promises.unlink(target);
      removed += 1;
    } catch {
      // Already gone, or locked by another process; try again next run.
    }
  }

  if (removed > 0 && options.log) {
    options.log.info(`Removed ${removed} leftover partial download${removed === 1 ? '' : 's'}.`);
  }
  return removed;
}
