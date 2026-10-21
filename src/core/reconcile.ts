import * as fs from 'fs';
import * as path from 'path';
import { CatalogGameRecord, errorMessage } from './catalog';
import { gameDataFilename } from './format';
import { JsonlCursor, writeJsonAtomic } from './jsonl';
import { ChangedList, Logger } from './types';

/**
 * Keeping the mirror in step with the live archive.
 *
 * The catalogue is rebuilt from the launcher database, so there is no changelog
 * to keep: what should exist is whatever the database holds now. Two things
 * follow from that.
 *
 * 1. A rebuild can be compared with the catalogue it replaced, which tells the
 *    user what changed upstream (new games, removed games, changed packs).
 * 2. Files in the data-packs folder that no current pack uses are leftovers.
 *    They are found by reading the current catalogue and listing the folder,
 *    and are only ever removed after an explicit, confirmed action — never as
 *    part of a download or a rebuild.
 */

/** Files younger than this may be a launcher download we have not seen yet. */
export const ORPHAN_MIN_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Above this many changed games a full pass is cheaper than seeking to each
 * record, so no changed list is offered at all.
 */
export const MAX_CHANGED_ENTRIES = 5000;

/**
 * `Data/Games/<gameId>-<dateAddedMillis>.zip`. The game id may itself contain
 * dashes, so the timestamp is matched from the right.
 */
export const PACK_FILE = /^(.+)-(\d+)\.zip$/i;

export interface CatalogueDiff {
  /** Games the current catalogue has and the previous one did not. */
  newGames: number;
  /** Games the previous catalogue had and the current one does not. */
  removedGames: number;
  /** Packs of surviving games whose file name or hash changed. */
  updatedPacks: number;
  /** Pack rows that disappeared together with their game. */
  removedPacks: number;
  previousGames: number;
  currentGames: number;
  /** A few removed titles, for the report. */
  removedExamples: string[];
  /**
   * New games and games whose pack changed, with their offsets in the new
   * catalogue, so a later run can read only those records.
   */
  changed: { id: string; offset: number }[];
}

export interface DiffOptions {
  /** How many removed titles to include in `removedExamples`. */
  examples?: number;
  signal?: AbortSignal;
}

/**
 * Compare the catalogue a rebuild replaced with the new one.
 *
 * Returns null when there is no previous catalogue (first build, or a rebuild
 * that could not keep it). The current pack map holds one entry per pack, so
 * the memory cost is roughly the pack count (~200k entries on the reference
 * archive) only for the duration of the call.
 */
export async function diffCatalogues(
  previousFile: string,
  currentFile: string,
  options: DiffOptions = {},
): Promise<CatalogueDiff | null> {
  const exists = await fs.promises.stat(previousFile)
    .then((stat) => stat.isFile())
    .catch(() => false);
  if (!exists) {
    return null;
  }

  const examples = options.examples ?? 3;
  /** gameId -> byte offset in the new catalogue. */
  const currentIds = new Map<string, number>();
  /** filename -> sha256, to notice a pack that changed without its name changing. */
  const currentPacks = new Map<string, string>();
  let currentGames = 0;

  const current = new JsonlCursor<CatalogGameRecord>(currentFile);
  try {
    for (;;) {
      assertNotAborted(options.signal);
      const next = await current.next();
      if (!next) {
        break;
      }
      const game = next.value;
      currentGames += 1;
      currentIds.set(game.id, next.startOffset);
      for (const data of game.data) {
        const filename = packFilename(data);
        if (filename) {
          currentPacks.set(filename, data.sha256 || '');
        }
      }
    }
  } finally {
    await current.close().catch(() => undefined);
  }

  const previousIds = new Set<string>();
  let previousGames = 0;
  let matchedGames = 0;
  let removedGames = 0;
  let removedPacks = 0;
  let updatedPacks = 0;
  const removedExamples: string[] = [];
  /** Ids of surviving games with a changed pack; added to new games below. */
  const changedSurvivors = new Set<string>();

  const previous = new JsonlCursor<CatalogGameRecord>(previousFile);
  try {
    for (;;) {
      assertNotAborted(options.signal);
      const next = await previous.next();
      if (!next) {
        break;
      }
      const game = next.value;
      previousGames += 1;
      previousIds.add(game.id);
      const survives = currentIds.has(game.id);
      if (survives) {
        matchedGames += 1;
      } else {
        removedGames += 1;
        if (removedExamples.length < examples) {
          removedExamples.push(game.title || game.id);
        }
      }
      for (const data of game.data) {
        const filename = packFilename(data);
        if (!filename) {
          continue;
        }
        if (!survives) {
          removedPacks += 1;
          continue;
        }
        const currentSha = currentPacks.get(filename);
        if (currentSha === undefined || currentSha !== (data.sha256 || '')) {
          updatedPacks += 1;
          changedSurvivors.add(game.id);
        }
      }
    }
  } finally {
    await previous.close().catch(() => undefined);
  }

  const changed: { id: string; offset: number }[] = [];
  for (const [id, offset] of currentIds) {
    if (!previousIds.has(id)) {
      // New game.
      changed.push({ id, offset });
    }
  }
  for (const id of changedSurvivors) {
    const offset = currentIds.get(id);
    if (offset !== undefined) {
      changed.push({ id, offset });
    }
  }

  return {
    newGames: Math.max(0, currentGames - matchedGames),
    removedGames,
    updatedPacks,
    removedPacks,
    previousGames,
    currentGames,
    removedExamples,
    changed,
  };
}

