import * as fs from 'fs';
import * as path from 'path';
import * as flashpoint from 'flashpoint-launcher';
import { createApi } from './api';
import type { ContinuumContext } from './context';
import { ActivityTracker } from './core/activity';
import { AUTO_CHECK_INTERVAL_MS, AutoDeps, runAutoTasks } from './core/auto';
import { Catalog } from './core/catalog';
import { getFreeBytes } from './core/disk';
import { Engine, ProgressSink } from './core/engine';
import { markInterruptedJob } from './core/jobstate';
import { readJson } from './core/jsonl';
import { resolveFlashpointRoot, resolvePaths } from './core/paths';
import { FastCatalog } from './core/sqlite';
import { JobState, Logger } from './core/types';
import { showProgress } from './liveprogress';
import {
  openManager,
  rebuildCatalogueFlow,
  reportCatalogueRebuild,
  scanCatalogue,
  startFlow,
} from './manager';
import { readConfiguredMode, readSettings } from './settings';

let context: ContinuumContext | null = null;
/** Checks the launcher database while the launcher is open, when auto is on. */
let autoTimer: NodeJS.Timeout | null = null;
let autoTickRunning = false;

const logger: Logger = {
  debug: (message) => flashpoint.log.debug(`[Continuum] ${message}`),
  info: (message) => flashpoint.log.info(`[Continuum] ${message}`),
  warn: (message) => flashpoint.log.warn(`[Continuum] ${message}`),
  error: (message) => flashpoint.log.error(`[Continuum] ${message}`),
};

function readConfigString(key: string): string {
  const value = flashpoint.getExtConfigValue(key);
  return typeof value === 'string' ? value.trim() : '';
}

export async function activate(extContext: flashpoint.ExtensionContext): Promise<void> {
  deactivate();

  const extensionPath = flashpoint.extensionPath || path.resolve(__dirname, '..');
  const api = createApi(flashpoint);
  const preferences = api.getPreferences();
  const flashpointRoot = resolveFlashpointRoot(flashpoint.config.flashpointPath, extensionPath);
  const paths = resolvePaths(flashpointRoot, preferences, extensionPath);

  try {
    await fs.promises.mkdir(paths.stateDir, { recursive: true });
  } catch (error) {
    logger.error(`Could not create state folder "${paths.stateDir}": ${errorMessage(error)}`);
  }

  const catalog = new Catalog(api, paths, logger);
  const sqliteCli = await FastCatalog.locate({
    flashpointRoot,
    configured: readConfigString('continuum.sqlitePath'),
    log: logger,
  });
  const fastCatalog = sqliteCli
    ? new FastCatalog({
      dbPath: paths.databaseFile,
      cliPath: sqliteCli.path,
      catalogFile: paths.catalogFile,
      catalogMetaFile: paths.catalogMetaFile,
      log: logger,
    })
    : null;
  const activity = new ActivityTracker();
  const probeFreeBytes = async (target: string): Promise<number | null> => {
    const free = await getFreeBytes(target);
    return free ? free.freeBytes : null;
  };
  const engine = new Engine({
    api,
    paths,
    log: logger,
    sink: createSink(),
    probeFree: async (target) => {
      const bytes = await probeFreeBytes(target);
      return bytes === null ? null : { freeBytes: bytes };
    },
    // Live, so switching "Playlist Games First" takes effect without a restart.
    readPrioritize: () => flashpoint.getExtConfigValue('continuum.prioritizePlaylists') === true,
  }, catalog);

  const ctx: ContinuumContext = {
    fp: flashpoint,
    api,
    paths,
    log: logger,
    catalog,
    engine,
    activity,
    fastCatalog,
    probeFreeBytes,
    readFastCatalogue: () => flashpoint.getExtConfigValue('continuum.fastCatalogue') !== false,
    readSettings: (mode) => readSettings(mode, (key) => flashpoint.getExtConfigValue(key)),
    readMode: () => readConfiguredMode((key) => flashpoint.getExtConfigValue(key)),
  };
  context = ctx;

  try {
    if (await markInterruptedJob(paths.jobFile)) {
      logger.warn('A previous download was interrupted. Its progress was kept and it can be resumed.');
    }
    await engine.loadState();
  } catch (error) {
    logger.warn(`Could not read the saved job state: ${errorMessage(error)}`);
  }

  logger.info(`Loaded. Flashpoint folder: ${flashpointRoot}`);
  if (sqliteCli) {
    logger.info(`Fast catalogue build available (sqlite ${sqliteCli.version} at ${sqliteCli.path}).`);
  } else {
    logger.info('No working sqlite3 tool found in the Flashpoint folder or on PATH; catalogue rebuilds use the tag scan.');
  }

  const register = (disposable: flashpoint.Disposable): void => {
    flashpoint.registerDisposable(extContext.subscriptions, disposable);
  };
  const guard = (task: () => Promise<unknown>): (() => void) => () => {
    void task().catch((error) => logger.error(`Command failed: ${errorMessage(error)}`));
  };

  register(flashpoint.commands.registerCommand('continuum.manager', guard(() => openManager(ctx))));
  register(flashpoint.commands.registerCommand('continuum.progress', guard(() => showProgress(ctx))));
  register(flashpoint.commands.registerCommand('continuum.startActive', guard(() => startFlow(ctx, 'active'))));
  register(flashpoint.commands.registerCommand('continuum.startPassive', guard(() => startFlow(ctx, 'passive'))));
  register(flashpoint.commands.registerCommand('continuum.pause', () => {
    if (ctx.engine.pause()) {
      logger.info('Pausing after the current game. Progress is saved.');
      void flashpoint.dialogs.showMessageBox({
        message: 'Continuum is pausing after the current game. Progress is saved.',
        buttons: ['OK'],
      }).catch(() => undefined);
    } else {
      void flashpoint.dialogs.showMessageBox({
        message: 'Continuum is not downloading right now.',
        buttons: ['OK'],
      }).catch(() => undefined);
    }
  }));
  register(flashpoint.commands.registerCommand('continuum.status', guard(() => showProgress(ctx))));
  // One rebuild path, so the settings button and the manager both get the
  // confirmation and the comparison with the previous catalogue.
  register(flashpoint.commands.registerCommand('continuum.rescan', guard(() => rebuildCatalogueFlow(ctx))));
  register(flashpoint.commands.registerCommand('continuum.reset', guard(async () => {
    const choice = await flashpoint.dialogs.showMessageBox({
      message: 'Reset saved download progress? Files already on disk are kept and skipped.',
      buttons: ['Reset', 'Cancel'],
      cancelId: 1,
    });
    if (choice === 0) {
      await ctx.engine.resetJob();
      await flashpoint.dialogs.showMessageBox({ message: 'Saved progress cleared.', buttons: ['OK'] });
    }
  })));
  register(flashpoint.commands.registerCommand('continuum.mirrorPlaylist', (playlist?: flashpoint.Playlist) => {
    if (!playlist || !playlist.title) {
      void flashpoint.dialogs.showMessageBox({
        message: 'Right-click a playlist and choose "Mirror with Continuum".',
        buttons: ['OK'],
      });
      return;
    }
    void startFlow(ctx, 'active', { kind: 'playlist', value: playlist.title })
      .catch((error) => logger.error(`Playlist mirror failed: ${errorMessage(error)}`));
  }));

  // The user installed a game in the launcher while Continuum is running (or
  // while it is paused): drop it from this run's queue and cancel our copy.
  register(flashpoint.games.onDidInstallGameData((data) => {
    if (data && data.gameId) {
      ctx.engine.noteGameInstalled(data.gameId);
    }
  }));
  register(flashpoint.games.onDidUninstallGameData((data) => {
    if (data && data.gameId) {
      ctx.engine.noteGameUninstalled(data.gameId);
    }
  }));

  register(flashpoint.onExtConfigChange((change) => {
    // Switching the master switch on should not wait for the next check.
    if (change && change.key === 'continuum.autoMirror' && change.value === true) {
      void runAuto(ctx);
    }
  }));

  register(flashpoint.onDidInit(() => {
    void runAuto(ctx);
    if (!autoTimer) {
      autoTimer = setInterval(() => {
        void runAuto(ctx);
      }, AUTO_CHECK_INTERVAL_MS);
      // Never keep a closing launcher or a test process alive for this.
      autoTimer.unref?.();
    }
  }));
}

