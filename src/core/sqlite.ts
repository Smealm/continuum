import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { CATALOG_VERSION, CatalogDataRecord, CatalogGameRecord, CatalogMeta } from './catalog';
import { writeJsonAtomic } from './jsonl';
import { Logger } from './types';

/**
 * Fast catalogue build: reads the launcher database in one pass instead of
 * asking the launcher for every tag.
 *
 * The tag union has to hydrate a full Game object per tag link (about 830k
 * objects for 221k games), which takes hours. The same information is a few
 * SQL queries, so when the sqlite3 tool that ships with Flashpoint is present
 * we read it directly and assemble `catalog.jsonl` ourselves. Every failure
 * (no tool, unexpected schema, locked database) falls back to the tag scan.
 */

export interface FastScanProgress {
  /** 1-based stage number. */
  stage: number;
  stages: number;
  label: string;
  games: number;
  packs: number;
  /** 0..1 for the whole build. */
  percent: number;
}

export interface FastCatalogOptions {
  signal: AbortSignal;
  onProgress?: (progress: FastScanProgress) => void;
}

export interface FastCatalogDeps {
  dbPath: string;
  cliPath: string;
  catalogFile: string;
  catalogMetaFile: string;
  log: Logger;
  /** Injected in tests so a fake process can stand in for sqlite3. */
  spawnCli?: SpawnCli;
}

/** The slice of `child_process.ChildProcess` this module uses. */
export interface CliProcess {
  stdout: NodeJS.ReadableStream | null;
  stderr: NodeJS.ReadableStream | null;
  on(event: 'error', listener: (error: Error) => void): unknown;
  on(event: 'close', listener: (code: number | null) => void): unknown;
  kill(): boolean;
}

export type SpawnCli = (cliPath: string, args: string[]) => CliProcess;

const TABLES = [
  'game',
  'game_data',
  'game_tags_tag',
  'tag',
  'tag_alias',
  'platform',
  'platform_alias',
  'game_platforms_platform',
];

const STAGES = 5;

/**
 * One invocation, one database scan per statement. Every text column is
 * hex-encoded so titles with pipes, tabs, quotes or newlines cannot break the
 * row format (the CLI in the Flashpoint folder predates json1()).
 */
const QUERIES = [
  `SELECT 's', count(*) FROM sqlite_master WHERE type = 'table' AND name IN (${TABLES.map((table) => `'${table}'`).join(', ')});`,
  `SELECT 'n', count(*) FROM game;`,
  `SELECT 'T', t.id, hex(a.name) FROM tag t JOIN tag_alias a ON a.id = t.primaryAliasId;`,
  `SELECT 'P', p.id, hex(a.name) FROM platform p JOIN platform_alias a ON a.id = p.primaryAliasId;`,
  `SELECT 't', hex(gt.gameId), gt.tagId FROM game_tags_tag gt;`,
  `SELECT 'p', hex(gp.gameId), gp.platformId FROM game_platforms_platform gp;`,
  `SELECT 'd', hex(gameId), id, hex(ifnull(sha256, '')), size, hex(ifnull(dateAdded, '')), presentOnDisk, hex(ifnull(path, '')) FROM game_data;`,
  `SELECT 'g', hex(id), hex(ifnull(title, '')), hex(ifnull(library, '')), hex(ifnull(logoPath, '')), hex(ifnull(screenshotPath, '')) FROM game;`,
].join('\n');

export function decodeHex(value: string | undefined): string {
  if (!value) {
    return '';
  }
  return Buffer.from(value, 'hex').toString('utf8');
}

/** The tag union and the database read can both produce the catalogue. */
export function catalogSource(useFastPath: boolean, cliAvailable: boolean): 'database' | 'api' {
  return useFastPath && cliAvailable ? 'database' : 'api';
}

export class FastCatalog {
  private readonly spawnCli: SpawnCli;

  constructor(private readonly deps: FastCatalogDeps) {
    this.spawnCli = deps.spawnCli || ((cliPath, args) => spawn(cliPath, args, { windowsHide: true }));
  }

  /**
   * Locate the sqlite3 tool that ships with Flashpoint. Nothing is installed
   * or downloaded; when it is not there the caller uses the tag scan.
   */
  static findCli(flashpointRoot: string): string | null {
    const candidates = [
      path.join(flashpointRoot, 'Legacy', 'sqlite3.exe'),
      path.join(flashpointRoot, 'Legacy', 'sqlite3'),
      path.join(flashpointRoot, 'Utilities', 'sqlite3.exe'),
      path.join(flashpointRoot, 'sqlite3.exe'),
    ];
    for (const candidate of candidates) {
      try {
        if (fs.statSync(candidate).isFile()) {
          return candidate;
        }
      } catch {
        // Not there; try the next location.
      }
    }
    return null;
  }

