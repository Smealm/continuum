import type * as flashpoint from 'flashpoint-launcher';
import type { ActivityTracker } from './core/activity';
import type { Catalog } from './core/catalog';
import type { Engine } from './core/engine';
import type { FastCatalog } from './core/sqlite';
import type { ContinuumApi, EngineMode, Logger, Paths, Settings } from './core/types';

export interface ContinuumContext {
  fp: typeof flashpoint;
  api: ContinuumApi;
  paths: Paths;
  log: Logger;
  catalog: Catalog;
  engine: Engine;
  activity: ActivityTracker;
  /** Fast database catalogue build, or null when sqlite3 cannot be found. */
  fastCatalog: FastCatalog | null;
  /** True unless "Fast Catalogue Build" is switched off in the settings. */
  readFastCatalogue(): boolean;
  readSettings(mode: EngineMode): Settings;
  /** Free bytes on the target volume, or null when the OS cannot tell us. */
  probeFreeBytes(target: string): Promise<number | null>;
}
