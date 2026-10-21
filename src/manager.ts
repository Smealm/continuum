import type { ContinuumContext } from './context';
import { currentDatabaseSignature, writeAutoState } from './core/auto';
import { CatalogMeta, previousCatalogPath } from './core/catalog';
import { Preparation } from './core/engine';
import { formatBytes, formatCount, progressBar } from './core/format';
import { readJson, writeJsonAtomic } from './core/jsonl';
import {
  CatalogueDiff,
  deletePacks,
  describeDiff,
  diffCatalogues,
  OrphanPack,
  OrphanScan,
  scanOrphanPacks,
  writeChangedList,
} from './core/reconcile';
import { clearDenial, readDenial } from './core/permission';
import { describeScope } from './core/scope';
import { catalogSource, FastCatalog, FastScanProgress } from './core/sqlite';
import {
  EngineMode,
  JobState,
  JobStatus,
  RebuildReportState,
  Scope,
  Settings,
} from './core/types';
import { showProgress } from './liveprogress';

let managerOpen = false;

/**
 * One status card and five buttons. Start and Pause are the same button, the
 * configured mode decides how a new pass runs, and everything else lives one
 * level down so the card stays short.
 */
export async function openManager(ctx: ContinuumContext): Promise<void> {
  if (managerOpen) {
    return;
  }
  managerOpen = true;
  try {
    for (;;) {
      const { snap, job } = await managerState(ctx);
      const buttons = [managerActionLabel(snap.status, job), 'Live progress', 'Catalogue', 'Settings', 'Close'];
      const index = await ctx.fp.dialogs.showMessageBox({
        message: await managerCard(ctx, snap, job),
        buttons,
        cancelId: 4,
        largeMessage: true,
        userCanCancel: true,
      });

      switch (index) {
        case 0:
          if (snap.status === 'running') {
            await pauseFlow(ctx);
          } else {
            await startFromManager(ctx, job);
          }
          break;
        case 1:
          await showProgress(ctx);
          break;
        case 2:
          await catalogueMenu(ctx);
          break;
        case 3:
          await settingsMenu(ctx);
          break;
        default:
          return;
      }
    }
  } finally {
    managerOpen = false;
  }
}

/** The engine's snapshot plus the saved job, so a restart still shows one. */
async function managerState(ctx: ContinuumContext): Promise<{
  snap: ReturnType<ContinuumContext['engine']['snapshot']>;
  job: JobState | null;
}> {
  const snap = ctx.engine.snapshot();
  const job = snap.job || await readJson<JobState>(ctx.paths.jobFile);
  return { snap, job };
}

/** Pause, Resume or Start: the one button depends on what is already saved. */
export function managerActionLabel(status: JobStatus, job: JobState | null): string {
  if (status === 'running') {
    return 'Pause';
  }
  if (job && (job.status === 'paused' || job.status === 'stopped' || job.status === 'running' || job.status === 'idle')) {
    return 'Resume';
  }
  return 'Start';
}

async function pauseFlow(ctx: ContinuumContext): Promise<void> {
  if (ctx.engine.pause()) {
    await info(ctx, 'Continuum is pausing after the current game. Progress is saved.');
  } else {
    await info(ctx, 'Continuum is not downloading right now.');
  }
}

/**
 * Start or continue with the configured mode; a saved job keeps the mode it
 * was started with so Resume really resumes.
 */
async function startFromManager(ctx: ContinuumContext, job: JobState | null): Promise<void> {
  const savedMode = job && job.status !== 'done' && job.status !== 'error' ? job.mode : null;
  await startFlow(ctx, savedMode || ctx.readMode());
}