  async scan(options: FastCatalogOptions): Promise<CatalogMeta> {
    const { dbPath, catalogFile, catalogMetaFile, log } = this.deps;

    const database = await fs.promises.stat(dbPath).catch(() => null);
    if (!database || !database.isFile()) {
      throw new Error(`No launcher database found at ${dbPath}`);
    }
    await fs.promises.mkdir(path.dirname(catalogFile), { recursive: true });

    const tempPath = `${catalogFile}.tmp`;
    const writer = createWriter(tempPath);

    const tagNames = new Map<string, string>();
    const platformNames = new Map<string, string>();
    const tagLinks = new Map<string, string[]>();
    const platformLinks = new Map<string, string[]>();
    const tagCounts = new Map<string, number>();
    const packs = new Map<string, CatalogDataRecord[]>();
    const expectedGames: { value: number } = { value: 0 };

    let games = 0;
    let packCount = 0;
    let packsMissing = 0;
    let bytesTotal = 0;
    let bytesMissing = 0;
    let images = 0;
    let stage = 1;
    let lastReport = 0;

    const report = (label: string, within = 0): void => {
      if (!options.onProgress) {
        return;
      }
      const percent = Math.min(1, (stage - 1 + within) / STAGES);
      options.onProgress({ stage, stages: STAGES, label, games, packs: packCount, percent });
    };

    const onRow = async (fields: string[]): Promise<void> => {
      const kind = fields[0];
      switch (kind) {
        case 's': {
          const found = Number(fields[1]);
          if (found < TABLES.length) {
            throw new Error(
              `The launcher database does not have the expected shape (${found} of ${TABLES.length} tables). `
              + 'Use the tag scan instead.',
            );
          }
          break;
        }
        case 'n':
          expectedGames.value = Number(fields[1]) || 0;
          stage = 1;
          report('Reading tags and platforms');
          break;
        case 'T':
          tagNames.set(fields[1], decodeHex(fields[2]));
          break;
        case 'P':
          platformNames.set(fields[1], decodeHex(fields[2]));
          break;
        case 't': {
          if (stage < 2) {
            stage = 2;
            report('Reading tag links');
          }
          const gameId = decodeHex(fields[1]);
          const name = tagNames.get(fields[2]);
          if (!gameId || !name) {
            break;
          }
          const list = tagLinks.get(gameId);
          if (list) {
            list.push(name);
          } else {
            tagLinks.set(gameId, [name]);
          }
          tagCounts.set(name, (tagCounts.get(name) || 0) + 1);
          break;
        }
        case 'p': {
          if (stage < 3) {
            stage = 3;
            report('Reading platform links');
          }
          const gameId = decodeHex(fields[1]);
          const name = platformNames.get(fields[2]);
          if (!gameId || !name) {
            break;
          }
          const list = platformLinks.get(gameId);
          if (list) {
            list.push(name);
          } else {
            platformLinks.set(gameId, [name]);
          }
          break;
        }
        case 'd': {
          if (stage < 4) {
            stage = 4;
            report('Reading data packs');
          }
          const gameId = decodeHex(fields[1]);
          if (!gameId) {
            break;
          }
          const record: CatalogDataRecord = {
            id: Number(fields[2]),
            gameId,
            sha256: decodeHex(fields[3]),
            size: Number(fields[4]) || 0,
            dateAdded: decodeHex(fields[5]),
            present: fields[6] === '1',
            path: decodeHex(fields[7]),
          };
          const list = packs.get(gameId);
          if (list) {
            list.push(record);
          } else {
            packs.set(gameId, [record]);
          }
          break;
        }
        case 'g': {
          if (stage < 5) {
            stage = 5;
            report('Reading games', 0);
          }
          const id = decodeHex(fields[1]);
          if (!id) {
            break;
          }
          const data = packs.get(id) || [];
          const record: CatalogGameRecord = {
            id,
            title: decodeHex(fields[2]),
            library: decodeHex(fields[3]),
            platforms: platformLinks.get(id) || [],
            tags: tagLinks.get(id) || [],
            logo: decodeHex(fields[4]),
            screenshot: decodeHex(fields[5]),
            data,
          };
          games += 1;
          packCount += data.length;
          for (const entry of data) {
            bytesTotal += entry.size;
            if (!entry.present) {
              packsMissing += 1;
              bytesMissing += entry.size;
            }
          }
          if (record.logo) {
            images += 1;
          }
          if (record.screenshot) {
            images += 1;
          }
          await writer.write(`${JSON.stringify(record)}\n`);
          // Release each game once it is written; the relation maps are read
          // before the game rows start, so nothing later needs them.
          tagLinks.delete(id);
          platformLinks.delete(id);
          packs.delete(id);
          if (games - lastReport >= 2000) {
            lastReport = games;
            report('Reading games', expectedGames.value > 0 ? games / expectedGames.value : 0);
          }
          break;
        }
        default:
          break;
      }
    };

    let child: CliProcess | null = null;
    const onAbort = (): void => {
      child?.kill();
    };

    try {
      if (options.signal.aborted) {
        throw new Error('Catalogue scan cancelled');
      }
      child = this.spawnCli(this.deps.cliPath, ['-readonly', dbPath, QUERIES]);
      options.signal.addEventListener('abort', onAbort, { once: true });
      await streamRows(child, onRow);
      await writer.end();

      if (options.signal.aborted) {
        throw new Error('Catalogue scan cancelled');
      }
      if (games === 0) {
        throw new Error('The launcher database returned no games; the previous catalogue was kept.');
      }

      await fs.promises.rename(tempPath, catalogFile);

      const scannedAt = new Date().toISOString();
      const ordered = Array.from(tagNames.values())
        .map((name) => ({ name, count: tagCounts.get(name) || 0 }))
        .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
        .map((entry) => entry.name);
      const meta: CatalogMeta = {
        version: CATALOG_VERSION,
        generation: `${Date.parse(scannedAt)}-${games}`,
        scannedAt,
        tagsTotal: tagNames.size,
        tagsScanned: tagNames.size,
        games,
        packs: packCount,
        packsMissing,
        bytesTotal,
        bytesMissing,
        images,
        complete: true,
        tagOrder: ordered,
        source: 'database',
      };
      await writeJsonAtomic(catalogMetaFile, meta);
      log.info(
        `Catalogue (database): ${meta.games} games, ${meta.packs} data packs (${meta.packsMissing} missing), `
        + `${meta.bytesMissing} bytes missing.`,
      );
      return meta;
    } catch (error) {
      child?.kill();
      await writer.abort();
      if (options.signal.aborted && !(error instanceof Error && /cancelled/i.test(error.message))) {
        throw new Error('Catalogue scan cancelled');
      }
      throw error;
    } finally {
      options.signal.removeEventListener('abort', onAbort);
      child = null;
    }
  }
}

