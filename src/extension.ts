import * as fs from 'fs';
import * as path from 'path';
import * as flashpoint from 'flashpoint-launcher';
import { createApi } from './api';
import type { ContinuumContext } from './context';
import { ActivityTracker } from './core/activity';
import { Catalog } from './core/catalog';
import { getFreeBytes } from './core/disk';
import { Engine, ProgressSink } from './core/engine';
import { readJson } from './core/jsonl';
import { resolveFlashpointRoot, resolvePaths } from './core/paths';
import { FastCatalog } from './core/sqlite';
import { JobState, Logger } from './core/types';
import { showProgress } from './liveprogress';
import { describeCatalogSource, openManager, scanCatalogue, startFlow } from './manager';
import { readSettings } from './settings';

let context: ContinuumContext | null = null;

const logger: Logger = {
  debug: (message) => flashpoint.log.debug(`[Continuum] ${message}`),
  info: (message) => flashpoint.log.info(`[Continuum] ${message}`),
  warn: (message) => flashpoint.log.warn(`[Continuum] ${message}`),
  error: (message) => flashpoint.log.error(`[Continuum] ${message}`),
};

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
  const sqliteCli = FastCatalog.findCli(flashpointRoot);
  const fastCatalog = sqliteCli
    ? new FastCatalog({
      dbPath: paths.databaseFile,
      cliPath: sqliteCli,
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
  };
  context = ctx;

  logger.info(`Loaded. Flashpoint folder: ${flashpointRoot}`);
  if (sqliteCli) {
    logger.info(`Fast catalogue build available (${sqliteCli}).`);
  } else {
    logger.info('No sqlite3 tool found in the Flashpoint folder; catalogue rebuilds use the tag scan.');
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
  register(flashpoint.commands.registerCommand('continuum.rescan', guard(async () => {
    if (ctx.engine.isRunning()) {
      await flashpoint.dialogs.showMessageBox({
        message: 'Pause or stop the current download before rebuilding the catalogue.',
        buttons: ['OK'],
      });
      return;
    }
    const choice = await flashpoint.dialogs.showMessageBox({
      message: `Rebuild the catalogue now?\n\n${describeCatalogSource(ctx)}`,
      buttons: ['Rebuild', 'Cancel'],
      cancelId: 1,
      largeMessage: true,
    });
    if (choice === 0) {
      await scanCatalogue(ctx);
    }
  })));
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

  register(flashpoint.onDidInit(() => {
    void maybeAutoResume(ctx);
  }));
}

export function deactivate(): void {
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

async function maybeAutoResume(ctx: ContinuumContext): Promise<void> {
  try {
    if (ctx.engine.isRunning()) {
      return;
    }
    const job = await readJson<JobState>(ctx.paths.jobFile);
    if (!job || (job.status !== 'paused' && job.status !== 'stopped' && job.status !== 'running')) {
      return;
    }
    const settings = ctx.readSettings(job.mode || 'passive');
    if (!settings.autoResume) {
      return;
    }
    const prep = await ctx.engine.prepare(settings);
    if (prep.estimate.totalBytes <= 0) {
      return;
    }
    const result = await ctx.engine.start(prep);
    if (result.ok) {
      ctx.log.info(`Auto-resumed the ${settings.mode} job (${job.status}).`);
    }
  } catch (error) {
    ctx.log.warn(`Could not auto-resume: ${errorMessage(error)}`);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
