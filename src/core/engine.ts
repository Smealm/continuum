import * as fs from 'fs';
import * as path from 'path';
import { BandwidthMeter } from './bandwidth';
import { Catalog, CatalogGameRecord, CatalogMeta, errorMessage } from './catalog';
import { ConcurrencyController, WorkGate } from './concurrency';
import { DbWriteQueue } from './dbqueue';
import { getFreeBytes } from './disk';
import {
  fetchToFile,
  HttpStatusError,
  isNotFound,
  isPermissionDenied,
  probeDownloadSpeed,
  retryAfterMsOf,
  SpeedProbeResult,
} from './download';
import { formatBytes, formatCount, formatPercent, gameDataFilename, joinUrl } from './format';
import { JsonlCursor, appendJsonl, readJson, writeJsonAtomic } from './jsonl';
import { sweepPartFiles } from './maintenance';
import { buildDownloadOrder, OrderEntry } from './order';
import { recordDenial } from './permission';
import { RetryEntry, RetryInput, RetryStore } from './retry';
import { matchesScope, scopeKey, ScopeFilter } from './scope';
import {
  ChangedEntry,
  ChangedList,
  ContinuumApi,
  ContinuumPreferences,
  EngineMode,
  JobState,
  JobStatus,
  Logger,
  Paths,
  Settings,
} from './types';

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
  /** How long to wait at the end of a pass for due retries. 0 skips the wait. */
  retryWaitMs?: number;
  /** Live check of the playlist-priority toggle; falls back to the job settings. */
  readPrioritize?: () => boolean;
  /** How often to re-read playlists while the priority queue is empty. */
  priorityRefreshMs?: number;
  /** How often the adaptive controller samples the transfer rate. */
  adaptIntervalMs?: number;
  /** Injected for tests; measures one file without keeping it. */
  probeSpeed?: (url: string, options: { signal?: AbortSignal; maxMs?: number }) => Promise<SpeedProbeResult>;
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
  /** True when this job only covers the games the last rebuild changed. */
  changedOnly: boolean;
  /** The changed list for this catalogue generation, when a rebuild left one. */
  changed: { generation: string; entries: ChangedEntry[] } | null;
}

export interface PrepareOptions {
  /** Restrict the job to the list a rebuild wrote; ignored when there is none. */
  changedOnly?: boolean;
}

interface WorkItem {
  value: CatalogGameRecord;
  offset: number;
  startOffset: number;
  /** True when the record came from the playlist queue, not the main pass. */
  priority: boolean;
  /** Position in the changed list, so a stop can pin it for the next run. */
  changedIndex?: number;
  /** Position in the smallest-first order, for the saved queue position. */
  orderIndex?: number;
}

interface PriorityPlan {
  ids: string[];
  index: number;
  known: Set<string>;
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
  progress: {
    /** Bytes this run, for the "progress so far" line of a single session. */
    sessionBytes: number;
    /** Bytes handled for the whole job, including earlier runs. */
    doneBytes: number;
    estimateBytes: number;
    percent: number;
    remainingBytes: number;
    remainingPacks: number;
    remainingGames: number;
    /** Best sustained rate seen, used for the ETA instead of the average. */
    peakBytesPerSecond: number;
    currentBytesPerSecond: number;
    /** Best sustained completion rates, the floor under the ETA. */
    peakPacksPerSecond: number;
    peakGamesPerSecond: number;
  };
  startedAt: number | null;
  /** Downloads waiting in the retry queue. */
  retryPending: number;
  /** Adaptive width, or null when the job uses a fixed number of workers. */
  workers: { limit: number; ceiling: number; inFlight: number } | null;
}

interface StartResult {
  ok: boolean;
  reason?: string;
}

const PERSIST_INTERVAL_MS = 2000;
const TASK_INTERVAL_MS = 1000;
/** How often the progress meter records a rate sample. */
export const RATE_SAMPLE_MS = 1000;
/**
 * How often the adaptive controller compares goodput. Five seconds keeps the
 * ramp to the measured peak short without turning the log into a stream.
 */
export const ADAPT_INTERVAL_MS = 5_000;
/**
 * A pack this large gives the probe a real transfer to watch. Smaller files are
 * dominated by request latency and say nothing about the link.
 */
const PEAK_PROBE_MIN_BYTES = 16 * 1024 * 1024;
/** Above this, a pack is big enough; no need to scan further for a larger one. */
const PEAK_PROBE_GOOD_BYTES = 256 * 1024 * 1024;
/** Give up looking for a big pending pack after this many catalogue records. */
const PEAK_PROBE_SCAN_RECORDS = 20_000;
/** The probe is short on purpose: 30 seconds at full speed, then it stops. */
const PEAK_PROBE_MAX_MS = 30_000;
/** Never probe more than once an hour. */
const PEAK_PROBE_INTERVAL_MS = 60 * 60_000;
/** How long a finished pass waits for the retry queue before giving up for now. */
const RETRY_WAIT_LIMIT_MS = 2 * 60_000;
/** How often a running job re-reads playlists for new priority games. */
const PRIORITY_REFRESH_MS = 30_000;
/**
 * job.json is rewritten every couple of seconds. A playlist with the whole
 * archive in it would make that an 8 MB write, so only the head of the plan is
 * persisted; the rest is re-read from the playlists on the next start.
 */
const MAX_SAVED_PRIORITY_IDS = 5000;
/**
 * Changed records are read by seeking, so the read buffer only has to hold one
 * record. A small chunk keeps thousands of seeks cheap.
 */
