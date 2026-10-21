import type { ContinuumContext } from './context';
import { CatalogMeta } from './core/catalog';
import { Preparation } from './core/engine';
import { formatBytes, formatCount } from './core/format';
import { describeScope } from './core/scope';
import { catalogSource, FastCatalog, FastScanProgress } from './core/sqlite';
import { EngineMode, Scope } from './core/types';
import { showProgress } from './liveprogress';

let managerOpen = false;

export async function openManager(ctx: ContinuumContext): Promise<void> {
  if (managerOpen) {
    return;
  }
  managerOpen = true;
  try {
    for (;;) {
      const snap = ctx.engine.snapshot();
      const resumeLabel = snap.status === 'running' ? 'Pause' : 'Resume';
      const buttons = [
        'Start active',
        'Start passive',
        'Live progress',
        resumeLabel,
        'Stop now',
        'Rebuild catalogue',
        'Reset saved progress',
        'Close',
      ];
      const index = await ctx.fp.dialogs.showMessageBox({
        message: await statusText(ctx),
        buttons,
        cancelId: 7,
        largeMessage: true,
        userCanCancel: true,
      });

      switch (index) {
        case 0:
          await startFlow(ctx, 'active');
          break;
        case 1:
          await startFlow(ctx, 'passive');
          break;
        case 2:
          await showProgress(ctx);
          break;
        case 3:
          await togglePause(ctx);
          break;
        case 4:
          await stopFlow(ctx);
          break;
        case 5:
          await rebuildCatalogueFlow(ctx);
          break;
        case 6:
          await resetFlow(ctx);
          break;
        default:
          return;
      }
    }
  } finally {
    managerOpen = false;
  }
}

async function stopFlow(ctx: ContinuumContext): Promise<void> {
  if (ctx.engine.stop()) {
    await info(ctx, 'Stopping the current transfer. Progress is saved; Start resumes later.');
  } else {
    await info(ctx, 'Continuum is not downloading right now.');
  }
}

async function togglePause(ctx: ContinuumContext): Promise<void> {
  const snap = ctx.engine.snapshot();
  if (snap.status === 'running') {
    ctx.engine.pause();
    await info(ctx, 'Continuum is pausing after the current game. Progress is saved.');
    return;
  }
  if (!snap.job) {
    await info(ctx, 'There is no saved job to resume yet. Start a download first.');
    return;
  }
  await startFlow(ctx, snap.job.mode || 'passive');
}

export async function startFlow(
  ctx: ContinuumContext,
  mode: EngineMode,
  scopeOverride?: Scope,
): Promise<void> {
  if (ctx.engine.isRunning()) {
    await info(ctx, 'Continuum is already downloading. Pause it first if you want to change settings.');
    return;
  }

  let meta = await ctx.catalog.loadMeta();
  if (!meta) {
    const choice = await ctx.fp.dialogs.showMessageBox({
      message: 'Continuum has no catalogue of the archive yet.\n\n'
        + 'It only needs to be built once, and again after big metadata updates.\n\n'
        + describeCatalogSource(ctx),
      buttons: ['Build catalogue', 'Cancel'],
      cancelId: 1,
      largeMessage: true,
    });
    if (choice !== 0) {
      return;
    }
    meta = await scanCatalogue(ctx);
    if (!meta) {
      return;
    }
  }

  const settings = ctx.readSettings(mode);
  if (scopeOverride) {
    settings.scope = scopeOverride;
  }

  let prep: Preparation;
  try {
    prep = await ctx.engine.prepare(settings);
  } catch (error) {
    await info(ctx, `Could not prepare the job:\n\n${error instanceof Error ? error.message : String(error)}`);
    return;
  }

  if (prep.estimate.gamesInScope === 0) {
    await info(ctx, `Nothing matches the current scope (${describeScope(settings.scope)}). Check the scope settings.`);
    return;
  }
  if (prep.estimate.totalBytes === 0) {
    await info(ctx, 'Everything in this scope is already on disk.');
    return;
  }

  const tooBig = prep.fits === false;
  const message = buildStartMessage(prep);
  const choice = await ctx.fp.dialogs.showMessageBox({
    message,
    buttons: tooBig ? ['Start anyway', 'Cancel'] : ['Start', 'Cancel'],
    cancelId: 1,
    largeMessage: true,
  });
  if (choice !== 0) {
    return;
  }

  const result = await ctx.engine.start(prep);
  if (!result.ok) {
    await info(ctx, result.reason || 'Continuum could not start.');
    return;
  }
  ctx.log.info(`Continuum ${mode} job started (${describeScope(settings.scope)}).`);
}

