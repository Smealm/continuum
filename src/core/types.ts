import type * as flashpoint from 'flashpoint-launcher';

/** How aggressively Continuum downloads. */
export type EngineMode = 'active' | 'passive';

/** What part of the archive a job covers. */
export type ScopeKind = 'all' | 'platform' | 'tag' | 'library' | 'playlist';

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
}

export interface Paths {
  flashpointRoot: string;
  dataPacksDir: string;
  imagesDir: string;
  stateDir: string;
  /** The launcher's own SQLite database, used by the fast catalogue build. */
  databaseFile: string;
  catalogFile: string;
  catalogMetaFile: string;
  failuresFile: string;
  jobFile: string;
}

export interface Settings {
  mode: EngineMode;
  scope: Scope;
  includeImages: boolean;
  /** Never go below this much free space on the target drive. */
  reserveBytes: number;
  /** Stop the job after this many bytes. 0 means no limit. */
  maxBytes: number;
  activeWorkers: number;
  passiveWorkers: number;
  passiveDelayMs: number;
  respectExtremeFilter: boolean;
  autoResume: boolean;
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
  status: JobStatus;
  message: string;
  updatedAt: string;
}