const CHANGED_READ_CHUNK = 16 * 1024;

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

  private mainCursor: JsonlCursor<CatalogGameRecord> | null = null;
  private priorityCursor: JsonlCursor<CatalogGameRecord> | null = null;
  /** gameId -> catalogue offset, built once per run when priority is on. */
  private priorityOffsets: Map<string, number> | null = null;
  private priorityPlan: PriorityPlan | null = null;
  private priorityRefreshedAt = 0;
  /** gameId|packId whose database flag was written during this run. */
  private flaggedThisRun = new Set<string>();
  /** Games the launcher installed during this run; skipped until the next run. */
  private skippedGames = new Set<string>();
  /** gameId -> controller for the transfer running now, so it can be cancelled. */
  private inflightDownloads = new Map<string, AbortController>();
  private changedOnly = false;
  /**
   * Whole-catalogue order for smallest-first runs, or null in catalogue order.
   * The saved position is an index into this list, not a byte offset.
   */
  private orderEntries: OrderEntry[] | null = null;
  private orderIndex = 0;
  private orderCursor: JsonlCursor<CatalogGameRecord> | null = null;
  /** Order positions handed out but not finished; a stop rewinds to the first. */
  private inflightOrder = new Set<number>();
  private orderCache: { key: string; entries: OrderEntry[] } | null = null;
  private readonly meter = new BandwidthMeter();
  private rateSampledBytes = 0;
  private rateSampledPacks = 0;
  private rateSampledGames = 0;
  private rateSampledAt = 0;
  private rateTimer: NodeJS.Timeout | null = null;
  private probeAbort: AbortController | null = null;
  private lastPeakProbeAt = 0;
  private catalogSize = 0;
  private gate: WorkGate | null = null;
  private controller: ConcurrencyController | null = null;
  private workerCeiling = 0;
  /**
   * Bytes received by the transfer layer this run, updated as data arrives
   * rather than when a pack completes. A single 30 GB pack would otherwise
   * sample as zero goodput for hours and collapse the width.
   */
  private transferBytes = 0;
  private concurrencySampledBytes = 0;
  private concurrencySampledFailures = 0;
  private concurrencySampledAt = 0;
  /** Set when a host answered 401/403; the job ends as an error and is not retried. */
  private denied: { status: number; url?: string } | null = null;
  private changedEntries: ChangedEntry[] = [];
  private changedIndex = 0;
  private changedCursor: JsonlCursor<CatalogGameRecord> | null = null;
  /**
   * Games a worker has claimed. The priority queue and the main cursor can
   * reach the same game (a priority game is also somewhere in the catalogue),
   * and two workers must never download the same pack at once.
   */
  private processingGames = new Set<string>();

  /** One writer at a time, with a retry when the launcher holds the DB lock. */
  private readonly db: DbWriteQueue;
  private readonly retries: RetryStore;

  constructor(
    private readonly deps: EngineDeps,
    private readonly catalog: Catalog,
  ) {
    this.db = new DbWriteQueue({ log: deps.log });
    this.retries = new RetryStore(deps.paths.retriesFile, () => this.now());
  }

  snapshot(): EngineSnapshot {
    const sessionBytes = this.job ? Math.max(0, this.job.bytes - this.sessionStartBytes) : 0;
    const estimateBytes = this.estimate?.totalBytes ?? 0;
    // A changed-only pass has an estimate of its own. A full pass counts every
    // byte the job has handled, so resuming does not restart the estimate at
    // zero and make the ETA assume the whole archive is still ahead.
    const doneBytes = this.changedOnly ? sessionBytes : Math.max(0, this.job?.bytes ?? 0);
    const percent = this.state === 'done'
      ? 1
      : estimateBytes > 0
        ? Math.min(1, doneBytes / estimateBytes)
        : 0;
    const rates = this.meter.snapshot();
    return {
      status: this.state,
      message: this.message,
      mode: this.settings?.mode ?? null,
      job: this.job ? { ...this.job } : null,
      meta: this.meta,
      live: this.live ? { ...this.live } : null,
      settings: this.settings,
      progress: {
        sessionBytes,
        doneBytes,
        estimateBytes,
        percent,
        remainingBytes: Math.max(0, estimateBytes - doneBytes),
        remainingPacks: Math.max(0, (this.estimate?.packsMissing ?? 0) - (this.job?.packsDone ?? 0)),
        remainingGames: Math.max(0, (this.estimate?.gamesInScope ?? 0) - (this.job?.gamesDone ?? 0)),
        peakBytesPerSecond: rates.peakBytesPerSecond,
        currentBytesPerSecond: rates.currentBytesPerSecond,
        peakPacksPerSecond: rates.peakPacksPerSecond,
        peakGamesPerSecond: rates.peakGamesPerSecond,
      },
      startedAt: this.sessionStartedAt,
      retryPending: this.retries.count(),
      workers: this.gate && this.controller
        ? { limit: this.gate.width, ceiling: this.workerCeiling, inFlight: this.gate.inFlight }
        : null,
    };
  }

  isRunning(): boolean {
    return this.running;
  }

  /** Load the retry queue so status views are right before the first run. */
  async loadState(): Promise<void> {
    await this.retries.load();
  }

  /**
   * How many games the last rebuild changed for this catalogue, or 0 when there
   * is no list. Used by the automatic tasks to decide between a changed-only
   * pass and a full one without preparing a job.
   */
  async pendingChanges(meta: CatalogMeta): Promise<number> {
    const list = await this.loadChangedList(meta);
    return list ? list.entries.length : 0;
  }

  /**
   * The launcher installed a game itself (the user pressed Install, or launched
   * the game and let Infinity fetch it). Drop it from this run's queue, cancel
   * our transfer if we are the one fetching it, and forget its queued retries:
   * the launcher wrote the files and the database flags already.
   */
  noteGameInstalled(gameId: string): void {
    if (!gameId) {
      return;
    }
    this.skippedGames.add(gameId);
    const controller = this.inflightDownloads.get(gameId);
    if (controller) {
      this.deps.log.info(`The launcher installed ${gameId}; cancelling our download of it.`);
      controller.abort();
    } else if (this.running) {
      this.deps.log.info(`The launcher installed ${gameId}; skipping it for the rest of this run.`);
    } else {
      this.deps.log.debug(`The launcher installed ${gameId}; no job is running to skip it in.`);
    }
    void this.retries.forgetGame(gameId)
      .then((removed) => {
        if (removed > 0) {
          this.deps.log.info(`Dropped ${removed} queued retry(ies) for ${gameId}; it is installed now.`);
        }
      })
      .catch((error) => this.deps.log.warn(`Could not clear retries for ${gameId}: ${errorMessage(error)}`));
  }

  /**
   * The launcher removed a game's files. Let it back into the queue: if the
   * cursor has not passed it yet it is fetched in this run, otherwise on the
   * next pass.
   */
  noteGameUninstalled(gameId: string): void {
    if (gameId && this.skippedGames.delete(gameId)) {
      this.deps.log.info(`The launcher uninstalled ${gameId}; it is back in the queue.`);
    }
  }

  /**
   * A 401/403 is the host saying "not allowed", which is what a blacklist looks
   * like. Stop everything, do not retry, and record it so automatic work stays
   * paused until a person chooses to try again.
   */
  private noteDenied(error: unknown): void {
    const status = error instanceof HttpStatusError ? error.status : 403;
    const url = error instanceof HttpStatusError ? error.url : undefined;
    if (!this.denied) {
      this.denied = { status, url };
      this.deps.log.error(
        `The archive host refused access (HTTP ${status}${url ? ` for ${url}` : ''}). `
        + 'Continuum has stopped and will not retry automatically.',
      );
    }
    this.message = `The archive host refused access (HTTP ${status}). `
      + 'Continuum has stopped and will not retry automatically.';
    this.stopRequested = true;
    this.abort?.abort();
  }

  whenIdle(): Promise<void> {
    if (!this.running) {
      return Promise.resolve();
    }
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  /**
   * The launcher's own preferences decide three things while they are being
   * respected: which games the extreme filter hides, whether images are
   * compressed, and whether images are cached at all.
   *
   * With the switch off, the extreme filter and image compression are ignored
   * and images are cached anyway: there is no separate Continuum image switch
   * any more, so the launcher's image caching is the only way to skip them, and
   * skipping them is exactly the launcher preference being ignored. Resolving
   * this once on the job settings keeps the estimate, the scope key and every
   * worker in agreement.
   */
  private applyLauncherPreferences(settings: Settings, prefs: ContinuumPreferences): Settings {
    if (!settings.respectFlashpointSettings) {
      return settings;
    }
    return {
      ...settings,
      includeImages: settings.includeImages && !!prefs.onDemandImages,
    };
  }

  private async resolveFilter(settings: Settings, prefs: ContinuumPreferences): Promise<ScopeFilter> {
    const extremeTags = (prefs.tagFilters || [])
      .filter((group) => group.extreme)
      .reduce<string[]>((tags, group) => tags.concat(group.tags || []), []);
    const filter: ScopeFilter = {
      scope: settings.scope,
      extremeTags,
      excludeExtreme: settings.respectFlashpointSettings && !!prefs.disableExtremeGames,
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

  async prepare(settings: Settings, options: PrepareOptions = {}): Promise<Preparation> {
    await this.retries.load();
    const prefs = this.deps.api.getPreferences();
    const effective = this.applyLauncherPreferences(settings, prefs);
    const meta = await this.catalog.loadMeta();
    if (!meta) {
      throw new Error('No catalogue yet. Rebuild the catalogue first.');
    }
    const changed = await this.loadChangedList(meta);
    const changedOnly = !!options.changedOnly && !!changed;
    const filter = await this.resolveFilter(effective, prefs);
    const estimate = changedOnly
      ? await this.computeChangedEstimate(changed!.entries, filter, effective)
      : await this.computeEstimate(filter, effective);
    const free = await this.probeFree();
    const reserve = settings.reserveBytes;
    const fits = free === null ? null : free.freeBytes - reserve >= estimate.totalBytes;

    const warnings: string[] = [];
    if (effective.respectFlashpointSettings && settings.includeImages && !prefs.onDemandImages) {
      warnings.push(
        'The launcher has image caching switched off, so logos and screenshots will not be downloaded. '
        + 'Turn image caching on in the launcher\'s settings, or switch off "Respect Flashpoint Settings" '
        + 'to cache them anyway.',
      );
    }
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

    const key = scopeKey(effective.scope, effective.includeImages, changedOnly);
    const saved = await readJson<JobState>(this.deps.paths.jobFile);
    const resumable = !!saved
      && saved.version === 1
      && saved.generation === meta.generation
      && saved.scopeKey === key;
    const job = resumable && saved ? { ...saved } : this.newJob(meta, key, effective);

    return {
      settings: effective,
      meta,
      filter,
      estimate,
      freeBytes: free?.freeBytes ?? null,
      fits,
      warnings,
      job,
      resumable: resumable && !!saved && (saved.cursor > 0 || (saved.changed?.cursor ?? 0) > 0),
      changedOnly,
      changed,
    };
  }

  /** The changed list a rebuild left for this exact catalogue, or null. */
  private async loadChangedList(
    meta: CatalogMeta,
  ): Promise<{ generation: string; entries: ChangedEntry[] } | null> {
    const list = await readJson<ChangedList>(this.deps.paths.changedFile);
    if (!list
      || list.version !== 1
      || list.generation !== meta.generation
      || !Array.isArray(list.entries)
      || list.entries.length === 0) {
      return null;
    }
    const entries = list.entries.filter((entry) => entry
      && typeof entry.id === 'string'
      && Number.isFinite(entry.offset));
    return entries.length > 0 ? { generation: list.generation, entries } : null;
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
    return estimateFor(gamesInScope, packsMissing, packBytes, settings);
  }

  /**
   * Estimate for a changed-only pass. Each changed record is read by seeking
   * straight to it, so this costs one small read per changed game instead of a
   * walk over the whole catalogue.
   */
  private async computeChangedEstimate(
    entries: ChangedEntry[],
    filter: ScopeFilter,
    settings: Settings,
  ): Promise<Estimate> {
    let gamesInScope = 0;
    let packsMissing = 0;
    let packBytes = 0;
    const cursor = new JsonlCursor<CatalogGameRecord>(this.deps.paths.catalogFile, 0, CHANGED_READ_CHUNK);
    try {
      for (const entry of entries) {
        cursor.seek(entry.offset);
        const next = await cursor.next();
        if (!next || next.value.id !== entry.id) {
          continue;
        }
        if (!matchesScope(next.value, filter)) {
          continue;
        }
        gamesInScope += 1;
        for (const data of next.value.data) {
          if (!data.present) {
            packsMissing += 1;
            packBytes += data.size;
          }
        }
      }
    } finally {
      await cursor.close().catch(() => undefined);
    }
    return estimateFor(gamesInScope, packsMissing, packBytes, settings);
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
    this.catalogSize = size;
    this.state = 'running';
    this.settings = prep.settings;
    this.meta = prep.meta;
    this.filter = prep.filter;
    this.estimate = prep.estimate;
    this.job = prep.job;
    // Per-run counter: the next pass repairs whatever this one could not write.
    this.job.packFlagsFailed = 0;
    this.pauseRequested = false;
    this.stopRequested = false;
    this.lowDiskNotified = false;
    this.message = '';
    this.abort = new AbortController();
    this.live = null;
    this.inflightBytes = 0;
    this.inflightStarts.clear();
    this.maxReadOffset = this.job.cursor;
    this.sessionStartedAt = this.now();
    this.mainCursor = null;
    this.priorityCursor = null;
    this.priorityPlan = null;
    this.priorityOffsets = null;
    this.priorityRefreshedAt = 0;
    this.flaggedThisRun.clear();
    this.skippedGames.clear();
    this.inflightDownloads.clear();
    this.processingGames.clear();
    this.orderEntries = null;
    this.orderIndex = 0;
    this.orderCursor = null;
    this.inflightOrder.clear();
    // The meter is not reset: the best rate the link delivered belongs to the
    // connection, not to this pass, so a pause and resume keeps the peak the
    // ETA was using.
    this.rateSampledBytes = 0;
    this.rateSampledPacks = 0;
    this.rateSampledGames = 0;
    this.rateSampledAt = this.now();
    this.gate = null;
    this.controller = null;
    this.workerCeiling = 0;
    this.denied = null;

    this.changedOnly = prep.changedOnly && !!prep.changed;
    this.changedEntries = this.changedOnly ? prep.changed!.entries.slice() : [];
    this.changedIndex = 0;
    this.changedCursor = null;
    if (this.changedOnly) {
      const savedChanged = this.job.changed;
      if (savedChanged && savedChanged.generation === prep.meta.generation) {
        this.changedIndex = Math.max(0, Math.min(savedChanged.cursor, this.changedEntries.length));
      }
      this.job.changed = {
        generation: prep.meta.generation,
        cursor: this.changedIndex,
        total: this.changedEntries.length,
      };
    } else {
      this.job.changed = undefined;
    }

    this.job.mode = prep.settings.mode;
    this.job.status = 'running';
    this.job.message = this.changedOnly
      ? `Downloading changes (${prep.settings.mode})`
      : prep.settings.mode === 'active' ? 'Downloading (active)' : 'Downloading (passive)';
    if (this.job.cursor >= size
      || (this.job.order && this.job.order.total > 0 && this.job.order.cursor >= this.job.order.total)) {
      // The previous pass reached the end; this is a fresh pass over the same
      // catalogue, so its counters start again from zero.
      this.startFreshPass();
    }
    this.sessionStartBytes = this.job.bytes;

    this.taskId = this.deps.sink.createTask(`Continuum mirror (${prep.settings.mode})`);
    this.lastPersist = 0;
    this.lastTaskUpdate = 0;
    void this.runJob(prep, size);
    return { ok: true };
  }

  /**
   * A finished pass leaves its byte and pack totals behind. A new pass over the
   * same catalogue starts from zero; otherwise its progress bar opens at 100%
   * and there is no remaining work to put an ETA on.
   */
  private startFreshPass(): void {
    const job = this.job;
    if (!job) {
      return;
    }
    job.cursor = 0;
    job.bytes = 0;
    job.packsDone = 0;
    job.packsFailed = 0;
    job.gamesDone = 0;
    job.gamesFailed = 0;
    job.imagesDone = 0;
    job.packFlagsFailed = 0;
    if (job.order) {
      job.order.cursor = 0;
    }
    this.maxReadOffset = 0;
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
      await sweepPartFiles(this.deps.paths.dataPacksDir, { log: this.deps.log });
      await this.retries.load();
      await this.runRetryPhase(prep);

      if (!this.stopRequested && !this.pauseRequested) {
        this.readChain = Promise.resolve();
        const activeCeiling = Math.max(1, Math.min(20, settings.activeWorkers || 4));
        const passiveWorkers = Math.max(1, Math.min(2, settings.passiveWorkers || 1));
        const adaptive = !this.changedOnly && settings.mode === 'active' && !!settings.adaptiveWorkers;
        const fixedWorkers = settings.mode === 'active' ? activeCeiling : passiveWorkers;
        const startWidth = adaptive ? Math.min(activeCeiling, 2) : fixedWorkers;
        const loopCount = adaptive ? activeCeiling : fixedWorkers;
        this.gate = new WorkGate(startWidth);
        this.controller = adaptive
          ? new ConcurrencyController({ min: 1, max: activeCeiling, start: startWidth })
          : null;
        this.workerCeiling = adaptive ? activeCeiling : fixedWorkers;
        this.transferBytes = 0;
        this.concurrencySampledBytes = 0;
        this.concurrencySampledFailures = job.packsFailed + job.gamesFailed;
        this.concurrencySampledAt = this.now();

        if (this.changedOnly) {
          this.changedCursor = new JsonlCursor<CatalogGameRecord>(
            this.deps.paths.catalogFile,
            0,
            CHANGED_READ_CHUNK,
          );
          this.deps.log.info(
            `Starting ${settings.mode} job over ${this.changedEntries.length} changed game(s) `
            + `(${this.changedIndex} already handled).`,
          );
        } else {
          cursor = new JsonlCursor<CatalogGameRecord>(this.deps.paths.catalogFile, Math.min(job.cursor, catalogSize));
          this.mainCursor = cursor;
          this.priorityCursor = new JsonlCursor<CatalogGameRecord>(this.deps.paths.catalogFile);
          if (settings.order === 'smallest') {
            await this.loadDownloadOrder(prep);
          }
          this.deps.log.info(
            `Starting ${settings.mode} job with ${loopCount} worker loop(s)`
            + `${adaptive ? ` (adaptive from ${startWidth}, ceiling ${activeCeiling})` : ''}`
            + (this.orderEntries
              ? `, smallest games first (${formatCount(this.orderEntries.length)} in the queue, `
                + `resuming at ${formatCount(this.orderIndex)})`
              : ', catalogue order')
            + `; resuming at byte ${job.cursor}.`,
          );
          await this.preparePriority(prep);
        }
        const tasks: Promise<void>[] = [];
        for (let i = 0; i < loopCount; i += 1) {
          tasks.push(this.worker(prep));
        }
        const adaptTimer = adaptive
          ? setInterval(() => this.adaptConcurrency(), this.deps.adaptIntervalMs ?? ADAPT_INTERVAL_MS)
          : null;
        adaptTimer?.unref?.();
        const rateTimer = setInterval(() => this.sampleRates(), RATE_SAMPLE_MS);
        rateTimer.unref?.();
        this.rateTimer = rateTimer;
        // A short probe of a large pack gives the controller a rate to aim at
        // while the queue is still full of tiny files.
        this.maybeProbeBandwidth();
        try {
          await Promise.all(tasks);
        } finally {
          if (adaptTimer) {
            clearInterval(adaptTimer);
          }
          clearInterval(rateTimer);
          this.rateTimer = null;
          this.sampleRates();
        }
        if (this.changedOnly) {
          // The main cursor is untouched by a changed pass; only the list position moves.
          if (this.job?.changed) {
            this.job.changed.cursor = this.changedIndex;
          }
        } else if (this.orderEntries) {
          if (this.orderIndex >= this.orderEntries.length && this.inflightOrder.size === 0) {
            job.order!.cursor = this.orderEntries.length;
            job.cursor = catalogSize;
          }
        } else {
          job.cursor = this.currentCursor();
        }
        if (!this.stopRequested && !this.pauseRequested) {
          await this.waitForRetries(prep);
        }
      }

      if (this.denied) {
        job.status = 'error';
        job.message = `The archive host refused access (HTTP ${this.denied.status}). `
          + 'Continuum has stopped and will not retry automatically.';
      } else if (this.stopRequested) {
        job.status = 'stopped';
        job.message = this.message || 'Stopped. Progress was saved.';
      } else if (this.pauseRequested) {
        job.status = 'paused';
        job.message = this.message || 'Paused. Progress was saved.';
      } else {
        job.status = 'done';
        job.message = `Finished this pass: ${formatCount(job.packsDone)} packs (${formatBytes(job.bytes)}), `
          + `${formatCount(job.packsFailed)} failures.`;
        const pending = this.retries.count();
        if (pending > 0) {
          job.message += ` ${formatCount(pending)} download${pending === 1 ? '' : 's'} will be retried later.`;
        }
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
      if (this.priorityCursor) {
        await this.priorityCursor.close().catch(() => undefined);
      }
      if (this.changedCursor) {
        await this.changedCursor.close().catch(() => undefined);
      }
      await this.persist(true).catch(() => undefined);
      if (this.changedOnly && job.status === 'done') {
        // The list has been handled; the next start is a full pass again.
        await fs.promises.unlink(this.deps.paths.changedFile).catch(() => undefined);
      }
      if (this.denied) {
        await recordDenial(this.deps.paths.deniedFile, this.denied).catch((error) => {
          this.deps.log.warn(`Could not record the refused access: ${errorMessage(error)}`);
        });
      }
      this.probeAbort?.abort();
      this.probeAbort = null;
      if (this.rateTimer) {
        clearInterval(this.rateTimer);
        this.rateTimer = null;
      }
      this.gate?.cancel();
      this.gate = null;
      this.controller = null;
      this.mainCursor = null;
      if (this.orderCursor) {
        await this.orderCursor.close().catch(() => undefined);
      }
      this.orderCursor = null;
      this.inflightOrder.clear();
      this.priorityCursor = null;
      this.priorityOffsets = null;
      this.priorityPlan = null;
      this.changedOnly = false;
      this.changedEntries = [];
      this.changedIndex = 0;
      this.changedCursor = null;
      this.flaggedThisRun.clear();
      this.skippedGames.clear();
      this.inflightDownloads.clear();
      this.processingGames.clear();
      this.finishTask(job);
      const waiters = this.idleWaiters;
      this.idleWaiters = [];
      for (const resolve of waiters) {
        resolve();
      }
    }
  }

  /** The toggle is re-read while running, so it can be switched mid-job. */
  private priorityEnabled(): boolean {
    if (this.deps.readPrioritize) {
      return this.deps.readPrioritize();
    }
    return !!this.settings?.prioritizePlaylists;
  }

  /** Every game in every playlist, in playlist order. */
  private async playlistGameIds(): Promise<Set<string>> {
    const ids = new Set<string>();
    const api = this.deps.api;
    if (typeof api.findPlaylists !== 'function') {
      return ids;
    }
    try {
      const summaries = await Promise.resolve(api.findPlaylists(true) || []);
      for (const summary of summaries) {
        if (!summary || !summary.id) {
          continue;
        }
        const full = await Promise.resolve(api.findPlaylist(summary.id, true) || summary);
        for (const entry of full.games || []) {
          if (entry && entry.gameId) {
            ids.add(entry.gameId);
          }
        }
      }
    } catch (error) {
      this.deps.log.warn(`Could not read playlists: ${errorMessage(error)}`);
    }
    return ids;
  }

  /**
   * Build the plan for this run. A saved plan is kept (and extended with games
   * added to playlists since) so pausing and resuming does not start it over.
   */
  private async preparePriority(prep: Preparation): Promise<void> {
    this.priorityPlan = null;
    this.priorityOffsets = null;
    if (!this.priorityEnabled()) {
      return;
    }

    const generation = prep.meta.generation;
    const saved = this.job?.priority;
    const current = await this.playlistGameIds();

    let ids: string[] = [];
    let index = 0;
    if (saved && saved.generation === generation && Array.isArray(saved.ids)) {
      ids = saved.ids.slice();
      index = Math.max(0, Math.min(saved.cursor, ids.length));
    }
    const known = new Set(ids);
    for (const id of current) {
      if (!known.has(id)) {
        known.add(id);
        ids.push(id);
      }
    }

    this.priorityPlan = { ids, index, known };
    this.job!.priority = { generation, ids, cursor: index };
    this.priorityRefreshedAt = this.now();
    if (ids.length > 0) {
      await this.ensurePriorityOffsets();
    }
  }

  /**
   * One streaming pass over the catalogue to learn where each game starts, so
   * a playlist game can be jumped to without walking the 221k records a second
   * time. About 30 MB of heap for a full catalogue, only while priority is on.
   */
  private async ensurePriorityOffsets(): Promise<boolean> {
    if (this.priorityOffsets) {
      return true;
    }
    const offsets = new Map<string, number>();
    const cursor = new JsonlCursor<CatalogGameRecord>(this.deps.paths.catalogFile);
    try {
      for (;;) {
        const next = await cursor.next();
        if (!next) {
          break;
        }
        offsets.set(next.value.id, next.startOffset);
      }
    } catch (error) {
      this.deps.log.warn(`Could not build the playlist priority index: ${errorMessage(error)}`);
      return false;
    } finally {
      await cursor.close().catch(() => undefined);
    }
    this.priorityOffsets = offsets;
    return true;
  }

  /** Pick up playlist edits made while the job is running. */
  private async refreshPriorityPlan(plan: PriorityPlan): Promise<boolean> {
    const now = this.now();
    const interval = this.deps.priorityRefreshMs ?? PRIORITY_REFRESH_MS;
    if (now - this.priorityRefreshedAt < interval || !this.priorityEnabled()) {
      return false;
    }
    this.priorityRefreshedAt = now;

    const current = await this.playlistGameIds();
    let added = 0;
    for (const id of current) {
      if (!plan.known.has(id)) {
        plan.known.add(id);
        plan.ids.push(id);
        added += 1;
      }
    }
    if (added === 0) {
      return false;
    }

    if (this.job?.priority) {
      this.job.priority.ids = plan.ids;
    }
    this.deps.log.info(`Playlist priority: ${formatCount(added)} more game(s) moved to the front.`);
    await this.ensurePriorityOffsets();
    return true;
  }

  private async takePriorityItem(): Promise<WorkItem | null> {
    for (;;) {
      if (!this.priorityPlan) {
        // Switched on mid-run: continue the saved plan if it matches this catalogue.
        const saved = this.job?.priority;
        const sameGeneration = !!saved && !!this.job && saved.generation === this.job.generation;
        const ids = sameGeneration ? saved!.ids.slice() : [];
        const index = sameGeneration ? Math.max(0, Math.min(saved!.cursor, ids.length)) : 0;
        this.priorityPlan = { ids, index, known: new Set(ids) };
        if (this.job) {
          this.job.priority = { generation: this.job.generation, ids, cursor: index };
        }
      }
      const plan = this.priorityPlan;
      if (plan.index >= plan.ids.length) {
        if (!(await this.refreshPriorityPlan(plan))) {
          return null;
        }
        continue;
      }
      if (!this.priorityCursor || !this.priorityOffsets) {
        return null;
      }
      const id = plan.ids[plan.index];
      plan.index += 1;
      const offset = this.priorityOffsets.get(id);
      if (offset === undefined) {
        // Not in this catalogue (removed game, or a playlist from another library).
        continue;
      }
      this.priorityCursor.seek(offset);
      const record = await this.priorityCursor.next();
      if (record) {
        return { ...record, priority: true };
      }
    }
  }

  /**
   * Read the next changed record by seeking straight to its offset. The list
   * comes from the rebuild diff, so everything else is skipped without a walk.
   * The position is only committed when the game is done; a stop rewinds it.
   */
  private async takeChangedItem(): Promise<WorkItem | null> {
    while (this.changedIndex < this.changedEntries.length) {
      const entry = this.changedEntries[this.changedIndex];
      const planIndex = this.changedIndex;
      this.changedIndex += 1;
      if (!this.changedCursor) {
        return null;
      }
      this.changedCursor.seek(entry.offset);
      const record = await this.changedCursor.next();
      if (!record || record.value.id !== entry.id) {
        this.deps.log.warn(`Changed game ${entry.id} is no longer at its saved offset; skipping it.`);
        continue;
      }
      return { ...record, priority: false, changedIndex: planIndex };
    }
    return null;
  }

  /** Changed items only, or priority items followed by the catalogue. */
  private async pickWorkItem(): Promise<WorkItem | null> {
    for (;;) {
      if (this.stopRequested || this.pauseRequested) {
        return null;
      }
      if (this.changedOnly) {
        const item = await this.takeChangedItem();
        if (!item) {
          return null;
        }
        this.processingGames.add(item.value.id);
        return item;
      }
      if (this.priorityEnabled()) {
        const item = await this.takePriorityItem();
        if (item) {
          if (this.processingGames.has(item.value.id)) {
            continue;
          }
          this.processingGames.add(item.value.id);
          return item;
        }
      }
      if (this.orderEntries) {
        return this.takeOrderItem();
      }
      if (!this.mainCursor) {
        return null;
      }
      const next = await this.mainCursor.next();
      if (!next) {
        return null;
      }
      this.maxReadOffset = Math.max(this.maxReadOffset, next.offset);
      // Keep the cursor at the first game still in flight, so an interrupted
      // game is retried instead of skipped on the next run.
      this.inflightStarts.add(next.startOffset);
      if (this.processingGames.has(next.value.id)) {
        // Another worker is downloading it right now (it came from the priority
        // queue); leave it to them and move on.
        this.deps.log.debug(`Skipping ${next.value.id}; another worker is already downloading it.`);
        this.inflightStarts.delete(next.startOffset);
        continue;
      }
      this.processingGames.add(next.value.id);
      return { ...next, priority: false };
    }
  }

  /**
   * Load the whole-catalogue smallest-first order for this job. The list only
   * depends on the catalogue generation, the scope and the job key, so a pause
   * and resume reuses it instead of reading and sorting the catalogue again.
   */
  private async loadDownloadOrder(prep: Preparation): Promise<void> {
    const job = this.job!;
    // The extreme filter can change what is in scope without changing the saved
    // scope key, so it is part of the cache key too.
    const key = `${prep.meta.generation}|${job.scopeKey}|extreme=${prep.filter.excludeExtreme}`
      + `|tags=${(prep.filter.extremeTags || []).join(',')}`;
    let entries: OrderEntry[];
    if (this.orderCache?.key === key) {
      entries = this.orderCache.entries;
    } else {
      try {
        entries = await buildDownloadOrder(
          this.deps.paths.catalogFile,
          (game) => matchesScope(game, prep.filter),
        );
      } catch (error) {
        // A failed sort is not a reason to refuse to download: fall back to
        // catalogue order for this run and try again next time.
        this.deps.log.warn(`Could not build the smallest-first order: ${errorMessage(error)}`);
        this.orderEntries = null;
        return;
      }
      this.orderCache = { key, entries };
    }

    this.orderEntries = entries;
    this.orderCursor = new JsonlCursor<CatalogGameRecord>(this.deps.paths.catalogFile);
    const saved = job.order;
    const sameQueue = !!saved
      && saved.generation === prep.meta.generation
      && saved.scopeKey === job.scopeKey;
    const resumed = sameQueue ? Math.max(0, Math.min(saved!.cursor, entries.length)) : 0;
    this.orderIndex = resumed >= entries.length ? 0 : resumed;
    this.inflightOrder.clear();
    job.order = {
      generation: prep.meta.generation,
      scopeKey: job.scopeKey,
      cursor: this.orderIndex,
      total: entries.length,
    };
  }

  /**
   * Take the next game in size order. Records are read by seeking, so the queue
   * can be fully sorted without holding 221k game records in memory. A game that
   * is already being downloaded from the priority queue is skipped; its order
   * position is released so the saved cursor does not wait on it.
   */
  private async takeOrderItem(): Promise<WorkItem | null> {
    const entries = this.orderEntries!;
    const cursor = this.orderCursor!;
    while (this.orderIndex < entries.length) {
      const index = this.orderIndex;
      this.orderIndex += 1;
      this.inflightOrder.add(index);
      cursor.seek(entries[index].offset);
      const record = await cursor.next();
      if (!record) {
        this.inflightOrder.delete(index);
        continue;
      }
      if (this.processingGames.has(record.value.id)) {
        this.inflightOrder.delete(index);
        continue;
      }
      if (!matchesScope(record.value, this.filter!)) {
        this.inflightOrder.delete(index);
        continue;
      }
      this.processingGames.add(record.value.id);
      return {
        value: record.value,
        offset: record.offset,
        startOffset: record.startOffset,
        priority: false,
        orderIndex: index,
      };
    }
    return null;
  }

  /**
   * Record a one-second-ish window of bytes and finished packs. The meter turns
   * these into the sustained peak the ETA and the controller use.
   */
  private sampleRates(): void {
    const job = this.job;
    if (!job) {
      return;
    }
    const now = this.now();
    const elapsed = now - this.rateSampledAt;
    if (elapsed < 250) {
      return;
    }
    this.meter.observeWindow(
      Math.max(0, this.transferBytes - this.rateSampledBytes),
      Math.max(0, job.packsDone - this.rateSampledPacks),
      Math.max(0, job.gamesDone - this.rateSampledGames),
      elapsed,
      now,
    );
    this.rateSampledBytes = this.transferBytes;
    this.rateSampledPacks = job.packsDone;
    this.rateSampledGames = job.gamesDone;
    this.rateSampledAt = now;
  }

  /**
   * Warm up the peak with a short probe of a large pack the job still needs.
   * Only adaptive active jobs do this; passive and fixed-width jobs do not need
   * a target, so they never spend a byte on measuring one.
   */
  private maybeProbeBandwidth(): void {
    if (!this.controller || !this.settings?.adaptiveWorkers) {
      return;
    }
    const now = this.now();
    if (this.lastPeakProbeAt > 0 && now - this.lastPeakProbeAt < PEAK_PROBE_INTERVAL_MS) {
      return;
    }
    this.lastPeakProbeAt = now;
    void this.probeBandwidth().catch((error) => {
      if (!this.abort?.signal.aborted) {
        this.deps.log.debug(`Bandwidth probe skipped: ${errorMessage(error)}`);
      }
    });
  }

  /**
   * Watch one large pending pack for at most 30 seconds and keep only the
   * rate. The bytes are thrown away, so the probe never writes a 50 GB file to
   * the target drive; it only presses the connection long enough for the rate
   * to plateau. What the probe measures plus what the real workers are getting
   * at the same time is the ceiling the worker count aims for.
   */
  private async probeBandwidth(): Promise<void> {
    const candidate = await this.findProbeCandidate();
    if (!candidate) {
      this.deps.log.debug('Bandwidth probe skipped: no pack of 16 MB or more is pending.');
      return;
    }
    const sources = this.sources();
    if (sources.length === 0) {
      return;
    }
    const url = joinUrl(sources[0].baseUrl, candidate);
    const probe = this.deps.probeSpeed || probeDownloadSpeed;
    const controller = new AbortController();
    const jobSignal = this.abort?.signal;
    if (jobSignal?.aborted) {
      return;
    }
    this.probeAbort = controller;
    const onJobAbort = (): void => controller.abort();
    if (jobSignal) {
      jobSignal.addEventListener('abort', onJobAbort, { once: true });
    }
    const beforeBytes = this.transferBytes;
    const startedAt = this.now();
    try {
      const result = await probe(url, { signal: controller.signal, maxMs: PEAK_PROBE_MAX_MS });
      // The probe competes with the real workers, so their rate during the
      // probe is part of what the connection was delivering.
      const seconds = Math.max(0.001, (this.now() - startedAt) / 1000);
      const concurrent = Math.max(0, this.transferBytes - beforeBytes) / seconds;
      const measured = result.bytesPerSecond + concurrent;
      if (result.bytes < 1024 * 1024 || result.bytesPerSecond <= 0) {
        this.deps.log.debug('Bandwidth probe measured too little to be useful.');
        return;
      }
      this.meter.observePeak(measured);
      this.controller?.observePeak(measured);
      this.deps.log.info(
        `Measured link speed: ${formatBytes(measured)}/s `
        + `(${formatBytes(result.bytesPerSecond)}/s probe, ${formatBytes(concurrent)}/s downloads, `
        + `${Math.round(result.elapsedMs / 100) / 10} s).`,
      );
    } finally {
      if (jobSignal) {
        jobSignal.removeEventListener('abort', onJobAbort);
      }
      if (this.probeAbort === controller) {
        this.probeAbort = null;
      }
    }
  }

  /**
   * The largest pending pack found near the read cursor, or near the front of
   * the catalogue on a fresh pass. The scan is bounded so a probe never turns
   * into a catalogue walk of its own.
   */
  private async findProbeCandidate(): Promise<string | null> {
    let best: { size: number; filename: string } | null = null;
    const order = this.orderEntries;
    // On a smallest-first run the interesting packs are at the far end of the
    // order, which is exactly what the ordering is trying to postpone.
    const offsets: number[] = [];
    if (order && order.length > 0) {
      for (let i = order.length - 1; i >= 0 && offsets.length < PEAK_PROBE_SCAN_RECORDS; i -= 1) {
        offsets.push(order[i].offset);
      }
    }
    const cursor = new JsonlCursor<CatalogGameRecord>(this.deps.paths.catalogFile);
    try {
      if (offsets.length > 0) {
        for (const offset of offsets) {
          cursor.seek(offset);
          const record = await cursor.next();
          if (!record) {
            break;
          }
          const candidate = probeCandidateIn(record.value);
          if (candidate && (!best || candidate.size > best.size)) {
            best = candidate;
            if (best.size >= PEAK_PROBE_GOOD_BYTES) {
              break;
            }
          }
        }
      } else {
        for (let read = 0; read < PEAK_PROBE_SCAN_RECORDS; read += 1) {
          const record = await cursor.next();
          if (!record) {
            break;
          }
          const candidate = probeCandidateIn(record.value);
          if (candidate && (!best || candidate.size > best.size)) {
            best = candidate;
          }
        }
      }
    } finally {
      await cursor.close().catch(() => undefined);
    }
    return best ? best.filename : null;
  }

  private nextWorkItem(): Promise<WorkItem | null> {
    const run = this.readChain.then(() => this.pickWorkItem());
    this.readChain = run.catch(() => undefined);
    return run;
  }

  /**
   * One worker loop. The gate decides how many of these loops may hold work at
   * once; the loops themselves are fixed for the run, so raising and lowering
   * concurrency never interrupts a transfer that is already going.
   */
  private async worker(prep: Preparation): Promise<void> {
    for (;;) {
      if (this.stopRequested || this.pauseRequested) {
        return;
      }
      const gate = this.gate;
      if (gate && !(await gate.acquire(() => this.stopRequested || this.pauseRequested))) {
        return;
      }
      try {
        const next = await this.nextWorkItem();
        if (!next) {
          return;
        }
        await this.processWorkItem(next, prep);
      } finally {
        gate?.release();
      }
      if (this.stopRequested || this.pauseRequested) {
        return;
      }
    }
  }

  private async processWorkItem(next: WorkItem, prep: Preparation): Promise<void> {
    const { settings } = prep;
    const job = this.job!;
    // A game abandoned by a stop, a pause or the job limit must stay pinned
    // in the cursor so the next run retries it instead of skipping it.
    let pinned = false;

    try {
      const game = next.value;
      if (!matchesScope(game, prep.filter)) {
        return;
      }

      const outcome = await this.processGame(game, prep);
      if (outcome === 'stop') {
        pinned = true;
        return;
      }
      if (outcome === 'pause') {
        pinned = true;
        this.pauseRequested = true;
        return;
      }

      this.updateTask(job, prep);
      if (settings.mode === 'passive' && settings.passiveDelayMs > 0) {
        await sleep(settings.passiveDelayMs);
      }
    } finally {
      this.processingGames.delete(next.value.id);
      if (pinned && next.changedIndex !== undefined) {
        // Re-run this changed game next time instead of skipping it.
        this.changedIndex = Math.min(this.changedIndex, next.changedIndex);
      }
      if (!pinned && !next.priority && next.changedIndex === undefined) {
        this.inflightStarts.delete(next.startOffset);
      }
      // A pinned order position stays in the set, so the saved queue position
      // rewinds to it and the game is retried instead of skipped.
      if (!pinned && next.orderIndex !== undefined) {
        this.inflightOrder.delete(next.orderIndex);
      }
      await this.persist();
    }
  }

  private currentCursor(): number {
    if (this.inflightStarts.size > 0) {
      return Math.min(...this.inflightStarts);
    }
    return this.maxReadOffset;
  }

  /**
   * Compare goodput with the last sample and adjust the gate. Only runs for an
   * adaptive active job; passive and changed-only jobs keep a fixed width.
   */
  private adaptConcurrency(): void {
    const controller = this.controller;
    const gate = this.gate;
    const job = this.job;
    if (!controller || !gate || !job) {
      return;
    }
    const now = this.now();
    const elapsed = now - this.concurrencySampledAt;
    if (elapsed < 1000) {
      return;
    }
    const failures = job.packsFailed + job.gamesFailed;
    const decision = controller.sample({
      bytes: Math.max(0, this.transferBytes - this.concurrencySampledBytes),
      failures: Math.max(0, failures - this.concurrencySampledFailures),
      elapsedMs: elapsed,
    });
    this.concurrencySampledBytes = this.transferBytes;
    this.concurrencySampledFailures = failures;
    this.concurrencySampledAt = now;
    if (decision.changed) {
      gate.setLimit(decision.limit);
      this.deps.log.info(`Parallel downloads: ${decision.limit} (${decision.reason}).`);
    }
  }

  /** Returns 'continue', 'pause' or 'stop' depending on why the game loop ended. */
  private async processGame(game: CatalogGameRecord, prep: Preparation): Promise<'continue' | 'pause' | 'stop'> {
    const job = this.job!;
    const { settings } = prep;
    const sources = this.sources();
    let hadWork = false;
    let packAttempts = 0;
    let packFailures = 0;

    // The launcher installed this game while the run was going; leave it alone.
    if (this.skippedGames.has(game.id)) {
      return 'continue';
    }

    if (settings.includeImages) {
      for (const subPath of [game.logo, game.screenshot]) {
        if (!subPath) {
          continue;
        }
        const target = safeJoin(this.deps.paths.imagesDir, subPath);
        if (!target) {
          continue;
        }
        if (await existsNonEmpty(target)) {
          await this.recordRetrySuccess('image', game.id, subPath);
          continue;
        }
        hadWork = true;
        if (!(await this.ensureReserve(IMAGE_ESTIMATE_BYTES))) {
          return this.stopRequested ? 'stop' : 'pause';
        }
        try {
          await this.downloadImage(subPath, target);
          job.imagesDone += 1;
          await this.recordRetrySuccess('image', game.id, subPath);
        } catch (error) {
          if (isPermissionDenied(error)) {
            this.noteDenied(error);
            return 'stop';
          }
          if (this.abort?.signal.aborted) {
            return this.stopRequested ? 'stop' : 'pause';
          }
          if (this.skippedGames.has(game.id)) {
            return 'continue';
          }
          await this.recordRetry({ kind: 'image', gameId: game.id, title: game.title, target: subPath }, error);
          await this.logFailure({
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
      if (this.skippedGames.has(game.id)) {
        return 'continue';
      }
      let filename: string;
      try {
        filename = gameDataFilename(data);
      } catch (error) {
        await this.logFailure({
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
        if (!data.present && !this.flaggedThisRun.has(`${game.id}|${data.id}`)) {
          hadWork = true;
          await this.writePackFlags(game, data.id, filename);
        }
        await this.recordRetrySuccess('pack', game.id, filename);
        continue;
      }

      hadWork = true;
      packAttempts += 1;
      if (!(await this.allowMoreBytes(data.size, prep))) {
        return this.stopRequested ? 'stop' : 'pause';
      }

      try {
        const bytes = await this.downloadPack(
          { gameId: game.id, title: game.title, size: data.size, sha256: data.sha256 },
          filename,
          sources,
          prep,
        );
        this.inflightBytes = Math.max(0, this.inflightBytes - data.size);
        job.packsDone += 1;
        job.bytes += bytes;
        await this.writePackFlags(game, data.id, filename);
        await this.recordRetrySuccess('pack', game.id, filename);
      } catch (error) {
        this.inflightBytes = Math.max(0, this.inflightBytes - data.size);
        if (isPermissionDenied(error)) {
          this.noteDenied(error);
          return 'stop';
        }
        if (this.abort?.signal.aborted) {
          return this.stopRequested ? 'stop' : 'pause';
        }
        if (this.skippedGames.has(game.id)) {
          this.deps.log.info(`The launcher installed ${game.title}; dropping ${filename} from the queue.`);
          continue;
        }
        packFailures += 1;
        job.packsFailed += 1;
        await this.recordRetry({
          kind: 'pack',
          gameId: game.id,
          title: game.title,
          target: filename,
          packId: data.id,
          sha256: data.sha256,
          size: data.size,
        }, error);
        await this.logFailure({
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

  /**
   * Retry everything whose backoff has elapsed. Runs before the main pass and
   * again after it, so a transient failure can be fixed in the same session.
   */
  private async runRetryPhase(prep: Preparation): Promise<void> {
    const due = this.retries.due();
    if (due.length === 0) {
      return;
    }
    const job = this.job!;
    const sources = this.sources();
    this.message = `Retrying ${formatCount(due.length)} failed download${due.length === 1 ? '' : 's'}...`;
    for (const entry of due) {
      if (this.stopRequested || this.pauseRequested) {
        return;
      }
      try {
        const handled = entry.kind === 'pack'
          ? await this.retryPack(entry, sources, prep)
          : await this.retryImage(entry);
        if (!handled) {
          return;
        }
      } catch (error) {
        if (isPermissionDenied(error)) {
          this.noteDenied(error);
          return;
        }
        if (this.abort?.signal.aborted) {
          return;
        }
        if (this.skippedGames.has(entry.gameId)) {
          // The launcher installed the game and we cancelled this transfer on
          // purpose; forget the entry instead of scheduling it again.
          await this.retries.forget(entry.key).catch(() => undefined);
        } else {
          await this.recordRetry({
            kind: entry.kind,
            gameId: entry.gameId,
            title: entry.title,
            target: entry.target,
            packId: entry.packId,
            sha256: entry.sha256,
            size: entry.size,
          }, error);
          await this.logFailure({
            kind: entry.kind,
            gameId: entry.gameId,
            gameTitle: entry.title,
            packId: entry.packId,
            url: entry.kind === 'pack' ? entry.target : undefined,
            path: entry.kind === 'image' ? entry.target : undefined,
            error: errorMessage(error),
            attempts: entry.attempts + 1,
          });
          this.deps.log.warn(`Retry failed for ${entry.target}: ${errorMessage(error)}`);
        }
      }
      this.updateTask(job, prep);
      await this.persist();
    }
    this.message = '';
  }

  /** Returns false when the job has to stop or pause before finishing. */
  private async retryPack(
    entry: RetryEntry,
    sources: { name: string; baseUrl: string }[],
    prep: Preparation,
  ): Promise<boolean> {
    const job = this.job!;
    if (this.skippedGames.has(entry.gameId)) {
      await this.retries.forget(entry.key);
      return true;
    }
    const target = path.join(this.deps.paths.dataPacksDir, entry.target);
    if (await existsNonEmpty(target)) {
      if (entry.packId === undefined || !this.flaggedThisRun.has(`${entry.gameId}|${entry.packId}`)) {
        await this.writePackFlags({ id: entry.gameId, title: entry.title }, entry.packId, entry.target);
      }
      await this.recordRetrySuccess('pack', entry.gameId, entry.target);
      return true;
    }

    const size = entry.size ?? 0;
    if (!(await this.allowMoreBytes(size, prep))) {
      return false;
    }
    try {
      const bytes = await this.downloadPack(
        { gameId: entry.gameId, title: entry.title, size, sha256: entry.sha256 },
        entry.target,
        sources,
        prep,
      );
      this.inflightBytes = Math.max(0, this.inflightBytes - size);
      job.packsDone += 1;
      job.bytes += bytes;
      await this.writePackFlags({ id: entry.gameId, title: entry.title }, entry.packId, entry.target);
      await this.recordRetrySuccess('pack', entry.gameId, entry.target);
      return true;
    } catch (error) {
      this.inflightBytes = Math.max(0, this.inflightBytes - size);
      throw error;
    }
  }

  private async retryImage(entry: RetryEntry): Promise<boolean> {
    if (this.skippedGames.has(entry.gameId)) {
      await this.retries.forget(entry.key);
      return true;
    }
    const target = safeJoin(this.deps.paths.imagesDir, entry.target);
    if (!target) {
      await this.retries.forget(entry.key);
      return true;
    }
    if (await existsNonEmpty(target)) {
      await this.recordRetrySuccess('image', entry.gameId, entry.target);
      return true;
    }
    if (!(await this.ensureReserve(IMAGE_ESTIMATE_BYTES))) {
      return false;
    }
    try {
      await this.downloadImage(entry.target, target);
      this.job!.imagesDone += 1;
      await this.recordRetrySuccess('image', entry.gameId, entry.target);
      return true;
    } finally {
      this.inflightBytes = Math.max(0, this.inflightBytes - IMAGE_ESTIMATE_BYTES);
    }
  }

  /**
   * After a pass, wait for retries that are due soon instead of ending the job
   * with failures that would otherwise sit until the user starts again.
   */
  private async waitForRetries(prep: Preparation): Promise<void> {
    const previousMessage = this.message;
    try {
      await this.waitForRetriesRounds(prep);
    } finally {
      if (this.stopRequested || this.pauseRequested) {
        this.message = previousMessage;
      }
    }
  }

  private async waitForRetriesRounds(prep: Preparation): Promise<void> {
    for (let round = 0; round < 2; round += 1) {
      if (this.stopRequested || this.pauseRequested) {
        return;
      }
      const wait = this.retries.nextDueIn();
      const limit = this.deps.retryWaitMs ?? RETRY_WAIT_LIMIT_MS;
      if (wait === null || wait > limit) {
        return;
      }
      if (wait > 0) {
        this.message = `Waiting ${Math.max(1, Math.ceil(wait / 1000))} s to retry `
          + `${formatCount(this.retries.count())} failed download(s).`;
        this.updateTask(this.job!, prep);
        if (!(await this.sleepUnlessStopped(wait))) {
          return;
        }
      }
      this.message = `Retrying ${formatCount(this.retries.count())} failed download(s)...`;
      this.updateTask(this.job!, prep);
      await this.runRetryPhase(prep);
    }
  }

  private async sleepUnlessStopped(ms: number): Promise<boolean> {
    const deadline = this.now() + ms;
    while (this.now() < deadline) {
      if (this.stopRequested || this.pauseRequested) {
        return false;
      }
      await sleep(Math.min(250, Math.max(1, deadline - this.now())));
    }
    return !this.stopRequested && !this.pauseRequested;
  }

  private async downloadPack(
    pack: { gameId: string; title: string; size: number; sha256?: string },
    filename: string,
    sources: { name: string; baseUrl: string }[],
    prep: Preparation,
  ): Promise<number> {
    const target = path.join(this.deps.paths.dataPacksDir, filename);
    let lastError: unknown = null;
    this.liveStartedAt = this.now();
    this.live = { gameId: pack.gameId, gameTitle: pack.title, received: 0, total: pack.size, bytesPerSecond: 0 };

    // Cancel this transfer if the launcher installs the game, without touching
    // the other workers' downloads.
    const controller = new AbortController();
    const jobSignal = this.abort?.signal;
    const onJobAbort = (): void => controller.abort();
    if (jobSignal) {
      if (jobSignal.aborted) {
        controller.abort();
      } else {
        jobSignal.addEventListener('abort', onJobAbort, { once: true });
      }
    }
    this.inflightDownloads.set(pack.gameId, controller);
    const signal = controller.signal;

    try {
      for (const source of sources) {
        for (let attempt = 0; attempt < 2; attempt += 1) {
          if (signal.aborted) {
            throw new Error('Download aborted');
          }
          const url = joinUrl(source.baseUrl, filename);
          try {
            this.deps.log.debug(`Downloading ${url}`);
            let lastReceived = 0;
            const result = await fetchToFile(url, target, {
              signal,
              expectedSha256: pack.sha256,
              onProgress: (received, total) => {
                this.transferBytes += Math.max(0, received - lastReceived);
                lastReceived = received;
                const elapsed = Math.max(1, (this.now() - this.liveStartedAt) / 1000);
                this.live = {
                  gameId: pack.gameId,
                  gameTitle: pack.title,
                  received,
                  total: total ?? pack.size ?? null,
                  bytesPerSecond: received / elapsed,
                };
              },
            });
            return result.bytes;
          } catch (error) {
            lastError = error;
            if (signal.aborted) {
              throw error;
            }
            if (isPermissionDenied(error)) {
              // A refusal is not a failed attempt to retry here or on another
              // source; it ends the job at once.
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
    } finally {
      if (jobSignal) {
        jobSignal.removeEventListener('abort', onJobAbort);
      }
      if (this.inflightDownloads.get(pack.gameId) === controller) {
        this.inflightDownloads.delete(pack.gameId);
      }
    }
  }

  private async downloadImage(subPath: string, target: string): Promise<void> {
    const prefs = this.deps.api.getPreferences();
    const base = (prefs.onDemandBaseUrl || '').trim();
    if (!base) {
      throw new Error('No image server configured in the launcher preferences');
    }
    // With the respect switch on, ask for the same format the launcher would
    // fetch. With it off, always take the original, uncompressed image.
    const compressed = this.settings?.respectFlashpointSettings !== false && !!prefs.onDemandImagesCompressed;
    const url = joinUrl(base, subPath) + (compressed ? '?type=jpg' : '');
    await fetchToFile(url, target, { signal: this.abort?.signal, timeoutMs: 30_000 });
  }

  /**
   * Mark a pack as present in the launcher database. The file is already on
   * disk at this point, so a write failure is recorded separately from a
   * download failure and repaired on the next pass.
   */
  private async writePackFlags(
    game: { id: string; title: string },
    packId: number | undefined,
    filename: string,
  ): Promise<void> {
    if (packId === undefined) {
      return;
    }
    try {
      await this.db.run(`the flag for ${filename}`, async () => {
        const full = await this.deps.api.findGame(game.id);
        if (!full) {
          throw new Error(`Game ${game.id} is no longer in the database`);
        }
        const stored = (full.gameData || []).find((data) => data.id === packId);
        if (!stored) {
          throw new Error(`Data pack ${packId} is no longer attached to ${game.id}`);
        }
        stored.presentOnDisk = true;
        stored.path = filename;
        await this.deps.api.saveGameData(stored);
        if (full.activeDataId === packId && !full.activeDataOnDisk) {
          full.activeDataOnDisk = true;
          await this.deps.api.updateGame(full);
        }
      });
      this.flaggedThisRun.add(`${game.id}|${packId}`);
    } catch (error) {
      const job = this.job;
      if (job) {
        job.packFlagsFailed = (job.packFlagsFailed ?? 0) + 1;
      }
      await this.logFailure({
        kind: 'flag',
        gameId: game.id,
        gameTitle: game.title,
        packId,
        url: filename,
        error: errorMessage(error),
      });
      this.deps.log.warn(
        `${filename} is on disk but its database flag could not be written: ${errorMessage(error)}`,
      );
    }
  }

  private async recordRetry(input: RetryInput, error: unknown): Promise<void> {
    try {
      await this.retries.recordFailure(input, error, { minDelayMs: retryAfterMsOf(error) });
    } catch (saveError) {
      this.deps.log.warn(`Could not update the retry queue: ${errorMessage(saveError)}`);
    }
  }

  private async recordRetrySuccess(
    kind: 'pack' | 'image',
    gameId: string,
    target: string,
  ): Promise<void> {
    try {
      await this.retries.recordSuccess(kind, gameId, target);
    } catch (error) {
      this.deps.log.warn(`Could not update the retry queue: ${errorMessage(error)}`);
    }
  }

  private async logFailure(failure: {
    kind: 'image' | 'pack' | 'flag';
    gameId: string;
    gameTitle: string;
    packId?: number;
    url?: string;
    path?: string;
    error: string;
    attempts?: number;
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
    if (this.orderEntries && this.job.order) {
      // The saved position is the first order entry not yet finished. Entries
      // handed to a worker but not done stay in front of it, so a stop or crash
      // retries those games instead of skipping them.
      const lowest = this.inflightOrder.size > 0 ? Math.min(...this.inflightOrder) : this.orderIndex;
      this.job.order.cursor = Math.min(this.orderEntries.length, Math.max(0, lowest));
      this.job.order.total = this.orderEntries.length;
      this.job.cursor = this.orderIndex >= this.orderEntries.length && this.inflightOrder.size === 0
        ? this.catalogSize
        : 0;
    } else {
      this.job.cursor = this.currentCursor();
    }
    if (this.priorityPlan && this.job.priority) {
      this.job.priority.cursor = this.priorityPlan.index;
    }
    if (this.changedOnly && this.job.changed) {
      this.job.changed.cursor = this.changedIndex;
      this.job.changed.total = this.changedEntries.length;
    }
    this.job.updatedAt = new Date(now).toISOString();
    if (this.running) {
      // Never overwrite a terminal status written by runJob().
      this.job.status = this.stopRequested ? 'stopped' : this.pauseRequested ? 'paused' : 'running';
      this.job.message = this.message || this.job.message;
    }
    this.job.retryPending = this.retries.count();
    await writeJsonAtomic(this.deps.paths.jobFile, this.jobForDisk())
      .catch((error) => this.deps.log.warn(`Could not save job state: ${errorMessage(error)}`));
  }

  /** The job as it should be written, with a bounded priority plan. */
  private jobForDisk(): JobState {
    const job = this.job!;
    if (!job.priority || job.priority.ids.length <= MAX_SAVED_PRIORITY_IDS) {
      return job;
    }
    return {
      ...job,
      priority: { ...job.priority, ids: job.priority.ids.slice(0, MAX_SAVED_PRIORITY_IDS) },
    };
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
    const doneBytes = this.changedOnly ? sessionBytes : Math.max(0, job.bytes);
    const total = prep.estimate.totalBytes > 0 ? prep.estimate.totalBytes : doneBytes + 1;
    const progress = Math.min(0.995, doneBytes / total);
    const pieces = [
      `${formatCount(job.gamesDone)} games`,
      `${formatCount(job.packsDone)} packs`,
      formatBytes(doneBytes),
      formatPercent(doneBytes, total),
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
    this.meter.reset();
    this.job = null;
    this.state = 'idle';
    this.message = '';
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The largest pending pack in one game that is worth probing, if any. */
function probeCandidateIn(record: CatalogGameRecord): { size: number; filename: string } | null {
  let best: { size: number; filename: string } | null = null;
  for (const data of record.data) {
    if (data.present) {
      continue;
    }
    const size = Number(data.size) || 0;
    if (size < PEAK_PROBE_MIN_BYTES || (best !== null && size <= best.size)) {
      continue;
    }
    try {
      best = { size, filename: gameDataFilename(data) };
    } catch {
      // A malformed dateAdded cannot name a file; skip it.
    }
  }
  return best;
}

function estimateFor(
  gamesInScope: number,
  packsMissing: number,
  packBytes: number,
  settings: Settings,
): Estimate {
  const imageEstimateBytes = settings.includeImages ? gamesInScope * 2 * IMAGE_ESTIMATE_BYTES : 0;
  return {
    gamesInScope,
    packsMissing,
    packBytes,
    imageEstimateBytes,
    totalBytes: packBytes + imageEstimateBytes,
  };
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