export function buildStartMessage(prep: Preparation): string {
  const { estimate, settings } = prep;
  const lines = [
    `Continuum - ${settings.mode} download`,
    '',
    `Scope: ${describeScope(settings.scope)}`,
    `Games: ${formatCount(estimate.gamesInScope)}`,
    `Data packs to download: ${formatCount(estimate.packsMissing)} (${formatBytes(estimate.packBytes)})`,
  ];
  if (settings.includeImages) {
    lines.push(`Logos and screenshots: up to ${formatBytes(estimate.imageEstimateBytes)} (estimated)`);
  }
  lines.push(`Estimated total: ${formatBytes(estimate.totalBytes)}`);
  if (prep.freeBytes === null) {
    lines.push('Free space: could not be read');
  } else {
    lines.push(`Free space: ${formatBytes(prep.freeBytes)} (keeping ${formatBytes(settings.reserveBytes)} in reserve)`);
  }
  if (settings.maxBytes > 0) {
    lines.push(`Job limit: ${formatBytes(settings.maxBytes)}`);
  }
  if (prep.resumable) {
    lines.push('', 'A saved job for this catalogue and scope exists, so this continues where it left off.');
  }
  if (prep.warnings.length > 0) {
    lines.push('');
    for (const warning of prep.warnings) {
      lines.push(`Warning: ${warning}`);
    }
  }
  lines.push('', `Catalogue built ${new Date(prep.meta.scannedAt).toLocaleString()}.`);
  return lines.join('\n');
}

/** One line describing how the next rebuild will run, for the dialogs. */
export function describeCatalogSource(ctx: ContinuumContext): string {
  const source = catalogSource(ctx.readFastCatalogue(), ctx.fastCatalog !== null);
  if (source === 'database') {
    return 'Fast build: on. Reads the launcher database directly (about a minute).';
  }
  if (ctx.fastCatalog === null) {
    return 'Fast build: unavailable, because no sqlite3 tool was found in the Flashpoint folder. '
      + 'The rebuild reads every tag instead, which can take hours.';
  }
  return 'Fast build: switched off in the settings. The rebuild reads every tag instead, which can take hours.';
}

export async function scanCatalogue(ctx: ContinuumContext): Promise<CatalogMeta | null> {
  if (ctx.engine.isRunning()) {
    await info(ctx, 'Pause or stop the current download before rebuilding the catalogue.');
    return null;
  }

  const source = catalogSource(ctx.readFastCatalogue(), ctx.fastCatalog !== null);
  const task = ctx.fp.status.newTask({
    name: 'Continuum catalogue',
    status: source === 'database' ? 'Reading the launcher database...' : 'Reading tags...',
    progress: 0,
    finished: false,
  });

  ctx.activity.begin('catalogue');
  try {
    let meta: CatalogMeta;
    if (source === 'database' && ctx.fastCatalog) {
      try {
        meta = await scanFromDatabase(ctx, ctx.fastCatalog, task.id);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/cancelled/i.test(message)) {
          throw error;
        }
        ctx.log.warn(`Fast catalogue build failed, falling back to the tag scan: ${message}`);
        await info(ctx, `Reading the launcher database did not work:\n\n${message}\n\n`
          + 'Continuing with the tag scan, which reads every tag and takes much longer.');
        meta = await scanFromTags(ctx, task.id);
      }
    } else {
      meta = await scanFromTags(ctx, task.id);
    }
    ctx.activity.finish(`Catalogue rebuilt: ${formatCount(meta.games)} games, ${formatCount(meta.packs)} packs`);
    ctx.fp.status.setTask({
      id: task.id,
      status: `Done: ${formatCount(meta.games)} games, ${formatCount(meta.packs)} data packs`,
      progress: 1,
      finished: true,
    });
    return meta;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.activity.fail(message);
    ctx.fp.status.setTask({ id: task.id, status: 'Failed', finished: true, error: message });
    await info(ctx, `Catalogue rebuild failed:\n\n${message}`);
    return null;
  }
}

async function scanFromDatabase(
  ctx: ContinuumContext,
  fastCatalog: FastCatalog,
  taskId: string,
): Promise<CatalogMeta> {
  return fastCatalog.scan({
    signal: new AbortController().signal,
    onProgress: (progress: FastScanProgress) => {
      ctx.activity.update(progress.percent, [
        `${progress.label} (stage ${progress.stage} / ${progress.stages})`,
        `${formatCount(progress.games)} games · ${formatCount(progress.packs)} packs`,
      ]);
      ctx.fp.status.setTask({
        id: taskId,
        status: `${progress.label} · ${formatCount(progress.games)} games`,
        progress: progress.percent,
      });
    },
  });
}