export function deactivate(): void {
  if (autoTimer) {
    clearInterval(autoTimer);
    autoTimer = null;
  }
  if (context) {
    context.engine.stop();
    context = null;
  }
}

function createSink(): ProgressSink {
  return {
    createTask(name: string): string | null {
      try {
        const task = flashpoint.status.newTask({
          name,
          status: 'Starting...',
          progress: 0,
          finished: false,
        });
        return task.id;
      } catch (error) {
        logger.warn(`Could not create task: ${errorMessage(error)}`);
        return null;
      }
    },
    updateTask(taskId, update): void {
      try {
        flashpoint.status.setTask({ id: taskId, ...update });
      } catch (error) {
        logger.debug(`Could not update task: ${errorMessage(error)}`);
      }
    },
    notify(message, level): void {
      if (level === 'error') {
        logger.error(message);
      } else if (level === 'warn') {
        logger.warn(message);
      } else {
        logger.info(message);
      }
      if (level !== 'info') {
        void flashpoint.dialogs.showMessageBox({
          message,
          buttons: ['OK'],
          largeMessage: true,
        }).catch(() => undefined);
      }
    },
  };
}

/**
 * The automatic tasks, as one check: rebuild when the launcher database moved,
 * continue a saved job, handle the games a rebuild changed, or start a new
 * pass when something is missing. See core/auto.ts for the decision itself.
 */
function autoDeps(ctx: ContinuumContext): AutoDeps {
  return {
    log: logger,
    paths: ctx.paths,
    readSettings: (mode) => ctx.readSettings(mode),
    readDataVersion: () => flashpoint.dataVersion,
    loadMeta: () => ctx.catalog.loadMeta(),
    pendingChanges: (meta) => ctx.engine.pendingChanges(meta),
    rebuild: async () => {
      const meta = await scanCatalogue(ctx, { quiet: true });
      if (!meta) {
        return null;
      }
      const report = await reportCatalogueRebuild(ctx, meta);
      return { meta, changed: report.changed };
    },
    prepare: (settings, options) => ctx.engine.prepare(settings, options),
    start: (prep) => ctx.engine.start(prep),
    isRunning: () => ctx.engine.isRunning(),
    readJob: () => readJson<JobState>(ctx.paths.jobFile),
  };
}

async function runAuto(ctx: ContinuumContext): Promise<void> {
  if (autoTickRunning) {
    return;
  }
  autoTickRunning = true;
  try {
    await runAutoTasks(autoDeps(ctx));
  } catch (error) {
    logger.warn(`Automatic tasks failed: ${errorMessage(error)}`);
  } finally {
    autoTickRunning = false;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
