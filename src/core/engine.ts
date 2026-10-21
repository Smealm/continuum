import * as fs from 'fs';
import * as path from 'path';
import { Catalog, CatalogDataRecord, CatalogGameRecord, CatalogMeta, errorMessage } from './catalog';
import { getFreeBytes } from './disk';
import { fetchToFile, isNotFound } from './download';
import { formatBytes, formatCount, formatPercent, gameDataFilename, joinUrl } from './format';
import { JsonlCursor, appendJsonl, readJson, writeJsonAtomic } from './jsonl';
import { matchesScope, scopeKey, ScopeFilter } from './scope';
import { ContinuumApi, EngineMode, JobState, JobStatus, Logger, Paths, Settings } from './types';

/** Rough size of one cached logo/screenshot; only used for estimates before a run. */
export const IMAGE_ESTIMATE_BYTES = 150 * 1024;

export interface ProgressSink {
  createTask(name: string): string | null;
  updateTask(taskId: string, update: { status?: string; progress?: number; finished?: boolean; error?: string }): void;
  notify(message: string, level: 'info' | 'warn' | 'error'): void;
}

export interface EngineDeps {
  api: ContinuumApi;
  paths: Paths;
  log: Logger;
  sink: ProgressSink;
  /** Injected for tests; defaults to the OS probe. */
  probeFree?: (target: string) => Promise<{ freeBytes: number } | null>;
  now?: () => number;
}

export interface Estimate {
  gamesInScope: number;
  packsMissing: number;
  packBytes: number;
  imageEstimateBytes: number;
  totalBytes: number;
}

export interface Preparation {
  settings: Settings;
  meta: CatalogMeta;
  filter: ScopeFilter;
  estimate: Estimate;
  freeBytes: number | null;
  /** null when free space is unknown. */
  fits: boolean | null;
  warnings: string[];
  job: JobState;
  resumable: boolean;
}

export interface LiveProgress {
  gameId: string;
  gameTitle: string;
  received: number;
  total: number | null;
  bytesPerSecond: number;
}

export interface EngineSnapshot {
  status: JobStatus;
  message: string;
  mode: EngineMode | null;
  job: JobState | null;
  meta: CatalogMeta | null;
  live: LiveProgress | null;
  settings: Settings | null;
  progress: { sessionBytes: number; estimateBytes: number; percent: number };
  startedAt: number | null;
}

interface StartResult {
  ok: boolean;
  reason?: string;
}

const PERSIST_INTERVAL_MS = 2000;
const TASK_INTERVAL_MS = 1000;

export class Engine {
  private state: JobStatus = 'idle';
  private message = '';
  private job: JobState | null = null;
  private meta: CatalogMeta | null = null;
  private settings: Settings | null = null;
  private filter: ScopeFilter | null = null;
  private estimate: Estimate | null = null;

  private running = false;
  private pauseRequested = false;
  private stopRequested = false;
  private abort: AbortController | null = null;

  private taskId: string | null = null;
  private lastPersist = 0;
  private lastTaskUpdate = 0;
  private lowDiskNotified = false;
  private idleWaiters: (() => void)[] = [];