async function scanFromTags(ctx: ContinuumContext, taskId: string): Promise<CatalogMeta> {
  return ctx.catalog.scan({
    signal: new AbortController().signal,
    onProgress: (progress) => {
      const percent = progress.tagsTotal > 0 ? progress.tagsScanned / progress.tagsTotal : 0;
      ctx.activity.update(percent, [
        `Tag ${formatCount(progress.tagsScanned)} / ${formatCount(progress.tagsTotal)}`,
        `${formatCount(progress.games)} games found · ${formatCount(progress.packs)} packs`,
      ]);
      ctx.fp.status.setTask({
        id: taskId,
        status: `${formatCount(progress.tagsScanned)} / ${formatCount(progress.tagsTotal)} tags · ${formatCount(progress.games)} games`,
        progress: percent,
      });
    },
  });
}

async function rebuildCatalogueFlow(ctx: ContinuumContext): Promise<void> {
  const choice = await ctx.fp.dialogs.showMessageBox({
    message: 'Rebuild the catalogue?\n\n'
      + `${describeCatalogSource(ctx)}\n\n`
      + 'Existing downloads are untouched, and a running job is blocked until it finishes.',
    buttons: ['Rebuild', 'Cancel'],
    cancelId: 1,
    largeMessage: true,
  });
  if (choice !== 0) {
    return;
  }
  const meta = await scanCatalogue(ctx);
  if (meta) {
    await info(ctx, `Catalogue rebuilt: ${formatCount(meta.games)} games and ${formatCount(meta.packs)} data packs.\n\n`
      + `${formatCount(meta.packsMissing)} packs are missing (${formatBytes(meta.bytesMissing)}).`
      + (meta.source === 'database' ? '\n\nRead directly from the launcher database.' : ''));
  }
}

async function resetFlow(ctx: ContinuumContext): Promise<void> {
  const choice = await ctx.fp.dialogs.showMessageBox({
    message: 'Reset saved progress?\n\nThe next download will start again from the first game in the catalogue. '
      + 'Files that are already on disk are skipped, so this does not re-download them.',
    buttons: ['Reset', 'Cancel'],
    cancelId: 1,
    largeMessage: true,
  });
  if (choice !== 0) {
    return;
  }
  await ctx.engine.resetJob();
  await info(ctx, 'Saved progress cleared.');
}

export async function statusText(ctx: ContinuumContext): Promise<string> {
  const snap = ctx.engine.snapshot();
  const scan = ctx.activity.snapshot();
  const lines: string[] = [`Continuum - ${statusLabel(snap.status)}`];
  if (scan.running) {
    lines.push('Catalogue rebuild in progress.');
  }
  if (snap.message) {
    lines.push(snap.message);
  }
  lines.push('');

  const meta = snap.meta || await ctx.catalog.loadMeta();
  if (!meta) {
    lines.push('Catalogue: not built yet');
  } else {
    lines.push(`Catalogue: ${formatCount(meta.games)} games · ${formatCount(meta.packs)} packs`);
    lines.push(`Missing from disk: ${formatCount(meta.packsMissing)} packs · ${formatBytes(meta.bytesMissing)}`);
    lines.push(`Built: ${new Date(meta.scannedAt).toLocaleString()}`);
  }

  const job = snap.job;
  if (job) {
    lines.push('');
    lines.push(`Job: ${job.status} (${job.mode})`);
    lines.push(`Downloaded: ${formatCount(job.gamesDone)} games · ${formatCount(job.packsDone)} packs · ${formatBytes(job.bytes)}`);
    if (job.imagesDone > 0) {
      lines.push(`Images: ${formatCount(job.imagesDone)}`);
    }
    if (job.packsFailed > 0 || job.gamesFailed > 0) {
      lines.push(`Failures: ${formatCount(job.packsFailed)} packs in ${formatCount(job.gamesFailed)} games (see failures.jsonl)`);
    }
    if (job.updatedAt) {
      lines.push(`Last saved: ${new Date(job.updatedAt).toLocaleString()}`);
    }
  }

  const free = await ctx.probeFreeBytes(ctx.paths.dataPacksDir);
  if (free !== null) {
    lines.push(`Free space: ${formatBytes(free)}`);
  }

  const live = snap.live;
  if (live) {
    const total = live.total ? ` / ${formatBytes(live.total)}` : '';
    lines.push('');
    lines.push(`Now: ${live.gameTitle}`);
    lines.push(`${formatBytes(live.received)}${total} · ${formatBytes(live.bytesPerSecond)}/s`);
  }

  lines.push('', 'Use "Live progress" for a window that updates while the job runs.');
  return lines.join('\n');
}

function statusLabel(status: string): string {
  switch (status) {
    case 'running': return 'downloading';
    case 'paused': return 'paused';
    case 'stopped': return 'stopped';
    case 'done': return 'finished';
    case 'error': return 'error';
    default: return 'idle';
  }
}

async function info(ctx: ContinuumContext, message: string): Promise<void> {
  try {
    await ctx.fp.dialogs.showMessageBox({ message, buttons: ['OK'], largeMessage: message.length > 260 });
  } catch (error) {
    ctx.log.warn(`Could not show dialog: ${error instanceof Error ? error.message : String(error)}`);
  }
}
