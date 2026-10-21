import * as fs from 'fs';
import * as path from 'path';
import type * as flashpoint from 'flashpoint-launcher';
import { readJson, writeJsonAtomic } from './jsonl';
import { Logger, ContinuumApi, Paths } from './types';

export const CATALOG_VERSION = 1;

export interface CatalogDataRecord {
  id: number;
  gameId: string;
  sha256: string;
  size: number;
  dateAdded: string;
  present: boolean;
  path?: string;
}

export interface CatalogGameRecord {
  id: string;
  title: string;
  library: string;
  platforms: string[];
  tags: string[];
  logo: string;
  screenshot: string;
  data: CatalogDataRecord[];
}

export interface CatalogMeta {
  version: number;
  generation: string;
  scannedAt: string;
  tagsTotal: number;
  tagsScanned: number;
  games: number;
  packs: number;
  packsMissing: number;
  bytesTotal: number;
  bytesMissing: number;
  images: number;
  complete: boolean;
  /** Tags sorted by how many new games they yielded, so rescans finish sooner. */
  tagOrder: string[];
  /** 'database' when the catalogue was read straight from the launcher database. */
  source?: 'api' | 'database';
}

export interface ScanProgress {
  tagsScanned: number;
  tagsTotal: number;
  games: number;
  expectedGames: number;
  packs: number;
}

export interface ScanOptions {
  signal: AbortSignal;
  onProgress?: (progress: ScanProgress) => void;
}

/** Convert a launcher Game into the compact shape we persist. */
export function slimGame(game: flashpoint.Game): CatalogGameRecord {
  return {
    id: game.id,
    title: game.title || '',
    library: game.library || '',
    platforms: Array.isArray(game.platforms) ? game.platforms : [],
    tags: Array.isArray(game.tags) ? game.tags : [],
    logo: game.logoPath || '',
    screenshot: game.screenshotPath || '',
    data: (game.gameData || []).map((data) => ({
      id: data.id,
      gameId: game.id,
      sha256: data.sha256 || '',
      size: Number(data.size) || 0,
      dateAdded: data.dateAdded,
      present: !!data.presentOnDisk,
      path: data.path,
    })),
  };
}

/**
 * Reads the whole game catalogue through the public extension API.
 *
 * The launcher does not expose "all games", but every game has at least one
 * tag (verified against a 221k game database) and `games.findGamesWithTag`
 * exists. Unioning every tag therefore yields the complete catalogue.
 */
export class Catalog {
  constructor(
    private readonly api: ContinuumApi,
    private readonly paths: Paths,
    private readonly log: Logger,
  ) {}

  async loadMeta(): Promise<CatalogMeta | null> {
    const meta = await readJson<CatalogMeta>(this.paths.catalogMetaFile);
    if (!meta || meta.version !== CATALOG_VERSION || !meta.complete) {
      return null;
    }
    return meta;
  }