/**
 * Write the list a later changed-only pass reads. Too many changes (or none)
 * means the list is removed, so the next run is an ordinary full pass.
 */
export async function writeChangedList(
  changedFile: string,
  generation: string,
  diff: CatalogueDiff,
): Promise<{ written: number; tooMany: boolean }> {
  if (diff.changed.length === 0 || diff.changed.length > MAX_CHANGED_ENTRIES) {
    await fs.promises.unlink(changedFile).catch(() => undefined);
    return { written: 0, tooMany: diff.changed.length > MAX_CHANGED_ENTRIES };
  }
  const list: ChangedList = {
    version: 1,
    generation,
    scannedAt: new Date().toISOString(),
    entries: diff.changed,
  };
  await writeJsonAtomic(changedFile, list);
  return { written: diff.changed.length, tooMany: false };
}

/** A one-paragraph summary for the rebuild dialog and the log. */
export function describeDiff(diff: CatalogueDiff | null): string {
  if (!diff) {
    return '';
  }
  const lines = [
    `Since the last build: ${count(diff.newGames)} new game(s), `
    + `${count(diff.removedGames)} removed upstream, ${count(diff.updatedPacks)} data pack(s) updated.`,
  ];
  if (diff.removedExamples.length > 0) {
    const more = diff.removedGames > diff.removedExamples.length
      ? ` and ${count(diff.removedGames - diff.removedExamples.length)} more`
      : '';
    lines.push(`Removed: ${diff.removedExamples.join(', ')}${more}.`);
  }
  if (diff.removedGames > 0) {
    lines.push('Clean up old game files can find and remove the files those games left behind.');
  }
  return lines.join('\n');
}

export interface OrphanPack {
  filename: string;
  bytes: number;
  /** The game is still in the catalogue; only its pack file changed. */
  superseded: boolean;
}

export interface OrphanScan {
  /** Unreferenced files of games that no longer exist upstream. */
  items: OrphanPack[];
  bytes: number;
  /** Older versions of games that still exist. Only removed when asked. */
  supersededItems: OrphanPack[];
  supersededBytes: number;
  /** Unreferenced files that are too young to touch. */
  tooNew: number;
  /** Entries that do not look like a data pack (other files, folders). */
  ignored: number;
}

export interface OrphanScanOptions {
  dataPacksDir: string;
  catalogFile: string;
  now?: number;
  minAgeMs?: number;
  /** Injected in tests. Defaults to Windows/macOS, whose file systems fold case. */
  caseInsensitive?: boolean;
  signal?: AbortSignal;
}

/**
 * List files in the data-packs folder that the current catalogue does not
 * reference. Nothing is deleted here.
 *
 * Guard rails, all applied before a file can be listed:
 * - only the configured data-packs folder, read with `readdir` (no recursion);
 * - only regular files whose name is `<gameId>-<millis>.zip`;
 * - only files older than `minAgeMs` (24 hours by default), so a launcher
 *   download Continuum has not seen yet is not treated as a leftover;
 * - never a name the catalogue still uses, compared case-insensitively where
 *   the file system does.
 */