async function managerCard(
  ctx: ContinuumContext,
  snap: ReturnType<ContinuumContext['engine']['snapshot']>,
  job: JobState | null,
): Promise<string> {
  const meta = snap.meta || await ctx.catalog.loadMeta();
  const settings = ctx.readSettings(job?.mode || ctx.readMode());
  const freeBytes = await ctx.probeFreeBytes(ctx.paths.dataPacksDir);
  return buildStatusCard({
    status: snap.status,
    catalogueBusy: ctx.activity.snapshot().running,
    meta,
    job,
    percent: snap.progress.percent,
    sessionBytes: snap.progress.sessionBytes,
    estimateBytes: snap.progress.estimateBytes,
    retryPending: snap.retryPending,
    freeBytes,
    reserveBytes: settings.reserveBytes,
    message: snap.message,
  });
}

export interface StatusCardInput {
  status: JobStatus;
  /** A catalogue rebuild is running, which the download engine does not know about. */
  catalogueBusy: boolean;
  meta: CatalogMeta | null;
  job: JobState | null;
  /** 0..1 for the current session, from the engine snapshot. */
  percent: number;
  sessionBytes: number;
  estimateBytes: number;
  retryPending: number;
  freeBytes: number | null;
  reserveBytes: number;
  message?: string;
}

/** Four or five lines: state, catalogue, job, progress and free space. */
export function buildStatusCard(input: StatusCardInput): string {
  const lines = [`Continuum — ${input.catalogueBusy ? 'rebuilding the catalogue' : statusWord(input.status)}`];
  lines.push(catalogueLine(input.meta));
  lines.push(jobLine(input));
  if (input.job && input.estimateBytes > 0) {
    const percent = Math.round(clamp01(input.percent) * 100);
    lines.push(`Progress: ${progressBar(input.percent)} ${percent}% · ${formatBytes(input.sessionBytes)} of ${formatBytes(input.estimateBytes)}`);
  }
  lines.push(input.freeBytes === null
    ? 'Free space: unavailable'
    : `Free space: ${formatBytes(input.freeBytes)} (keeping ${formatBytes(input.reserveBytes)})`);
  return lines.join('\n');
}

function catalogueLine(meta: CatalogMeta | null): string {
  if (!meta) {
    return 'Catalogue: not built yet';
  }
  const source = meta.source === 'database' ? 'launcher database' : meta.source === 'api' ? 'tag scan' : '';
  return `Catalogue: ${formatCount(meta.games)} games · ${formatCount(meta.packs)} packs`
    + (source ? ` · ${source}` : '')
    + ` · built ${new Date(meta.scannedAt).toLocaleString()}`;
}

function jobLine(input: StatusCardInput): string {
  const job = input.job;
  if (!job) {
    return 'Job: none saved';
  }
  if (job.status === 'error') {
    return `Job: error · ${truncate(input.message || job.message || 'unknown error', 120)}`;
  }
  const parts = [job.mode, `${formatCount(job.gamesDone)} games`, `${formatCount(job.packsDone)} packs`];
  if (job.bytes > 0) {
    parts.push(formatBytes(job.bytes));
  }
  if (job.packsFailed > 0 || job.gamesFailed > 0) {
    parts.push(`${formatCount(job.packsFailed)} failed`);
  }
  if (input.retryPending > 0) {
    parts.push(`${formatCount(input.retryPending)} waiting to retry`);
  }
  return `Job: ${job.status} · ${parts.join(' · ')}`;
}

function statusWord(status: JobStatus): string {
  switch (status) {
    case 'running': return 'downloading';
    case 'paused': return 'paused';
    case 'stopped': return 'stopped';
    case 'done': return 'finished';
    case 'error': return 'error';
    default: return 'idle';
  }
}

function clamp01(value: number): number {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
}

function truncate(text: string, max: number): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