  async scan(options: ScanOptions): Promise<CatalogMeta> {
    await fs.promises.mkdir(this.paths.stateDir, { recursive: true });
    const previous = await readJson<CatalogMeta>(this.paths.catalogMetaFile);
    const tempPath = `${this.paths.catalogFile}.tmp`;

    const allTags = await this.api.findTags();
    const tagNames = orderTags(
      unique(allTags.map((tag) => (tag.name || '').trim()).filter(Boolean)),
      previous?.tagOrder,
    );
    const expectedGames = await this.api.countGames();

    const seen = new Set<string>();
    const yields = new Map<string, number>();
    let packs = 0;
    let packsMissing = 0;
    let bytesTotal = 0;
    let bytesMissing = 0;
    let images = 0;
    let tagsScanned = 0;

    const out = fs.createWriteStream(tempPath, { flags: 'w' });
    let writeError: Error | null = null;
    out.on('error', (error) => {
      writeError = error;
    });

    const write = (line: string): Promise<void> =>
      new Promise<void>((resolve, reject) => {
        if (writeError) {
          reject(writeError);
          return;
        }
        if (out.write(line)) {
          resolve();
          return;
        }
        const onDrain = (): void => {
          out.removeListener('error', onError);
          resolve();
        };
        const onError = (error: Error): void => {
          out.removeListener('drain', onDrain);
          reject(error);
        };
        out.once('drain', onDrain);
        out.once('error', onError);
      });

    let streamEnded = false;
    const endStream = async (): Promise<void> => {
      if (streamEnded) {
        return;
      }
      streamEnded = true;
      await new Promise<void>((resolve) => out.end(resolve));
    };
    const cleanup = async (): Promise<void> => {
      await endStream();
      await fs.promises.unlink(tempPath).catch(() => undefined);
    };

    try {
      for (const tag of tagNames) {
        if (options.signal.aborted) {
          await cleanup();
          throw new Error('Catalogue scan cancelled');
        }

        let games: flashpoint.Game[];
        try {
          games = await this.api.findGamesWithTag(tag);
        } catch (error) {
          this.log.warn(`Catalogue: could not read tag "${tag}": ${errorMessage(error)}`);
          games = [];
        }

        let added = 0;
        for (const game of games) {
          if (!game || !game.id || seen.has(game.id)) {
            continue;
          }
          seen.add(game.id);
          added += 1;
          const record = slimGame(game);
          packs += record.data.length;
          for (const data of record.data) {
            bytesTotal += data.size;
            if (!data.present) {
              packsMissing += 1;
              bytesMissing += data.size;
            }
          }
          if (record.logo) images += 1;
          if (record.screenshot) images += 1;
          await write(`${JSON.stringify(record)}\n`);
        }
        yields.set(tag, added);
        tagsScanned += 1;

        if (options.onProgress) {
          options.onProgress({
            tagsScanned,
            tagsTotal: tagNames.length,
            games: seen.size,
            expectedGames,
            packs,
          });
        }

        // Every game has at least one tag, so once we have them all we are done.
        if (expectedGames > 0 && seen.size >= expectedGames) {
          break;
        }
      }

      await endStream();
      if (writeError) {
        throw writeError;
      }

      if (expectedGames > 0 && seen.size < expectedGames) {
        await cleanup();
        throw new Error(
          `Catalogue scan incomplete: found ${seen.size} of ${expectedGames} games. `
          + 'Some tag queries failed, so the previous catalogue was kept. Try again.',
        );
      }

      await keepPreviousCatalogue(this.paths.catalogFile, this.log);
      await fs.promises.rename(tempPath, this.paths.catalogFile);

      const scannedAt = new Date().toISOString();
      const meta: CatalogMeta = {
        version: CATALOG_VERSION,
        generation: `${Date.parse(scannedAt)}-${seen.size}`,
        scannedAt,
        tagsTotal: tagNames.length,
        tagsScanned,
        games: seen.size,
        packs,
        packsMissing,
        bytesTotal,
        bytesMissing,
        images,
        complete: true,
        tagOrder: Array.from(yields.entries())
          .sort((a, b) => b[1] - a[1])
          .map(([name]) => name)
          .concat(tagNames.filter((name) => !yields.has(name))),
        source: 'api',
      };
      await writeJsonAtomic(this.paths.catalogMetaFile, meta);

      this.log.info(
        `Catalogue: ${meta.games} games, ${meta.packs} data packs (${meta.packsMissing} missing), `
        + `${meta.bytesMissing} bytes missing.`,
      );
      return meta;
    } catch (error) {
      await cleanup();
      throw error;
    }
  }
}

/** Previous scan order first (highest yield), then the rest. */
export function orderTags(tags: string[], previousOrder?: string[]): string[] {
  if (!previousOrder || previousOrder.length === 0) {
    return tags;
  }
  const rank = new Map(previousOrder.map((name, index) => [name, index]));
  return [...tags].sort((a, b) => {
    const ra = rank.has(a) ? rank.get(a)! : Number.MAX_SAFE_INTEGER;
    const rb = rank.has(b) ? rank.get(b)! : Number.MAX_SAFE_INTEGER;
    return ra - rb || a.localeCompare(b);
  });
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values));
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function catalogPathFor(paths: Paths): string {
  return path.resolve(paths.catalogFile);
}

/** Where the catalogue that a rebuild replaces is kept, for the diff report. */
export function previousCatalogPath(catalogFile: string): string {
  const suffix = '.jsonl';
  return catalogFile.toLowerCase().endsWith(suffix)
    ? `${catalogFile.slice(0, catalogFile.length - suffix.length)}.previous.jsonl`
    : `${catalogFile}.previous`;
}

/**
 * Move the current catalogue aside before the new one is renamed into place.
 * The rebuild report reads it. Failing to keep it only costs that report, never
 * the rebuild itself, so a failure is logged and ignored; a missing file means
 * this is the first build and there is nothing to compare.
 */
export async function keepPreviousCatalogue(catalogFile: string, log?: Logger): Promise<boolean> {
  try {
    await fs.promises.rename(catalogFile, previousCatalogPath(catalogFile));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      log?.warn(`Could not keep the previous catalogue for the rebuild report: ${errorMessage(error)}`);
    }
    return false;
  }
}