  private live: LiveProgress | null = null;
  private liveStartedAt = 0;
  private sessionStartBytes = 0;
  private inflightStarts = new Set<number>();
  private maxReadOffset = 0;
  private sessionStartedAt: number | null = null;
  private inflightBytes = 0;
  private readChain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly deps: EngineDeps,
    private readonly catalog: Catalog,
  ) {}

  snapshot(): EngineSnapshot {
    const sessionBytes = this.job ? Math.max(0, this.job.bytes - this.sessionStartBytes) : 0;
    const estimateBytes = this.estimate?.totalBytes ?? 0;
    const percent = this.state === 'done'
      ? 1
      : estimateBytes > 0
        ? Math.min(1, sessionBytes / estimateBytes)
        : 0;
    return {
      status: this.state,
      message: this.message,
      mode: this.settings?.mode ?? null,
      job: this.job ? { ...this.job } : null,
      meta: this.meta,
      live: this.live ? { ...this.live } : null,
      settings: this.settings,
      progress: { sessionBytes, estimateBytes, percent },
      startedAt: this.sessionStartedAt,
    };
  }

  isRunning(): boolean {
    return this.running;
  }

  whenIdle(): Promise<void> {
    if (!this.running) {
      return Promise.resolve();
    }
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  private async resolveFilter(settings: Settings): Promise<ScopeFilter> {
    const prefs = this.deps.api.getPreferences();
    const extremeTags = (prefs.tagFilters || [])
      .filter((group) => group.extreme)
      .reduce<string[]>((tags, group) => tags.concat(group.tags || []), []);
    const filter: ScopeFilter = {
      scope: settings.scope,
      extremeTags,
      excludeExtreme: settings.respectExtremeFilter && !!prefs.disableExtremeGames,
    };
    if (settings.scope.kind === 'playlist') {
      try {
        const playlist = await this.deps.api.findPlaylistByName(settings.scope.value, true);
        filter.playlistIds = new Set((playlist?.games || []).map((game) => game.gameId));
      } catch {
        filter.playlistIds = new Set();
      }
    }
    return filter;
  }

  async prepare(settings: Settings): Promise<Preparation> {
    const meta = await this.catalog.loadMeta();
    if (!meta) {
      throw new Error('No catalogue yet. Rebuild the catalogue first.');
    }
    const filter = await this.resolveFilter(settings);
    const estimate = await this.computeEstimate(filter, settings);
    const free = await this.probeFree();
    const reserve = settings.reserveBytes;
    const fits = free === null ? null : free.freeBytes - reserve >= estimate.totalBytes;

    const warnings: string[] = [];
    if (settings.scope.kind === 'playlist' && (!filter.playlistIds || filter.playlistIds.size === 0)) {
      warnings.push(`No playlist named "${settings.scope.value}" was found, so nothing would be downloaded.`);
    }
    if (estimate.gamesInScope === 0) {
      warnings.push('Nothing matches the current scope.');
    }
    if (free === null) {
      warnings.push('Free disk space could not be read on this system, so the disk guard cannot run.');
    } else if (fits === false) {
      warnings.push(
        `This job needs approximately ${formatBytes(estimate.totalBytes)}, but only ${formatBytes(free.freeBytes)} is free `
        + `(keeping ${formatBytes(reserve)} in reserve). Continuum will pause when the drive gets low.`,
      );
    }

    const key = scopeKey(settings.scope, settings.includeImages);
    const saved = await readJson<JobState>(this.deps.paths.jobFile);
    const resumable = !!saved
      && saved.version === 1
      && saved.generation === meta.generation
      && saved.scopeKey === key;
    const job = resumable && saved ? { ...saved } : this.newJob(meta, key, settings);

    return {
      settings,
      meta,
      filter,
      estimate,
      freeBytes: free?.freeBytes ?? null,
      fits,
      warnings,
      job,
      resumable: resumable && !!saved && saved.cursor > 0,
    };
  }

  private async computeEstimate(filter: ScopeFilter, settings: Settings): Promise<Estimate> {
    const cursor = new JsonlCursor<CatalogGameRecord>(this.deps.paths.catalogFile);
    let gamesInScope = 0;
    let packsMissing = 0;
    let packBytes = 0;
    try {
      for (;;) {
        const next = await cursor.next();
        if (!next) {
          break;
        }
        const game = next.value;
        if (!matchesScope(game, filter)) {
          continue;
        }
        gamesInScope += 1;
        for (const data of game.data) {
          if (!data.present) {
            packsMissing += 1;
            packBytes += data.size;
          }
        }
      }
    } finally {
      await cursor.close();
    }
    const imageEstimateBytes = settings.includeImages ? gamesInScope * 2 * IMAGE_ESTIMATE_BYTES : 0;
    return {
      gamesInScope,
      packsMissing,
      packBytes,
      imageEstimateBytes,
      totalBytes: packBytes + imageEstimateBytes,
    };
  }

  private newJob(meta: CatalogMeta, key: string, settings: Settings): JobState {
    return {
      version: 1,
      generation: meta.generation,
      scopeKey: key,
      mode: settings.mode,
      cursor: 0,
      bytes: 0,
      packsDone: 0,
      packsFailed: 0,
      gamesDone: 0,
      gamesFailed: 0,
      imagesDone: 0,
      status: 'idle',
      message: `Ready (${settings.mode})`,
      updatedAt: new Date(this.now()).toISOString(),
    };
  }

  /** Begin a job. Returns immediately; use whenIdle() to await completion. */
  async start(prep: Preparation): Promise<StartResult> {
    if (this.running) {
      return { ok: false, reason: 'Continuum is already downloading.' };
    }
    const size = await fs.promises.stat(this.deps.paths.catalogFile)
      .then((stat) => stat.size)
      .catch(() => 0);
    if (size === 0) {
      return { ok: false, reason: 'The catalogue is empty. Rebuild it first.' };
    }

    this.running = true;
    this.state = 'running';
    this.settings = prep.settings;
    this.meta = prep.meta;
    this.filter = prep.filter;
    this.estimate = prep.estimate;
    this.job = prep.job;
    this.pauseRequested = false;
    this.stopRequested = false;
    this.lowDiskNotified = false;
    this.message = '';
    this.abort = new AbortController();
    this.live = null;
    this.inflightBytes = 0;
    this.sessionStartBytes = this.job.bytes;
    this.inflightStarts.clear();
    this.maxReadOffset = this.job.cursor;
    this.sessionStartedAt = this.now();

    this.job.mode = prep.settings.mode;
    this.job.status = 'running';
    this.job.message = prep.settings.mode === 'active' ? 'Downloading (active)' : 'Downloading (passive)';
    if (this.job.cursor >= size) {
      // Previous pass reached the end; this is a fresh pass over the same catalogue.
      this.job.cursor = 0;
    }

    this.taskId = this.deps.sink.createTask(`Continuum mirror (${prep.settings.mode})`);
    this.lastPersist = 0;
    this.lastTaskUpdate = 0;
    void this.runJob(prep, size);
    return { ok: true };
  }

  pause(): boolean {
    if (!this.running) {
      return false;
    }
    this.pauseRequested = true;
    return true;
  }

  stop(): boolean {
    if (!this.running) {
      return false;
    }
    this.stopRequested = true;
    this.state = 'stopped';
    this.abort?.abort();
    return true;
  }

  private async runJob(prep: Preparation, catalogSize: number): Promise<void> {
    const { settings } = prep;
    const job = this.job!;
    let cursor: JsonlCursor<CatalogGameRecord> | null = null;
    try {
      cursor = new JsonlCursor<CatalogGameRecord>(this.deps.paths.catalogFile, Math.min(job.cursor, catalogSize));
      this.readChain = Promise.resolve();
      const workers = Math.max(1, settings.mode === 'active'
        ? Math.min(8, settings.activeWorkers || 4)
        : Math.min(2, settings.passiveWorkers || 1));
      this.deps.log.info(
        `Starting ${settings.mode} job with ${workers} worker(s); resuming at byte ${job.cursor}.`,
      );
      const tasks: Promise<void>[] = [];
      for (let i = 0; i < workers; i += 1) {
        tasks.push(this.worker(cursor, prep));
      }
      await Promise.all(tasks);
      job.cursor = this.currentCursor();

      if (this.stopRequested) {
        job.status = 'stopped';
        job.message = this.message || 'Stopped. Progress was saved.';
      } else if (this.pauseRequested) {
        job.status = 'paused';
        job.message = this.message || 'Paused. Progress was saved.';
      } else {
        job.status = 'done';
        job.message = `Finished this pass: ${formatCount(job.packsDone)} packs (${formatBytes(job.bytes)}), `
          + `${formatCount(job.packsFailed)} failures.`;
        if (job.cursor >= catalogSize) {
          job.cursor = 0;
          job.message += ' Run again to check for anything new.';
        }
      }
    } catch (error) {
      job.status = 'error';
      job.message = errorMessage(error);
      this.deps.log.error(`Job failed: ${job.message}`);
    } finally {
      this.state = job.status;
      this.message = job.message;
      this.running = false;
      this.live = null;
      this.inflightBytes = 0;
      if (cursor) {
        await cursor.close().catch(() => undefined);
      }
      await this.persist(true).catch(() => undefined);
      this.finishTask(job);
      const waiters = this.idleWaiters;
      this.idleWaiters = [];
      for (const resolve of waiters) {
        resolve();
      }
    }
  }

  private async worker(cursor: JsonlCursor<CatalogGameRecord>, prep: Preparation): Promise<void> {
    const { settings } = prep;
    for (;;) {
      if (this.stopRequested || this.pauseRequested) {
        return;
      }
      const next = await this.nextRecord(cursor);
      if (!next) {
        return;
      }
      const job = this.job!;
      this.maxReadOffset = Math.max(this.maxReadOffset, next.offset);
      // Keep the cursor at the first game still in flight, so an interrupted
      // game is retried instead of skipped on the next run.
      this.inflightStarts.add(next.startOffset);

      try {
        const game = next.value;
        if (!matchesScope(game, prep.filter)) {
          continue;
        }

        const outcome = await this.processGame(game, prep);
        if (outcome === 'stop') {
          return;
        }
        if (outcome === 'pause') {
          this.pauseRequested = true;
          return;
        }

        this.updateTask(job, prep);
        if (settings.mode === 'passive' && settings.passiveDelayMs > 0) {
          await sleep(settings.passiveDelayMs);
        }
      } finally {
        this.inflightStarts.delete(next.startOffset);
        await this.persist();
      }

      if (this.stopRequested || this.pauseRequested) {
        return;
      }
    }
  }

  private currentCursor(): number {
    if (this.inflightStarts.size > 0) {
      return Math.min(...this.inflightStarts);
    }
    return this.maxReadOffset;
  }

  private nextRecord(cursor: JsonlCursor<CatalogGameRecord>): Promise<{ value: CatalogGameRecord; offset: number; startOffset: number } | null> {
    const run = this.readChain.then(() => cursor.next());
    this.readChain = run.catch(() => undefined);
    return run;
  }

  /** Returns 'continue', 'pause' or 'stop' depending on why the game loop ended. */
  private async processGame(game: CatalogGameRecord, prep: Preparation): Promise<'continue' | 'pause' | 'stop'> {
    const job = this.job!;
    const { settings } = prep;
    const sources = this.sources();
    let hadWork = false;
    let packAttempts = 0;
    let packFailures = 0;

    if (settings.includeImages) {
      for (const subPath of [game.logo, game.screenshot]) {
        if (!subPath) {
          continue;
        }
        const target = safeJoin(this.deps.paths.imagesDir, subPath);
        if (!target || await existsNonEmpty(target)) {
          continue;
        }
        hadWork = true;
        if (!(await this.ensureReserve(IMAGE_ESTIMATE_BYTES))) {
          return this.stopRequested ? 'stop' : 'pause';
        }
        try {
          await this.downloadImage(game, subPath, target);
          job.imagesDone += 1;
        } catch (error) {
          if (this.abort?.signal.aborted) {
            return this.stopRequested ? 'stop' : 'pause';
          }
          await this.recordFailure({
            kind: 'image',
            gameId: game.id,
            gameTitle: game.title,
            path: subPath,
            error: errorMessage(error),
          });
          this.deps.log.debug(`Image failed (${game.id}/${subPath}): ${errorMessage(error)}`);
        } finally {
          this.inflightBytes = Math.max(0, this.inflightBytes - IMAGE_ESTIMATE_BYTES);
        }
      }
    }

    for (const data of game.data) {
      if (this.stopRequested || this.pauseRequested) {
        return this.stopRequested ? 'stop' : 'pause';
      }
      let filename: string;
      try {
        filename = gameDataFilename(data);
      } catch (error) {
        await this.recordFailure({
          kind: 'pack',
          gameId: game.id,
          gameTitle: game.title,
          packId: data.id,
          error: errorMessage(error),
        });
        continue;
      }
      const target = path.join(this.deps.paths.dataPacksDir, filename);

      if (await existsNonEmpty(target)) {
        if (!data.present) {
          hadWork = true;
          await this.repairPackFlags(game.id, data.id, filename);
        }
        continue;
      }

      hadWork = true;
      packAttempts += 1;
      if (!(await this.allowMoreBytes(data.size, prep))) {
        return this.stopRequested ? 'stop' : 'pause';
      }

      try {
        const bytes = await this.downloadPack(game, data, filename, sources, prep);
        job.packsDone += 1;
        job.bytes += bytes;
        this.inflightBytes = Math.max(0, this.inflightBytes - data.size);
        await this.persistPackFlags(game.id, data.id, filename);
      } catch (error) {
        this.inflightBytes = Math.max(0, this.inflightBytes - data.size);
        if (this.abort?.signal.aborted) {
          return this.stopRequested ? 'stop' : 'pause';
        }
        packFailures += 1;
        job.packsFailed += 1;
        await this.recordFailure({
          kind: 'pack',
          gameId: game.id,
          gameTitle: game.title,
          packId: data.id,
          url: filename,
          error: errorMessage(error),
        });
        this.deps.log.warn(`Pack failed (${filename}): ${errorMessage(error)}`);
      }
      this.updateTask(job, prep);
    }

    if (hadWork) {
      job.gamesDone += 1;
    }
    if (packAttempts > 0 && packFailures === packAttempts) {
      job.gamesFailed += 1;
    }
    return 'continue';
  }

  private async allowMoreBytes(size: number, prep: Preparation): Promise<boolean> {
    const job = this.job!;
    const { settings } = prep;
    if (settings.maxBytes > 0 && job.bytes + size > settings.maxBytes) {
      this.message = `Reached the ${formatBytes(settings.maxBytes)} job limit.`;
      this.stopRequested = true;
      return false;
    }
    return this.ensureReserve(size);
  }

  /** Refuse to start a transfer that would eat into the reserved free space. */
  private async ensureReserve(size: number): Promise<boolean> {
    const settings = this.settings;
    if (!settings) {
      return true;
    }
    const free = await this.probeFree();
    if (free === null) {
      return true;
    }
    const needed = size + this.inflightBytes;
    if (free.freeBytes - needed < settings.reserveBytes) {
      this.message = `Paused: only ${formatBytes(free.freeBytes)} free (reserve ${formatBytes(settings.reserveBytes)}). `
        + `Free up space and resume, or lower the reserve.`;
      this.pauseRequested = true;
      if (!this.lowDiskNotified) {
        this.lowDiskNotified = true;
        this.deps.sink.notify(this.message, 'warn');
        this.deps.log.warn(this.message);
      }
      return false;
    }
    this.inflightBytes += size;
    return true;
  }

  private async downloadPack(
    game: CatalogGameRecord,
    data: CatalogDataRecord,
    filename: string,
    sources: { name: string; baseUrl: string }[],
    prep: Preparation,
  ): Promise<number> {
    const target = path.join(this.deps.paths.dataPacksDir, filename);
    let lastError: unknown = null;
    this.liveStartedAt = this.now();
    this.live = { gameId: game.id, gameTitle: game.title, received: 0, total: data.size, bytesPerSecond: 0 };

    for (const source of sources) {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        if (this.abort?.signal.aborted) {
          throw new Error('Download aborted');
        }
        const url = joinUrl(source.baseUrl, filename);
        try {
          this.deps.log.debug(`Downloading ${url}`);
          const result = await fetchToFile(url, target, {
            signal: this.abort?.signal,
            expectedSha256: data.sha256,
            onProgress: (received, total) => {
              const elapsed = Math.max(1, (this.now() - this.liveStartedAt) / 1000);
              this.live = {
                gameId: game.id,
                gameTitle: game.title,
                received,
                total: total ?? data.size ?? null,
                bytesPerSecond: received / elapsed,
              };
            },
          });
          return result.bytes;
        } catch (error) {
          lastError = error;
          if (this.abort?.signal.aborted) {
            throw error;
          }
          if (isNotFound(error)) {
            break;
          }
          if (attempt === 0) {
            await sleep(prep.settings.mode === 'active' ? 1500 : 4000);
          }
        }
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  private async downloadImage(game: CatalogGameRecord, subPath: string, target: string): Promise<void> {
    const prefs = this.deps.api.getPreferences();
    const base = (prefs.onDemandBaseUrl || '').trim();
    if (!base) {
      throw new Error('No image server configured in the launcher preferences');
    }
    const url = joinUrl(base, subPath) + (prefs.onDemandImagesCompressed ? '?type=jpg' : '');
    await fetchToFile(url, target, { signal: this.abort?.signal, timeoutMs: 30_000 });
  }

  private async repairPackFlags(gameId: string, dataId: number, filename: string): Promise<void> {
    try {
      await this.persistPackFlags(gameId, dataId, filename);
    } catch (error) {
      this.deps.log.warn(`Could not repair database flags for ${filename}: ${errorMessage(error)}`);
    }
  }

  private async persistPackFlags(gameId: string, dataId: number, filename: string): Promise<void> {
    const full = await this.deps.api.findGame(gameId);
    if (!full) {
      throw new Error(`Game ${gameId} is no longer in the database`);
    }
    const stored = (full.gameData || []).find((data) => data.id === dataId);
    if (!stored) {
      throw new Error(`Data pack ${dataId} is no longer attached to ${gameId}`);
    }
    stored.presentOnDisk = true;
    stored.path = filename;
    await this.deps.api.saveGameData(stored);
    if (full.activeDataId === dataId && !full.activeDataOnDisk) {
      full.activeDataOnDisk = true;
      await this.deps.api.updateGame(full);
    }
  }

  private async recordFailure(failure: {
    kind: 'image' | 'pack';
    gameId: string;
    gameTitle: string;
    packId?: number;
    url?: string;
    path?: string;
    error: string;
  }): Promise<void> {
    await appendJsonl(this.deps.paths.failuresFile, {
      at: new Date(this.now()).toISOString(),
      ...failure,
    }).catch((error) => this.deps.log.warn(`Could not write failure log: ${errorMessage(error)}`));
  }

  private sources(): { name: string; baseUrl: string }[] {
    const prefs = this.deps.api.getPreferences();
    const sources: { name: string; baseUrl: string }[] = [];
    for (const source of prefs.gameDataSources || []) {
      if (source.type === 'raw' && source.arguments && source.arguments[0]) {
        sources.push({ name: source.name, baseUrl: source.arguments[0] });
      }
    }
    if (sources.length === 0) {
      sources.push({
        name: 'Flashpoint Project',
        baseUrl: 'https://download.flashpointarchive.org/gib-roms/Games/',
      });
    }
    return sources;
  }

  private async probeFree(): Promise<{ freeBytes: number } | null> {
    const probe = this.deps.probeFree || getFreeBytes;
    try {
      return await probe(this.deps.paths.dataPacksDir);
    } catch {
      return null;
    }
  }

  private async persist(force = false): Promise<void> {
    if (!this.job) {
      return;
    }
    const now = this.now();
    if (!force && now - this.lastPersist < PERSIST_INTERVAL_MS) {
      return;
    }
    this.lastPersist = now;
    this.job.cursor = this.currentCursor();
    this.job.updatedAt = new Date(now).toISOString();
    if (this.running) {
      // Never overwrite a terminal status written by runJob().
      this.job.status = this.stopRequested ? 'stopped' : this.pauseRequested ? 'paused' : 'running';
      this.job.message = this.message || this.job.message;
    }
    await writeJsonAtomic(this.deps.paths.jobFile, this.job)
      .catch((error) => this.deps.log.warn(`Could not save job state: ${errorMessage(error)}`));
  }

  private updateTask(job: JobState, prep: Preparation): void {
    if (!this.taskId) {
      return;
    }
    const now = this.now();
    if (now - this.lastTaskUpdate < TASK_INTERVAL_MS) {
      return;
    }
    this.lastTaskUpdate = now;
    const sessionBytes = Math.max(0, job.bytes - this.sessionStartBytes);
    const total = prep.estimate.totalBytes > 0 ? prep.estimate.totalBytes : sessionBytes + 1;
    const progress = Math.min(0.995, sessionBytes / total);
    const pieces = [
      `${formatCount(job.gamesDone)} games`,
      `${formatCount(job.packsDone)} packs`,
      formatBytes(sessionBytes),
      formatPercent(sessionBytes, total),
    ];
    if (job.packsFailed > 0) {
      pieces.push(`${formatCount(job.packsFailed)} failed`);
    }
    this.deps.sink.updateTask(this.taskId, { status: pieces.join(' · '), progress });
  }

  private finishTask(job: JobState): void {
    if (!this.taskId) {
      return;
    }
    this.deps.sink.updateTask(this.taskId, {
      status: job.message,
      progress: job.status === 'done' ? 1 : undefined,
      finished: true,
      error: job.status === 'error' ? job.message : undefined,
    });
    this.taskId = null;
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  async resetJob(): Promise<void> {
    await fs.promises.unlink(this.deps.paths.jobFile).catch(() => undefined);
    this.job = null;
    this.state = 'idle';
    this.message = '';
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function existsNonEmpty(filePath: string): Promise<boolean> {
  try {
    const stat = await fs.promises.stat(filePath);
    return stat.isFile() && stat.size > 0;
  } catch {
    return false;
  }
}

/** Resolve a database path below a root, refusing traversal outside it. */
function safeJoin(root: string, relative: string): string | null {
  const resolvedRoot = path.resolve(root);
  const target = path.resolve(resolvedRoot, relative);
  if (target !== resolvedRoot && !target.startsWith(resolvedRoot + path.sep)) {
    return null;
  }
  return target;
}