interface RowWriter {
  write(line: string): Promise<void>;
  end(): Promise<void>;
  abort(): Promise<void>;
}

function createWriter(filePath: string): RowWriter {
  const out = fs.createWriteStream(filePath, { flags: 'w' });
  let writeError: Error | null = null;
  out.on('error', (error) => {
    writeError = error;
  });

  let ended = false;
  const end = async (): Promise<void> => {
    if (ended) {
      return;
    }
    ended = true;
    await new Promise<void>((resolve) => out.end(resolve));
  };

  return {
    write(line: string): Promise<void> {
      return new Promise<void>((resolve, reject) => {
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
    },
    end,
    async abort(): Promise<void> {
      await end().catch(() => undefined);
      await fs.promises.unlink(filePath).catch(() => undefined);
    },
  };
}

/**
 * Read stdout line by line, one chunk at a time, so a slow disk applies
 * backpressure to the child process instead of buffering the whole database
 * export in memory.
 */
function streamRows(child: CliProcess, onRow: (fields: string[]) => Promise<void>): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const stdout = child.stdout;
    if (!stdout) {
      reject(new Error('sqlite3 produced no output stream'));
      return;
    }

    let pending = '';
    let stderr = '';
    let settled = false;
    let queue: Promise<void> = Promise.resolve();
    let exitCode: number | null = null;
    let sourceDone = false;
    let drained = false;

    const fail = (error: Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      reject(error);
    };

    const settle = (): void => {
      if (settled || !drained || exitCode === null) {
        return;
      }
      settled = true;
      if (exitCode === 0) {
        resolve();
      } else {
        reject(new Error(`sqlite3 exited with code ${exitCode}${stderr ? `: ${stderr.trim()}` : ''}`));
      }
    };

    const schedule = (work: () => Promise<void>): void => {
      queue = queue.then(work).catch((error: unknown) => {
        fail(error instanceof Error ? error : new Error(String(error)));
      });
    };

    const takeLine = (line: string): Promise<void> => {
      const trimmed = line.endsWith('\r') ? line.slice(0, -1) : line;
      if (!trimmed) {
        return Promise.resolve();
      }
      return onRow(trimmed.split('|'));
    };

    const drainBuffer = (): void => {
      const lines = pending.split('\n');
      pending = lines.pop() || '';
      for (const line of lines) {
        schedule(() => takeLine(line));
      }
    };

    const finishSource = (): void => {
      if (sourceDone) {
        return;
      }
      sourceDone = true;
      // Whatever is left has no trailing newline.
      const tail = pending;
      pending = '';
      if (tail.trim()) {
        schedule(() => takeLine(tail));
      }
      void queue.then(() => {
        drained = true;
        settle();
      });
    };

    stdout.on('data', (chunk: Buffer | string) => {
      // One chunk at a time keeps the child from racing ahead of the writer.
      stdout.pause();
      pending += chunk.toString();
      drainBuffer();
      void queue.then(() => {
        if (!settled) {
          stdout.resume();
        }
      });
    });
    stdout.on('error', (error: Error) => fail(error));
    stdout.on('end', finishSource);
    // A killed process can close the pipe without ending it.
    stdout.on('close', finishSource);

    child.stderr?.on('data', (chunk: Buffer | string) => {
      if (stderr.length < 4000) {
        stderr += chunk.toString();
      }
    });
    child.on('error', (error) => fail(new Error(`Could not run sqlite3: ${error.message}`)));
    child.on('close', (code) => {
      exitCode = typeof code === 'number' ? code : 1;
      finishSource();
      settle();
    });
  });
}