/** Everything catalogue-related, one level down from the card. */
async function catalogueMenu(ctx: ContinuumContext): Promise<void> {
  for (;;) {
    const meta = await ctx.catalog.loadMeta();
    const report = await readRebuildReport(ctx);
    const index = await ctx.fp.dialogs.showMessageBox({
      message: buildCatalogueMessage(meta, report, describeCatalogSource(ctx)),
      buttons: ['Rebuild catalogue', 'Clean up old game files', 'Back'],
      cancelId: 2,
      largeMessage: true,
      userCanCancel: true,
    });
    if (index === 0) {
      await rebuildCatalogueFlow(ctx);
    } else if (index === 1) {
      await cleanupFlow(ctx);
    } else {
      return;
    }
  }
}

export function buildCatalogueMessage(
  meta: CatalogMeta | null,
  report: RebuildReportState | null,
  sourceLine: string,
): string {
  const lines = ['Catalogue'];
  if (!meta) {
    lines.push('Not built yet.');
    lines.push('', sourceLine);
    return lines.join('\n');
  }
  const source = meta.source === 'database' ? 'the launcher database' : meta.source === 'api' ? 'the tag scan' : 'an unknown source';
  lines.push(`${formatCount(meta.games)} games · ${formatCount(meta.packs)} packs · `
    + `${formatCount(meta.packsMissing)} packs missing (${formatBytes(meta.bytesMissing)})`);
  lines.push(`Built ${new Date(meta.scannedAt).toLocaleString()} from ${source}.`);
  if (!report) {
    lines.push('No rebuild comparison has been saved yet.');
  } else if (!report.summary) {
    lines.push('The last rebuild had no previous catalogue to compare with.');
  } else {
    lines.push('', `Last change: ${truncate(report.summary, 400)}`);
  }
  lines.push('', sourceLine);
  return lines.join('\n');
}

async function readRebuildReport(ctx: ContinuumContext): Promise<RebuildReportState | null> {
  const report = await readJson<RebuildReportState>(ctx.paths.rebuildReportFile);
  if (!report || report.version !== 1 || typeof report.summary !== 'string') {
    return null;
  }
  return report;
}

/** What each setting does; the values are edited on the launcher's config page. */
async function settingsMenu(ctx: ContinuumContext): Promise<void> {
  const fastBuild = catalogSource(ctx.readFastCatalogue(), ctx.fastCatalog !== null) === 'database'
    ? 'on'
    : ctx.fastCatalog === null ? 'unavailable (no sqlite3 tool found)' : 'off';
  for (;;) {
    const index = await ctx.fp.dialogs.showMessageBox({
      message: buildSettingsMessage(ctx.readSettings(ctx.readMode()), { fastBuild }),
      buttons: ['Reset saved progress', 'Back'],
      cancelId: 1,
      largeMessage: true,
      userCanCancel: true,
    });
    if (index === 0) {
      await resetFlow(ctx);
      continue;
    }
    return;
  }
}

export interface SettingsMessageOptions {
  /** 'on', 'off' or 'unavailable (...)'. */
  fastBuild?: string;
}

