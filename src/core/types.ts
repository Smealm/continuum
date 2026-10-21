import type * as flashpoint from 'flashpoint-launcher';

/** How aggressively Continuum downloads. */
export type EngineMode = 'active' | 'passive';

/** What part of the archive a job covers. */
export type ScopeKind = 'all' | 'platform' | 'tag' | 'library' | 'playlist';

/**
 * The order a full pass handles games in. `smallest` processes the games with
 * the fewest bytes still missing first, so the largest number of titles becomes
 * usable earliest; `catalogue` is the old byte-cursor order.
 */
export type DownloadOrder = 'smallest' | 'catalogue';

export interface Scope {
  kind: ScopeKind;
  /** Platform name, tag name, library name or playlist title. Unused for "all". */
  value: string;
}

export interface Logger {
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

/** The preferences Continuum reads. Kept structural so it is easy to fake in tests. */
export interface ContinuumPreferences {
  dataPacksFolderPath: string;
  imageFolderPath: string;
  onDemandBaseUrl: string;
  onDemandImages: boolean;
  onDemandImagesCompressed: boolean;
  gameDataSources: flashpoint.GameDataSource[];
  disableExtremeGames: boolean;
  tagFilters: { extreme: boolean; tags: string[] }[];
}

/**
 * The slice of the launcher API Continuum uses. Everything is called through
 * this interface so core logic can be tested without a running launcher.
 */
export interface ContinuumApi {
  getPreferences(): ContinuumPreferences;
  countGames(): Promise<number>;
  findTags(name?: string): Promise<flashpoint.Tag[]>;
  findGamesWithTag(tag: string): Promise<flashpoint.Game[]>;
  findGame(id: string): Promise<flashpoint.Game | null>;
  saveGameData(data: flashpoint.GameData): Promise<flashpoint.GameData>;
  updateGame(game: flashpoint.Game): Promise<flashpoint.Game>;
  findPlaylistByName(name: string, join?: boolean): flashpoint.Playlist | null | undefined;
  /** All playlists, without their games (the launcher returns them synchronously). */
  findPlaylists(showExtreme: boolean): flashpoint.Playlist[];
  /** One playlist, optionally with its games. */
  findPlaylist(id: string, join?: boolean): flashpoint.Playlist | null | undefined;
}

/**
 * One game that changed since the last catalogue rebuild, with where its record
 * starts in `catalog.jsonl`. The offset lets a changed-only pass read just that
 * record instead of walking the whole catalogue.
 */
export interface ChangedEntry {
  id: string;
  offset: number;
}

/** `state/changed.json`, written by a rebuild that could compare catalogues. */
export interface ChangedList {
  version: 1;
  generation: string;
  scannedAt: string;
  entries: ChangedEntry[];
}

/**
 * `state/rebuild.json`: the last rebuild's comparison with the catalogue it
 * replaced, so the manager can show it without re-running the diff.
 */
export interface RebuildReportState {
  version: 1;
  generation: string;
  updatedAt: string;
  /** `describeDiff()` output; empty when there was no previous catalogue. */
  summary: string;
  /** Games written to the changed list by that rebuild. */
  changed: number;
}

export interface Paths {
  flashpointRoot: string;
  dataPacksDir: string;
  imagesDir: string;
  stateDir: string;
  /** The launcher's own SQLite database, used by the fast catalogue build. */
  databaseFile: string;
  /** Signature of the database the last rebuild read, so changes are noticed. */
  databaseStateFile: string;
  catalogFile: string;
  catalogMetaFile: string;
  /** The catalogue the last rebuild replaced, used for the rebuild report. */
  catalogPreviousFile: string;
  /** Games that changed in the last rebuild, for a changed-only pass. */
  changedFile: string;
  /** The last rebuild's diff summary, for the manager. */
  rebuildReportFile: string;
  /** Present when the archive host refused access; pauses automatic work. */
  deniedFile: string;
  failuresFile: string;
  retriesFile: string;
  jobFile: string;
}

export interface Settings {
  mode: EngineMode;
  scope: Scope;
  /**
   * Whether logos and screenshots are part of the job. Not a Continuum setting:
   * `Engine.prepare` resolves it from the launcher's image caching preference
   * while `respectFlashpointSettings` is on. With that switch off the launcher
   * is ignored and images are cached anyway, because there is no separate
   * Continuum switch that could turn them off. The effective value is recorded
   * here so the estimate, the scope key and every worker agree.
   */
  includeImages: boolean;
  /** Never go below this much free space on the target drive. */
  reserveBytes: number;
  /** Stop the job after this many bytes. 0 means no limit. */
  maxBytes: number;
  activeWorkers: number;
  passiveWorkers: number;
  passiveDelayMs: number;
  /**
   * Follow the launcher's own preferences: skip extreme-rated games, request
   * compressed images and skip logos and screenshots when the launcher does not
   * cache them. When off, the extreme filter is ignored, images are fetched
   * uncompressed, and images are cached even if the launcher's image caching is
   * off — there is no Continuum switch of its own to say otherwise.
   */
  respectFlashpointSettings: boolean;
  /**
   * One switch for all automation: resume or continue at launcher start,
   * rebuild the catalogue when the launcher database changes, and download the
   * games that rebuild changed. Replaces `continuum.autoResume` (0.3.0).
   */
  autoMirror: boolean;
  /** Download games from the user's playlists before the rest of the queue. */
  prioritizePlaylists: boolean;
  /** Order of a full pass: smallest remaining first, or catalogue order. */
  order: DownloadOrder;
  /**
   * Let the engine raise and lower the number of parallel transfers while a
   * job runs, up to the configured worker ceiling. Passive mode stays fixed.
   */
  adaptiveWorkers: boolean;
}

export type JobStatus = 'idle' | 'running' | 'paused' | 'stopped' | 'done' | 'error';

/** Persisted progress, written next to the catalogue. */
export interface JobState {
  version: 1;
  generation: string;
  scopeKey: string;
  /** Mode used for this job, so Resume uses the same one. */
  mode: EngineMode;
  /** Byte offset in the catalogue file. Records before this were already handled. */
  cursor: number;
  bytes: number;
  packsDone: number;
  packsFailed: number;
  gamesDone: number;
  gamesFailed: number;
  imagesDone: number;
  /** Packs whose file landed but whose database flag could not be written. */
  packFlagsFailed?: number;
  /** Downloads waiting in the retry queue when this state was saved. */
  retryPending?: number;
  status: JobStatus;
  message: string;
  updatedAt: string;
  /**
   * Playlist priority plan. `ids` is the order games are pulled forward in and
   * `cursor` is how many of them were handled, so a pause or crash resumes the
   * plan instead of starting it over.
   */
  priority?: {
    generation: string;
    ids: string[];
    cursor: number;
  };
  /**
   * Changed-only pass. The list itself lives in `state/changed.json` and is
   * re-read on resume, so `job.json` stays small even for thousands of games.
   */
  changed?: {
    generation: string;
    cursor: number;
    total: number;
  };
  /**
   * Smallest-first queue position. The queue is the whole catalogue sorted by
   * remaining bytes, rebuilt deterministically from the same generation and
   * scope, so `cursor` (an index into it) is enough to resume. `cursor` sits at
   * the first game not yet finished; games handed to a worker stay behind it.
   */
  order?: {
    generation: string;
    scopeKey: string;
    cursor: number;
    total: number;
  };
}