export async function scanOrphanPacks(options: OrphanScanOptions): Promise<OrphanScan> {
  const now = options.now ?? Date.now();
  const minAgeMs = options.minAgeMs ?? ORPHAN_MIN_AGE_MS;
  const foldCase = options.caseInsensitive ?? foldsCase();
  const key = (name: string): string => (foldCase ? name.toLowerCase() : name);

  const referenced = new Set<string>();
  const games = new Set<string>();
  const cursor = new JsonlCursor<CatalogGameRecord>(options.catalogFile);
  try {
    for (;;) {
      assertNotAborted(options.signal);
      const next = await cursor.next();
      if (!next) {
        break;
      }
      games.add(key(next.value.id));
      for (const data of next.value.data) {
        const filename = packFilename(data);
        if (filename) {
          referenced.add(key(filename));
        }
      }
    }
  } finally {
    await cursor.close().catch(() => undefined);
  }

  const scan: OrphanScan = {
    items: [],
    bytes: 0,
    supersededItems: [],
    supersededBytes: 0,
    tooNew: 0,
    ignored: 0,
  };

  let names: string[];
  try {
    names = await fs.promises.readdir(options.dataPacksDir);
  } catch {
    return scan;
  }

  for (const name of names) {
    assertNotAborted(options.signal);
    const match = PACK_FILE.exec(name);
    if (!match) {
      scan.ignored += 1;
      continue;
    }
    const target = path.join(options.dataPacksDir, name);
    let stat: fs.Stats;
    try {
      stat = await fs.promises.stat(target);
    } catch {
      continue;
    }
    if (!stat.isFile()) {
      scan.ignored += 1;
      continue;
    }
    if (referenced.has(key(name))) {
      continue;
    }
    if (now - stat.mtimeMs < minAgeMs) {
      scan.tooNew += 1;
      continue;
    }
    const pack: OrphanPack = {
      filename: name,
      bytes: stat.size,
      superseded: games.has(key(match[1])),
    };
    if (pack.superseded) {
      scan.supersededItems.push(pack);
      scan.supersededBytes += pack.bytes;
    } else {
      scan.items.push(pack);
      scan.bytes += pack.bytes;
    }
  }

  scan.items.sort((a, b) => a.filename.localeCompare(b.filename));
  scan.supersededItems.sort((a, b) => a.filename.localeCompare(b.filename));
  return scan;
}

export interface DeleteResult {
  deleted: number;
  bytes: number;
  failed: { filename: string; error: string }[];
}

/**
 * Delete the listed files, one at a time. A file that cannot be removed
 * (locked, already gone, permission denied) is reported and the pass continues,
 * so one problem never hides the rest.
 */
export async function deletePacks(
  dataPacksDir: string,
  packs: { filename: string; bytes: number }[],
  options: { log?: Logger } = {},
): Promise<DeleteResult> {
  const result: DeleteResult = { deleted: 0, bytes: 0, failed: [] };
  for (const pack of packs) {
    const name = pack.filename;
    // Only a plain pack file name inside the folder; never a path.
    if (path.basename(name) !== name || !PACK_FILE.test(name)) {
      result.failed.push({ filename: name, error: 'Refused: not a data pack file name' });
      options.log?.warn(`Cleanup refused to delete ${name}: not a data pack file name.`);
      continue;
    }
    try {
      await fs.promises.unlink(path.join(dataPacksDir, name));
      result.deleted += 1;
      result.bytes += pack.bytes;
      options.log?.debug(`Cleanup deleted ${name} (${pack.bytes} bytes).`);
    } catch (error) {
      result.failed.push({ filename: name, error: errorMessage(error) });
      options.log?.warn(`Cleanup could not delete ${name}: ${errorMessage(error)}`);
    }
  }
  return result;
}

/** The pack file name for a catalogue row, or null when `dateAdded` is unusable. */
function packFilename(data: CatalogGameRecord['data'][number]): string | null {
  try {
    return gameDataFilename(data);
  } catch {
    return null;
  }
}

function foldsCase(): boolean {
  return process.platform === 'win32' || process.platform === 'darwin';
}

function count(value: number): string {
  return Math.round(value).toLocaleString('en-US');
}

function assertNotAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new Error('Cleanup cancelled');
  }
}