export function buildSettingsMessage(settings: Settings, options: SettingsMessageOptions = {}): string {
  return [
    'Settings',
    'Values live on the launcher\'s Config → Continuum - Offline Mirror page; this dialog cannot change them.',
    '',
    `Mode: ${settings.mode} — what Start uses (passive is one worker with pauses, active uses the configured workers at full speed).`,
    `Scope: ${describeScope(settings.scope)} — which part of the archive is mirrored.`,
    settings.respectFlashpointSettings
      ? 'Logos and screenshots: follow the launcher\'s image caching setting — turn it off there to skip images.'
      : 'Logos and screenshots: cached — launcher settings are ignored, so images download even if its image caching is off.',
    `Launcher settings: ${settings.respectFlashpointSettings ? 'followed' : 'ignored'} — extreme rating, image format and image caching.`,
    `Fast catalogue build: ${options.fastBuild || 'not checked'} — read the launcher database directly instead of every tag.`,
    'SQLite Tool Path: optional path to sqlite3, used by the fast build when none is found automatically.',
    `Keep free space: ${formatBytes(settings.reserveBytes)} — pause before the drive drops below it.`,
    `Download limit: ${settings.maxBytes > 0 ? formatBytes(settings.maxBytes) : 'none'} — stop after this much in one job.`,
    `Workers: ${settings.activeWorkers} active, ${settings.passiveWorkers} passive — parallel games.`,
    `Playlist games first: ${settings.prioritizePlaylists ? 'on' : 'off'} — pull playlist games to the front.`,
    `Automatic: ${settings.autoMirror ? 'on' : 'off'} — resume on startup, rebuild when the launcher database changes, download only what changed.`,
    '',
    'Reset saved progress forgets the saved cursor. Files on disk are kept and skipped.',
  ].join('\n');
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
  if (ctx.activity.snapshot().running) {
    // The catalogue is being replaced; a job prepared now would read a file
    // that is about to be renamed over.
    await info(ctx, 'A catalogue rebuild is running. Start again when it finishes.');
    return;
  }

  // A refusal from the archive host is a permission decision, not a transient
  // failure: automatic work stays paused until a person chooses to try again.
  const denial = await readDenial(ctx.paths.deniedFile);
  if (denial) {
    const choice = await ctx.fp.dialogs.showMessageBox({
      message: `The archive host refused Continuum access (HTTP ${denial.status})`
        + `${denial.url ? ` for ${denial.url}` : ''} on ${new Date(denial.at).toLocaleString()}.\n\n`
        + 'That is what a blacklist looks like, so automatic downloads are paused.\n\n'
        + 'Only try again if you believe access should be allowed.',
      buttons: ['Try again', 'Cancel'],
      cancelId: 1,
      largeMessage: true,
    });
    if (choice !== 0) {
      return;
    }
    await clearDenial(ctx.paths.deniedFile);
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

  // A rebuild leaves a list of the games that changed. Offer to handle only
  // those instead of walking (and stat-ing) the whole catalogue again.
  if (prep.changed && !prep.resumable) {
    const changed = prep.changed.entries.length;
    const choice = await ctx.fp.dialogs.showMessageBox({
      message: `${formatCount(changed)} game(s) changed since the last catalogue rebuild.\n\n`
        + 'Download only those, or check everything missing in the scope again?',
      buttons: ['Changed games only', 'Everything missing', 'Cancel'],
      cancelId: 2,
      largeMessage: true,
    });
    if (choice === 2 || choice < 0) {
      return;
    }
    if (choice === 0) {
      try {
        prep = await ctx.engine.prepare(settings, { changedOnly: true });
      } catch (error) {
        await info(ctx, `Could not prepare the changed-only job:\n\n${error instanceof Error ? error.message : String(error)}`);
        return;
      }
      if (!prep.changedOnly) {
        await info(ctx, 'The changed list is no longer available, so this is a full pass.');
      }
    }
  }

  if (prep.estimate.gamesInScope === 0) {
    await info(ctx, `Nothing matches the current scope (${describeScope(settings.scope)}). Check the scope settings.`);
    return;
  }
  if (prep.estimate.totalBytes === 0) {
    await info(ctx, 'Everything in this scope is already on disk.');
    return;
  }

  // A saved job was confirmed when it was first started, so resuming does not
  // ask about the estimate and disk space again.
  if (!prep.resumable) {
    const tooBig = prep.fits === false;
    const choice = await ctx.fp.dialogs.showMessageBox({
      message: buildStartMessage(prep),
      buttons: tooBig ? ['Start anyway', 'Cancel'] : ['Start', 'Cancel'],
      cancelId: 1,
      largeMessage: true,
    });
    if (choice !== 0) {
      return;
    }
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
    ...(settings.prioritizePlaylists ? ['Playlist priority: on (playlist games are downloaded first)'] : []),
    `Data packs to download: ${formatCount(estimate.packsMissing)} (${formatBytes(estimate.packBytes)})`,
  ];
  if (settings.includeImages) {
    lines.push(`Logos and screenshots: up to ${formatBytes(estimate.imageEstimateBytes)} (estimated)`);
  }
  if (settings.respectFlashpointSettings) {
    lines.push('Launcher settings: followed (extreme rating, image format, image caching)');
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
    return 'Fast build: unavailable, because no working sqlite3 tool was found in the Flashpoint folder or on PATH. '
      + 'Install one and set "SQLite Tool Path", or the rebuild reads every tag instead, which can take hours.';
  }
  return 'Fast build: switched off in the settings. The rebuild reads every tag instead, which can take hours.';
}

export interface ScanCatalogueOptions {
  /** Log instead of showing dialogs; used by the automatic tasks. */
  quiet?: boolean;
}

export async function scanCatalogue(
  ctx: ContinuumContext,
  options: ScanCatalogueOptions = {},
): Promise<CatalogMeta | null> {
  if (ctx.engine.isRunning()) {
    await note(ctx, options.quiet, 'Pause or stop the current download before rebuilding the catalogue.');
    return null;
  }
  if (ctx.activity.snapshot().running) {
    // The automatic check can fire while a manual rebuild is going; two scans
    // writing the same temp file would be a mess.
    await note(ctx, options.quiet, 'A catalogue rebuild is already running. Wait for it to finish.');
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
        await note(ctx, options.quiet, `Reading the launcher database did not work:\n\n${message}\n\n`
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
    // Let the automatic tasks see that this database has been read, so they do
    // not rebuild it again until the launcher changes it.
    await rememberDatabase(ctx);
    return meta;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.activity.fail(message);
    ctx.fp.status.setTask({ id: task.id, status: 'Failed', finished: true, error: message });
    await note(ctx, options.quiet, `Catalogue rebuild failed:\n\n${message}`);
    return null;
  }
}

/** Record the launcher database the catalogue was just built from. */
export async function rememberDatabase(ctx: ContinuumContext): Promise<void> {
  try {
    await writeAutoState(
      ctx.paths.databaseStateFile,
      await currentDatabaseSignature(ctx.paths.databaseFile),
      ctx.fp.dataVersion,
    );
  } catch (error) {
    ctx.log.warn(`Could not record the launcher database state: ${errorMessage(error)}`);
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

export async function rebuildCatalogueFlow(ctx: ContinuumContext): Promise<void> {
  if (ctx.engine.isRunning()) {
    await info(ctx, 'Pause or stop the current download before rebuilding the catalogue.');
    return;
  }
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
    const report = await reportCatalogueRebuild(ctx, meta);
    await info(ctx, `Catalogue rebuilt: ${formatCount(meta.games)} games and ${formatCount(meta.packs)} data packs.\n\n`
      + `${formatCount(meta.packsMissing)} packs are missing (${formatBytes(meta.bytesMissing)}).`
      + (meta.source === 'database' ? '\n\nRead directly from the launcher database.' : '')
      + (report.summary ? `\n\n${report.summary}` : '')
      + (report.note ? `\n${report.note}` : ''));
  }
}

export interface RebuildReport {
  /** Diff text for the dialog, or an empty string when there was no diff. */
  summary: string;
  /** The sentence about the changed list, if the diff produced one. */
  note: string;
  /** Games written to `state/changed.json`. */
  changed: number;
  /** True when the change set was too large for a changed-only pass. */
  tooMany: boolean;
  /** Games the diff found changed, whether or not a list was written. */
  changedTotal: number;
}

/**
 * Compare the new catalogue with the previous one and leave the changed games
 * for a changed-only pass. Shared by the manager dialog and the automatic
 * tasks, so both report and save the same thing.
 */
export async function reportCatalogueRebuild(
  ctx: ContinuumContext,
  meta: CatalogMeta,
): Promise<RebuildReport> {
  const report: RebuildReport = { summary: '', note: '', changed: 0, tooMany: false, changedTotal: 0 };
  const diff = await readDiff(ctx);
  if (!diff) {
    return report;
  }
  report.summary = describeDiff(diff);
  if (report.summary) {
    ctx.log.info(report.summary.replace(/\n/g, ' '));
  }
  report.changedTotal = diff.changed.length;
  try {
    const written = await writeChangedList(ctx.paths.changedFile, meta.generation, diff);
    report.changed = written.written;
    report.tooMany = written.tooMany;
    if (written.written > 0) {
      report.note = `${formatCount(written.written)} game(s) changed; Start can download only those.`;
    } else if (written.tooMany) {
      report.note = `${formatCount(diff.changed.length)} games changed, too many for an incremental pass; `
        + 'Start will do a full one.';
    }
  } catch (error) {
    ctx.log.warn(`Could not save the list of changed games: ${errorMessage(error)}`);
  }
  await saveRebuildReport(ctx, meta, report);
  return report;
}

/** Remember the comparison so the Catalogue dialog can show it without a diff. */
async function saveRebuildReport(
  ctx: ContinuumContext,
  meta: CatalogMeta,
  report: RebuildReport,
): Promise<void> {
  const state: RebuildReportState = {
    version: 1,
    generation: meta.generation,
    updatedAt: new Date().toISOString(),
    summary: report.summary,
    changed: report.changed,
  };
  try {
    await writeJsonAtomic(ctx.paths.rebuildReportFile, state);
  } catch (error) {
    ctx.log.warn(`Could not save the rebuild summary: ${errorMessage(error)}`);
  }
}

/**
 * Compare the new catalogue with the one the rebuild replaced. Only ever
 * informational: a failure costs the report, not the rebuild.
 */
async function readDiff(ctx: ContinuumContext): Promise<CatalogueDiff | null> {
  const task = ctx.fp.status.newTask({
    name: 'Continuum catalogue',
    status: 'Comparing with the previous catalogue...',
    progress: 0,
    finished: false,
  });
  try {
    return await diffCatalogues(previousCatalogPath(ctx.paths.catalogFile), ctx.paths.catalogFile);
  } catch (error) {
    ctx.log.warn(`Could not compare the new catalogue with the previous one: ${errorMessage(error)}`);
    return null;
  } finally {
    ctx.fp.status.setTask({ id: task.id, status: 'Comparison done', progress: 1, finished: true });
  }
}

/** The files the chosen cleanup button deletes; never a name the scan did not list. */
export function packsToDelete(scan: OrphanScan, choice: number): OrphanPack[] {
  const hasRemoved = scan.items.length > 0;
  const hasSuperseded = scan.supersededItems.length > 0;
  if (hasRemoved && hasSuperseded && choice === 1) {
    return [...scan.items, ...scan.supersededItems];
  }
  return hasRemoved ? scan.items : scan.supersededItems;
}

export function buildCleanupMessage(scan: OrphanScan): string {
  const lines = [
    'Old game files',
    '',
    'Files in the data-packs folder that the current catalogue does not use. They are older than 24 hours, '
      + 'so a download still in progress is not one of them.',
    '',
    `Games no longer in Flashpoint: ${formatCount(scan.items.length)} file(s) · ${formatBytes(scan.bytes)}`,
  ];
  if (scan.supersededItems.length > 0) {
    lines.push(`Older versions of games that still exist: ${formatCount(scan.supersededItems.length)} file(s) · ${formatBytes(scan.supersededBytes)}`);
    lines.push('Use the second option to include those; the current version of each game is a different file.');
  }
  if (scan.tooNew > 0) {
    lines.push('', `${formatCount(scan.tooNew)} unreferenced file(s) are less than 24 hours old and will be left alone.`);
  }
  if (scan.items.length === 0 && scan.supersededItems.length > 0) {
    lines.push('', 'No removed game has files left behind.');
  }
  lines.push('', 'Only the files listed above are removed; nothing in the launcher database is changed.');
  return lines.join('\n');
}

/**
 * Find and, after an explicit choice, delete pack files that no game references
 * any more. Never runs as part of a download or a rebuild.
 */
export async function cleanupFlow(ctx: ContinuumContext): Promise<void> {
  if (ctx.engine.isRunning()) {
    await info(ctx, 'Pause or stop the current download before cleaning up old files.');
    return;
  }
  if (!(await ctx.catalog.loadMeta())) {
    await info(ctx, 'Build the catalogue first; it is what tells Continuum which files are still used.');
    return;
  }

  const task = ctx.fp.status.newTask({
    name: 'Continuum cleanup',
    status: 'Checking the data-packs folder...',
    progress: 0,
    finished: false,
  });

  let scan: OrphanScan;
  try {
    scan = await scanOrphanPacks({
      dataPacksDir: ctx.paths.dataPacksDir,
      catalogFile: ctx.paths.catalogFile,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.fp.status.setTask({ id: task.id, status: 'Failed', finished: true, error: message });
    await info(ctx, `Could not check the data-packs folder:\n\n${message}`);
    return;
  }
  ctx.fp.status.setTask({ id: task.id, status: 'Done', progress: 1, finished: true });

  if (scan.items.length === 0 && scan.supersededItems.length === 0) {
    const notes = ['No unreferenced game files were found.'];
    if (scan.tooNew > 0) {
      notes.push(`${formatCount(scan.tooNew)} recent file(s) were left alone; they may be downloads in progress.`);
    }
    await info(ctx, notes.join('\n\n'));
    return;
  }

  const hasRemoved = scan.items.length > 0;
  const hasSuperseded = scan.supersededItems.length > 0;
  const both = hasRemoved && hasSuperseded;
  const buttons = both
    ? ['Delete removed-game files', 'Delete everything listed', 'Cancel']
    : ['Delete', 'Cancel'];
  const cancelId = buttons.length - 1;

  const choice = await ctx.fp.dialogs.showMessageBox({
    message: buildCleanupMessage(scan),
    buttons,
    cancelId,
    largeMessage: true,
  });
  if (choice === cancelId || choice < 0) {
    return;
  }

  const chosen = packsToDelete(scan, choice);
  if (chosen.length === 0) {
    await info(ctx, 'Nothing was selected for deletion.');
    return;
  }

  const result = await deletePacks(ctx.paths.dataPacksDir, chosen, { log: ctx.log });
  const lines = [`Deleted ${formatCount(result.deleted)} file(s) · ${formatBytes(result.bytes)}.`];
  if (result.failed.length > 0) {
    lines.push('', `${formatCount(result.failed.length)} file(s) could not be deleted:`);
    for (const failure of result.failed.slice(0, 5)) {
      lines.push(`- ${failure.filename}: ${failure.error}`);
    }
    if (result.failed.length > 5) {
      lines.push(`... and ${formatCount(result.failed.length - 5)} more (see the log).`);
    }
  }
  await info(ctx, lines.join('\n'));
  ctx.log.info(
    `Cleanup: deleted ${result.deleted} file(s) (${result.bytes} bytes); ${result.failed.length} failed.`,
  );
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Dialog for a person, log line for an unattended run. */
async function note(ctx: ContinuumContext, quiet: boolean | undefined, message: string): Promise<void> {
  if (quiet) {
    ctx.log.warn(message.replace(/\n+/g, ' '));
    return;
  }
  await info(ctx, message);
}

async function info(ctx: ContinuumContext, message: string): Promise<void> {
  try {
    await ctx.fp.dialogs.showMessageBox({ message, buttons: ['OK'], largeMessage: message.length > 260 });
  } catch (error) {
    ctx.log.warn(`Could not show dialog: ${error instanceof Error ? error.message : String(error)}`);
  }
}
